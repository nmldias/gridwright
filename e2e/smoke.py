"""End-to-end smoke test for Gridwright using Playwright (Chromium).

Usage: python3 e2e/smoke.py [base_url] [--python]
Exercises: page load, WebGL canvas, cell editing, formulas, Numbers-style
table resize via the corner handle, JS code cell with spill, optional Python
cell (needs network access to the Pyodide CDN), save/open round trip.
"""

import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "http://localhost:8787"
WITH_PY = "--python" in sys.argv
OUT = os.environ.get("E2E_OUT", "/tmp/gridwright-e2e")
os.makedirs(OUT, exist_ok=True)

TITLE_H = 22
TAB_SIZE = 18


def main():
    results = []

    def check(name, ok, detail=""):
        results.append((name, ok, detail))
        print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))

    with sync_playwright() as p:
        args = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
        proxy = os.environ.get("HTTPS_PROXY")
        if proxy and WITH_PY:
            # route only non-local traffic (the Pyodide CDN) through the egress proxy
            host = proxy.replace("http://", "").replace("https://", "")
            pac = f'function FindProxyForURL(u, h) {{ if (h == "localhost" || h == "127.0.0.1" || isPlainHostName(h)) return "DIRECT"; return "PROXY {host}"; }}'
            import base64
            args.append("--proxy-pac-url=data:application/x-ns-proxy-autoconfig;base64," + base64.b64encode(pac.encode()).decode())
        browser = p.chromium.launch(headless=True, args=args)
        ctx = browser.new_context(viewport={"width": 1400, "height": 900}, ignore_https_errors=True)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e) + " @ " + (getattr(e, "stack", "") or "")[:600].replace("\n", " | ")))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_selector(".canvas-host canvas", timeout=30000)
        time.sleep(0.8)
        page.screenshot(path=f"{OUT}/01-loaded.png")
        check("page loads with canvas", True)

        # helpers -------------------------------------------------------------
        def state():
            return page.evaluate("() => { const s = window.__gw.getState(); const t = [...s.tables.values()][0]; return { tables: [...s.tables.values()].map(x => ({id:x.id,name:x.name,x:x.x,y:x.y,rows:x.rows,cols:x.cols,cw:x.col_widths,rh:x.row_heights})), first: t && t.id, selection: s.selection }; }")

        def cell_value(table, r, c):
            return page.evaluate("([t,r,c]) => { const s = window.__gw.getState(); const cell = s.cells.get(t)?.get(r*65536+c); return cell ? { i: cell.i, v: cell.v, k: cell.k, s: cell.s, ss: cell.ss, err: cell.err } : null; }", [table, r, c])

        def canvas_box():
            return page.eval_on_selector(".canvas-host", "el => { const b = el.getBoundingClientRect(); return {x:b.x,y:b.y,w:b.width,h:b.height}; }")

        def viewport():
            return page.evaluate("() => window.__gw.viewport()")

        def cell_screen(table, r, c):
            """Screen coords of the centre of a cell."""
            st = state()
            t = next(x for x in st["tables"] if x["id"] == table)
            vp = viewport()
            box = canvas_box()
            x = t["x"] + sum(t["cw"][:c]) + t["cw"][c] / 2
            y = t["y"] + sum(t["rh"][:r]) + t["rh"][r] / 2
            return box["x"] + x * vp["zoom"] + vp["x"], box["y"] + y * vp["zoom"] + vp["y"]

        def table_corner_handle(table):
            st = state()
            t = next(x for x in st["tables"] if x["id"] == table)
            vp = viewport()
            box = canvas_box()
            w = sum(t["cw"])
            h = sum(t["rh"])
            x = t["x"] + w + 6 + 6
            y = t["y"] + h + 6 + 6
            return box["x"] + x * vp["zoom"] + vp["x"], box["y"] + y * vp["zoom"] + vp["y"], t

        st = state()
        first = st["first"]
        check("sample table present", first is not None and st["tables"][0]["rows"] >= 6, json.dumps(st["tables"][0])[:120])
        v = cell_value(first, 5, 3)
        check("sample formula =SUM(D2:D5) evaluated", v is not None and "n" in (v["v"] or {}) and abs(v["v"]["n"] - (120 * 9.5 + 80 * 11 + 150 * 8.75 + 60 * 12.25)) < 1e-6, str(v))

        # --- type into a cell -------------------------------------------------
        x, y = cell_screen(first, 7, 0)
        page.mouse.click(x, y)
        page.keyboard.type("Hello")
        page.keyboard.press("Enter")
        time.sleep(0.2)
        v = cell_value(first, 7, 0)
        check("typing writes a text cell", v is not None and v["v"] == {"s": "Hello"}, str(v))
        # Enter moved down → type a number
        page.keyboard.type("42")
        page.keyboard.press("Tab")
        time.sleep(0.2)
        v = cell_value(first, 8, 0)
        check("number cell parsed", v is not None and v["v"] == {"n": 42}, str(v))
        page.keyboard.type("=A9*2+LEN(A8)")
        page.keyboard.press("Enter")
        time.sleep(0.2)
        v = cell_value(first, 8, 1)
        check("formula cell computes", v is not None and v["v"] == {"n": 89}, str(v))
        # change precedent → dependent updates
        x, y = cell_screen(first, 8, 0)
        page.mouse.click(x, y)
        page.keyboard.type("10")
        page.keyboard.press("Enter")
        time.sleep(0.2)
        v = cell_value(first, 8, 1)
        check("dependent recalculates", v is not None and v["v"] == {"n": 25}, str(v))
        # undo
        page.keyboard.press("Control+z")
        time.sleep(0.2)
        v = cell_value(first, 8, 0)
        check("undo restores value", v is not None and v["v"] == {"n": 42}, str(v))
        page.screenshot(path=f"{OUT}/02-edited.png")

        # --- select the table and resize with the corner handle -----------------
        st = state()
        t0 = st["tables"][0]
        vp = viewport()
        box = canvas_box()
        # click title bar to select the table
        tx = box["x"] + (t0["x"] + 30) * vp["zoom"] + vp["x"]
        ty = box["y"] + (t0["y"] - TITLE_H / 2) * vp["zoom"] + vp["y"]
        page.mouse.click(tx, ty)
        time.sleep(0.2)
        sel_table = page.evaluate("() => window.__gw.getState().selectedTable")
        check("clicking the title selects the table", sel_table == first, str(sel_table))
        hx, hy, t = table_corner_handle(first)
        page.mouse.move(hx, hy)
        page.mouse.down()
        page.mouse.move(hx + 2 * 100 * vp["zoom"], hy + 3 * 24 * vp["zoom"], steps=8)
        time.sleep(0.1)
        page.mouse.up()
        time.sleep(0.3)
        st2 = state()
        t2 = st2["tables"][0]
        check("corner handle adds rows and columns", t2["rows"] == t["rows"] + 3 and t2["cols"] == t["cols"] + 2, f"{t['rows']}x{t['cols']} -> {t2['rows']}x{t2['cols']}")
        page.screenshot(path=f"{OUT}/03-resized.png")
        # shrink back with the handle
        hx, hy, t = table_corner_handle(first)
        page.mouse.move(hx, hy)
        page.mouse.down()
        page.mouse.move(hx - 2 * 100 * vp["zoom"] - 10, hy - 3 * 24 * vp["zoom"] - 10, steps=8)
        page.mouse.up()
        time.sleep(0.3)
        t3 = state()["tables"][0]
        check("corner handle removes rows and columns", t3["rows"] == t["rows"] - 3 and t3["cols"] == t["cols"] - 2, f"{t['rows']}x{t['cols']} -> {t3['rows']}x{t3['cols']}")

        # --- column resize by dragging the header boundary ----------------------
        st = state()
        t = st["tables"][0]
        vp = viewport()
        box = canvas_box()
        bx = box["x"] + (t["x"] + t["cw"][0]) * vp["zoom"] + vp["x"]
        by = box["y"] + (t["y"] + t["rh"][0] / 2) * vp["zoom"] + vp["y"]
        page.mouse.move(bx, by)
        page.mouse.down()
        page.mouse.move(bx + 40, by, steps=5)
        page.mouse.up()
        time.sleep(0.3)
        t4 = state()["tables"][0]
        check("column boundary drag resizes the column", abs(t4["cw"][0] - (t["cw"][0] + 40)) < 2, f"{t['cw'][0]} -> {t4['cw'][0]}")

        # --- move the table by its title bar --------------------------------------
        st = state()
        t = st["tables"][0]
        selected = page.evaluate("() => window.__gw.getState().selectedTable") == first
        tx = box["x"] + (t["x"] + 30) * vp["zoom"] + vp["x"]
        ty = box["y"] + (t["y"] - (TAB_SIZE if selected else 0) - TITLE_H / 2) * vp["zoom"] + vp["y"]
        page.mouse.move(tx, ty)
        page.mouse.down()
        page.mouse.move(tx + 160, ty + 48, steps=6)
        page.mouse.up()
        time.sleep(0.3)
        t5 = state()["tables"][0]
        check("dragging the title moves the table", abs(t5["x"] - (t["x"] + 160)) <= 8 and abs(t5["y"] - (t["y"] + 48)) <= 8, f"({t['x']},{t['y']}) -> ({t5['x']},{t5['y']})")

        # --- fill handle: numeric series ---------------------------------------------
        x, y = cell_screen(first, 12, 0)
        page.mouse.click(x, y)
        page.keyboard.type("1")
        page.keyboard.press("Enter")
        page.keyboard.type("3")
        page.keyboard.press("Enter")
        time.sleep(0.2)
        x0, y0 = cell_screen(first, 12, 0)
        page.mouse.click(x0, y0)
        page.keyboard.down("Shift")
        page.mouse.click(*cell_screen(first, 13, 0))
        page.keyboard.up("Shift")
        time.sleep(0.2)
        st = state()
        t = st["tables"][0]
        vp = viewport()
        box = canvas_box()
        fx = box["x"] + (t["x"] + t["cw"][0]) * vp["zoom"] + vp["x"]
        fy = box["y"] + (t["y"] + sum(t["rh"][:14])) * vp["zoom"] + vp["y"]
        page.mouse.move(fx, fy)
        page.mouse.down()
        page.mouse.move(fx, fy + 3 * 24 * vp["zoom"] + 4, steps=6)
        page.mouse.up()
        time.sleep(0.3)
        series = [cell_value(first, r, 0) for r in (14, 15, 16)]
        check("fill handle extends a numeric series", all(v and v["v"] == {"n": n} for v, n in zip(series, (5, 7, 9))), str(series))

        # --- context menu: insert a row ------------------------------------------------
        rows_before = state()["tables"][0]["rows"]
        x, y = cell_screen(first, 3, 1)
        page.mouse.click(x, y, button="right")
        page.wait_for_selector(".context-menu", timeout=3000)
        page.click(".context-menu >> text=Insert 1 row below")
        time.sleep(0.3)
        st = state()
        v = cell_value(first, 5, 0)  # "West" moved down one row; formula in D6 rewritten
        d7 = cell_value(first, 6, 3)
        check("context menu inserts a row and rewrites formulas", st["tables"][0]["rows"] == rows_before + 1 and v is not None and v["v"] == {"s": "West"} and d7 is not None and d7["i"] == "=SUM(D2:D6)", f"rows {st['tables'][0]['rows']} {v} {d7}")
        page.keyboard.press("Control+z")
        time.sleep(0.3)
        check("undo removes the inserted row", state()["tables"][0]["rows"] == rows_before)

        # --- JavaScript code cell with spill ----------------------------------------
        x, y = cell_screen(first, 1, 5)
        page.mouse.click(x, y)
        page.click("button:has-text('JS')")
        page.wait_for_selector(".cm-editor", timeout=5000)
        page.evaluate("() => { const v = document.querySelector('.cm-content'); v.focus(); }")
        page.keyboard.press("Control+a")
        page.keyboard.type("const units = q.cells('B2:B5');\nreturn units.map((u, i) => [i + 1, u * 2]);")
        page.keyboard.press("Control+Enter")
        deadline = time.time() + 10
        v = None
        while time.time() < deadline:
            v = cell_value(first, 1, 5)
            if v and v.get("ss"):
                break
            time.sleep(0.2)
        check("JavaScript cell spills a 4x2 result", v is not None and v.get("ss") == [4, 2] and cell_value(first, 4, 6)["v"] == {"n": 120}, str(v))
        # dependency: change B2 → JS reruns
        x, y = cell_screen(first, 1, 1)
        page.mouse.click(x, y)
        page.keyboard.type("200")
        page.keyboard.press("Enter")
        deadline = time.time() + 10
        ok = False
        while time.time() < deadline:
            vv = cell_value(first, 1, 6)
            if vv and vv["v"] == {"n": 400}:
                ok = True
                break
            time.sleep(0.2)
        check("JavaScript cell re-runs when its input changes", ok, str(cell_value(first, 1, 6)))
        page.screenshot(path=f"{OUT}/04-jscell.png")

        # --- Python cell (optional, needs CDN) -------------------------------------------
        if WITH_PY:
            x, y = cell_screen(first, 7, 2)
            page.mouse.click(x, y)
            page.click("button:has-text('Py')")
            page.wait_for_selector(".cm-editor", timeout=5000)
            page.evaluate("() => { const v = document.querySelector('.cm-content'); v.focus(); }")
            page.keyboard.press("Control+a")
            page.keyboard.type("import pandas as pd\ndf = q.df('A1:D5')\ndf['Double'] = df['Units'] * 2\ndf[['Region', 'Double']]")
            page.keyboard.press("Control+Enter")
            deadline = time.time() + 180
            v = None
            while time.time() < deadline:
                v = cell_value(first, 7, 2)
                if v and (v.get("ss") or v.get("err")):
                    break
                time.sleep(0.5)
            check("Python cell (pandas) spills a DataFrame", v is not None and v.get("ss") == [5, 2] and cell_value(first, 8, 3)["v"] == {"n": 400}, str(v)[:300])
            page.screenshot(path=f"{OUT}/05-python.png")

        # --- save & reopen ----------------------------------------------------------------
        page.click("button[title='Save (Ctrl+S)']")
        time.sleep(0.8)
        file_id = page.evaluate("() => window.__gw.getState().fileId")
        check("save creates a document", bool(file_id), str(file_id))
        page.goto(f"{BASE}/?file={file_id}", wait_until="networkidle")
        page.wait_for_selector(".canvas-host canvas", timeout=30000)
        time.sleep(1.0)
        st = state()
        v = cell_value(st["first"], 7, 0)
        check("reopened document keeps data", v is not None and v["v"] == {"s": "Hello"}, str(v))
        page.screenshot(path=f"{OUT}/06-reopened.png")

        real_errors = [e for e in errors if "favicon" not in e and "WebGL" not in e]
        check("no page errors", len(real_errors) == 0, "; ".join(real_errors)[:500])
        browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed; screenshots in {OUT}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

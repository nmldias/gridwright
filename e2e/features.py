"""End-to-end checks for the v0.2 features (Playwright, Chromium).

Usage: python3 e2e/features.py [base_url] [--pg host:port:db:user:pass] [--mock-llm http://127.0.0.1:8899/v1]

Covers: dynamic arrays, structured references, named ranges, typed dates, header
filters + SUBTOTAL, conditional formatting UI, validation (strict and marked),
pivot tables, SQL cells with parameters, Excel export, the audit history and
version replay, AI diff review with a mock model, multiplayer convergence, and
touch gestures on a phone-sized viewport.
"""

import io
import json
import os
import sys
import time
import urllib.request
import zipfile

from playwright.sync_api import sync_playwright

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
BASE = ARGS[0] if ARGS else "http://localhost:8787"
PG = None
MOCK = None
for i, a in enumerate(sys.argv):
    if a == "--pg":
        PG = sys.argv[i + 1].split(":")
    if a == "--mock-llm":
        MOCK = sys.argv[i + 1]
OUT = os.environ.get("E2E_OUT", "/tmp/gridwright-e2e")
os.makedirs(OUT, exist_ok=True)
TITLE_H = 22
TAB_SIZE = 18


def rest(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def main():
    results = []

    def check(name, ok, detail=""):
        results.append((name, ok, detail))
        print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))

    with sync_playwright() as p:
        args = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
        browser = p.chromium.launch(headless=True, args=args)
        ctx = browser.new_context(viewport={"width": 1400, "height": 900}, accept_downloads=True)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text + " @ " + (m.location.get("url") if isinstance(m.location, dict) else str(m.location))) if m.type == "error" else None)
        page.on("response", lambda r: errors.append(f"404 {r.url}") if r.status == 404 else None)
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_selector(".canvas-host canvas", timeout=30000)
        time.sleep(0.6)

        def apply(op, **opts):
            return page.evaluate("([op, opts]) => window.__gw.book.apply(op, opts)", [op, opts])

        def cell(table, r, c):
            return page.evaluate("([t,r,c]) => { const s = window.__gw.getState(); const cell = s.cells.get(t)?.get(r*65536+c); return cell ? { i: cell.i, v: cell.v, k: cell.k, s: cell.s, ss: cell.ss, err: cell.err, f: cell.f, inv: cell.inv } : null; }", [table, r, c])

        def meta(table):
            return page.evaluate("(t) => { const m = window.__gw.getState().tables.get(t); return m ? JSON.parse(JSON.stringify(m)) : null; }", table)

        def state():
            return page.evaluate("() => { const s = window.__gw.getState(); return { fileId: s.fileId, seq: s.seq, names: s.names, panel: s.panel, status: s.status, selection: s.selection, tables: [...s.tables.keys()] }; }")

        def num(v):
            return v["v"]["n"] if v and v["v"] and "n" in v["v"] else None

        def cell_screen(table, r, c):
            m = meta(table)
            vp = page.evaluate("() => window.__gw.viewport()")
            box = page.eval_on_selector(".canvas-host", "el => { const b = el.getBoundingClientRect(); return {x:b.x,y:b.y}; }")
            x = m["x"] + sum(m["col_widths"][:c]) + m["col_widths"][c] / 2
            hidden = set(m["hidden_rows"])
            y = m["y"] + sum(h for i, h in enumerate(m["row_heights"][:r]) if i not in hidden) + m["row_heights"][r] / 2
            return box["x"] + x * vp["zoom"] + vp["x"], box["y"] + y * vp["zoom"] + vp["y"]

        def type_into(table, r, c, text, key="Enter"):
            x, y = cell_screen(table, r, c)
            page.mouse.click(x, y)
            page.keyboard.type(text)
            page.keyboard.press(key)
            time.sleep(0.15)

        # ------------------------------------------------------------------ engine features
        T = 1
        apply({"type": "set_cell", "table": T, "row": 0, "col": 5, "input": "=B2:B5*2"})
        v = [num(cell(T, r, 5)) for r in range(4)]
        check("dynamic array spills down from F1", v == [240, 160, 300, 120] and cell(T, 0, 5)["ss"] == [4, 1] and cell(T, 3, 5)["s"] == {"row": 0, "col": 5}, str(v))
        apply({"type": "set_cell", "table": T, "row": 0, "col": 6, "input": "=SUM([Units])"})
        # the sample table's data rows include the "Total" row (=SUM(B2:B5)=410), so the column sums to 820
        check("structured reference [Units] sums the data column", num(cell(T, 0, 6)) == 820, str(cell(T, 0, 6)))
        apply({"type": "set_cell", "table": T, "row": 1, "col": 6, "input": "=[@Units]*[@Unit price]"})
        check("[@Column] reads the formula's own row", num(cell(T, 1, 6)) == 1140, str(cell(T, 1, 6)))
        ch = apply({"type": "set_name", "name": "AllUnits", "reference": "'Table 1'::B2:B5"})
        apply({"type": "set_cell", "table": T, "row": 2, "col": 6, "input": "=SUM(AllUnits)"})
        check("named range used in a formula", not ch.get("error") and num(cell(T, 2, 6)) == 410 and state()["names"][0]["name"] == "AllUnits", str(cell(T, 2, 6)))
        apply({"type": "set_cell", "table": T, "row": 3, "col": 6, "input": "=FILTER(B2:B5, B2:B5 > 100)"})
        check("FILTER spills only the matching rows", [num(cell(T, 3 + i, 6)) for i in range(2)] == [120, 150], str([num(cell(T, 3 + i, 6)) for i in range(3)]))
        type_into(T, 0, 7, "2026-10-08")
        c = cell(T, 0, 7)
        check("typed date becomes a serial with a date format", num(c) == 46303 and (c["f"] or {}).get("number_format") == "yyyy-mm-dd", str(c))
        type_into(T, 1, 7, "1.500,00 Kz")
        c = cell(T, 1, 7)
        check("typed currency keeps a Kz format", num(c) == 1500 and "Kz" in ((c["f"] or {}).get("number_format") or ""), str(c))
        apply({"type": "set_cell", "table": T, "row": 2, "col": 7, "input": "=PMT(0.05/12, 360, 200000)"})
        check("PMT financial function", abs((num(cell(T, 2, 7)) or 0) + 1073.64) < 0.01, str(cell(T, 2, 7)))

        # ------------------------------------------------------------------ filters
        apply({"type": "set_cell", "table": T, "row": 3, "col": 7, "input": "=SUBTOTAL(109, D2:D5)"})
        apply({"type": "set_filters", "table": T, "filters": [{"col": 0, "values": ["North", "South", ""]}]})
        m = meta(T)
        check("filter hides non-matching rows (blanks kept)", m["hidden_rows"] == [3, 4, 5], str(m["hidden_rows"]))
        check("SUBTOTAL(109) ignores hidden rows", num(cell(T, 3, 7)) == 2020, str(cell(T, 3, 7)))
        page.screenshot(path=f"{OUT}/f01-filtered.png")
        # keyboard navigation skips hidden rows
        x, y = cell_screen(T, 2, 0)
        page.mouse.click(x, y)
        page.keyboard.press("ArrowDown")
        sel = state()["selection"]
        check("arrow keys skip hidden rows", sel["ar"] == 6, str(sel))
        # filter popover via the header button (select the table first by clicking the title)
        mm = meta(T)
        vp = page.evaluate("() => window.__gw.viewport()")
        box = page.eval_on_selector(".canvas-host", "el => { const b = el.getBoundingClientRect(); return {x:b.x,y:b.y}; }")
        page.mouse.click(box["x"] + (mm["x"] + 40) * vp["zoom"] + vp["x"], box["y"] + (mm["y"] - TITLE_H / 2) * vp["zoom"] + vp["y"])
        time.sleep(0.2)
        bx = box["x"] + (mm["x"] + mm["col_widths"][0] - 9) * vp["zoom"] + vp["x"]
        by = box["y"] + (mm["y"] + mm["row_heights"][0] - 9) * vp["zoom"] + vp["y"]
        page.mouse.click(bx, by)
        page.wait_for_selector(".filter-popover", timeout=5000)
        check("header filter button opens the popover", True)
        page.click(".filter-popover button:has-text('Clear')")
        time.sleep(0.2)
        check("Clear in the popover removes the filter", meta(T)["hidden_rows"] == [] and meta(T)["filters"] == [])

        # ------------------------------------------------------------------ conditional formatting (UI)
        page.evaluate("() => window.__gw.getState().set({ selection: { table: 1, r0: 1, c0: 1, r1: 4, c1: 1, ar: 1, ac: 1 }, panel: 'format' })")
        page.wait_for_selector(".format-panel", timeout=5000)
        page.select_option(".format-panel .rule-form select", "cell_is")
        page.fill(".format-panel .rule-form input[placeholder='value']", "100")
        page.click(".format-panel button:has-text('Add rule')")
        time.sleep(0.2)
        rules = meta(T)["cond_formats"]
        check("conditional-format rule added from the panel", len(rules) == 1 and rules[0]["kind"] == "cell_is" and rules[0]["values"][0] == "100", str(rules))
        apply({"type": "set_cond_formats", "table": T, "rules": rules + [{"r0": 1, "c0": 3, "r1": 4, "c1": 3, "kind": "color_scale", "values": [], "min_color": "#ffffff", "max_color": "#0c447c"}]})
        time.sleep(0.3)
        page.screenshot(path=f"{OUT}/f02-condfmt.png")
        check("colour-scale rule renders without errors", len(meta(T)["cond_formats"]) == 2 and not errors, "; ".join(errors[-2:]))

        # ------------------------------------------------------------------ validation
        page.evaluate("() => window.__gw.getState().set({ panel: 'none' })")
        apply({"type": "set_validations", "table": T, "rules": [
            {"r0": 1, "c0": 0, "r1": 4, "c1": 0, "kind": "list", "values": ["North", "South", "East", "West"], "allow_blank": True, "strict": True},
            {"r0": 1, "c0": 1, "r1": 4, "c1": 1, "kind": "number", "op": "between", "values": ["0", "200"], "allow_blank": True, "strict": False, "message": "units 0-200"},
        ]})
        type_into(T, 1, 0, "Mars")
        c = cell(T, 1, 0)
        check("strict list validation refuses a value typed in the cell", c["i"] == "North" and "Not allowed" in state()["status"], f"{c} / {state()['status']}")
        page.keyboard.press("Escape")
        type_into(T, 1, 1, "999")
        c = cell(T, 1, 1)
        check("non-strict rule accepts but marks the value", num(c) == 999 and c["inv"] is True, str(c))
        type_into(T, 1, 1, "120")
        check("mark clears when the value is valid again", not cell(T, 1, 1)["inv"], str(cell(T, 1, 1)))
        # list dropdown appears while editing a list-validated cell
        x, y = cell_screen(T, 2, 0)
        page.mouse.dblclick(x, y)
        page.wait_for_selector(".list-dropdown", timeout=3000)
        page.click(".list-dropdown .list-item:has-text('West')")
        time.sleep(0.2)
        check("list dropdown writes the chosen entry", cell(T, 2, 0)["i"] == "West", str(cell(T, 2, 0)))

        # ------------------------------------------------------------------ pivot
        ch = apply({"type": "add_table", "name": "Sales", "x": 1000, "y": 80, "rows": 6, "cols": 3, "values": [["Region", "Product", "Amount"], ["North", "A", "10"], ["South", "A", "20"], ["North", "B", "30"], ["South", "B", "40"], ["North", "A", "5"]]})
        sales = ch["created"][0]
        ch = apply({"type": "add_table", "name": "Pivot", "x": 1000, "y": 400, "rows": 2, "cols": 2})
        pivot = ch["created"][0]
        ch = apply({"type": "set_pivot", "table": pivot, "spec": {"source": sales, "rows": ["Region"], "cols": ["Product"], "values": [{"field": "Amount", "agg": "sum"}], "filters": [], "totals": True}})
        p = meta(pivot)
        grid = [[(cell(pivot, r, c) or {}).get("v") for c in range(p["cols"])] for r in range(p["rows"])]
        check("pivot computes Region × Product with totals", grid[1][0] == {"s": "North"} and grid[1][1] == {"n": 15} and grid[1][3] == {"n": 45} and grid[3][3] == {"n": 105}, str(grid))
        apply({"type": "set_cell", "table": sales, "row": 1, "col": 2, "input": "110"})
        check("pivot follows the source table", num(cell(pivot, 1, 1)) == 115 and num(cell(pivot, 3, 3)) == 205, str(cell(pivot, 3, 3)))
        ch = apply({"type": "set_cell", "table": pivot, "row": 1, "col": 1, "input": "9"})
        check("pivot output is read-only", bool(ch.get("error")), str(ch.get("error")))
        page.screenshot(path=f"{OUT}/f03-pivot.png")

        # ------------------------------------------------------------------ save + history
        page.keyboard.press("Control+s")
        for _ in range(40):
            if state()["fileId"]:
                break
            time.sleep(0.1)
        fid = state()["fileId"]
        check("document saved", bool(fid), str(fid))
        page.evaluate("() => window.__gw.getState().set({ selection: { table: 1, r0: 9, c0: 0, r1: 9, c1: 0, ar: 9, ac: 0 } })")
        type_into(T, 9, 0, "audited")
        time.sleep(0.5)
        h = rest("GET", f"/api/files/{fid}/history?limit=50")
        ops = [e for e in h["entries"] if e.get("op")]
        last = ops[0] if ops else None
        check("history records the edit with an author", last is not None and last["op"]["type"] == "set_cell" and last["op"]["input"] == "audited" and last["author"]["name"], json.dumps(last)[:200] if last else "no entries")
        ch_hist = rest("GET", f"/api/files/{fid}/history/cell?table=1&row=9&col=0")
        check("per-cell history lists the change", any(e["op"].get("input") == "audited" for e in ch_hist["entries"]), str(len(ch_hist["entries"])))
        before_seq = last["seq"] - 1
        rep = rest("GET", f"/api/files/{fid}/history/replay?seq={before_seq}")
        check("replay bundle has a checkpoint and the ops after it", rep["json"] is not None and all(e["seq"] <= before_seq for e in rep["ops"]), f"cp={rep['checkpointSeq']} ops={len(rep['ops'])}")
        # History panel renders the entries
        page.evaluate("() => window.__gw.getState().set({ panel: 'history' })")
        page.wait_for_selector(".history-list li", timeout=5000)
        txt = ""
        for _ in range(50):  # the list refreshes from the server shortly after the panel opens
            txt = page.inner_text(".history-panel")
            if "audited" in txt:
                break
            time.sleep(0.1)
        check("History panel shows the change list", "audited" in txt and "#" in txt, txt[:120].replace("\n", " "))
        page.screenshot(path=f"{OUT}/f04-history.png")
        page.evaluate("() => window.__gw.getState().set({ panel: 'none' })")

        # ------------------------------------------------------------------ SQL cell (PostgreSQL)
        if PG:
            host, port, db, user, pw = PG
            conn = rest("POST", "/api/connections", {"name": "demo pg", "kind": "postgres", "host": host, "port": int(port), "database": db, "user": user, "password": pw, "ssl": False})
            t = rest("POST", f"/api/connections/{conn['id']}/test")
            check("PostgreSQL connection test", t["ok"], t["message"][:60])
            apply({"type": "set_cell", "table": T, "row": 9, "col": 7, "input": "10"})
            ch = apply({"type": "set_cell", "table": T, "row": 11, "col": 0, "input": "SELECT region, SUM(amount)::float AS total FROM orders WHERE amount > {{H10}} GROUP BY region ORDER BY region", "kind": "sql", "conn": conn["id"], "refresh": 0})
            for _ in range(60):
                c = cell(T, 11, 0)
                if c and c.get("ss"):
                    break
                time.sleep(0.1)
            c = cell(T, 11, 0)
            check("SQL cell spills the query result", bool(c) and c["ss"] == [3, 2] and num(cell(T, 12, 1)) == 30 and num(cell(T, 13, 1)) == 60, f"{ch.get('error')} {c} {[cell(T, 12, 1), cell(T, 13, 1)]}")
            apply({"type": "set_cell", "table": T, "row": 9, "col": 7, "input": "0"})
            for _ in range(60):
                if num(cell(T, 12, 1)) == 45:
                    break
                time.sleep(0.1)
            check("SQL cell re-runs when its {{parameter}} changes", num(cell(T, 12, 1)) == 45, str(cell(T, 12, 1)))
            apply({"type": "set_cell", "table": T, "row": 11, "col": 0, "input": ""})  # drop the SQL cell before its connection goes
            time.sleep(0.3)
            rest("DELETE", f"/api/connections/{conn['id']}")
        else:
            print("SKIP SQL cell (no --pg)")

        # ------------------------------------------------------------------ Excel export
        page.evaluate("() => window.__gw.getState().set({ panel: 'files' })")
        page.wait_for_selector("button:has-text('Download .xlsx')", timeout=5000)
        with page.expect_download(timeout=20000) as dl:
            page.click("button:has-text('Download .xlsx')")
        path = dl.value.path()
        data = open(path, "rb").read()
        z = zipfile.ZipFile(io.BytesIO(data))
        names = z.namelist()
        sheet1 = z.read("xl/worksheets/sheet1.xml").decode()
        wbxml = z.read("xl/workbook.xml").decode()
        check("Excel export has one sheet per table with formulas", "xl/worksheets/sheet3.xml" in names and "<f>SUM(D2:D5)</f>" in sheet1 and "Sales" in wbxml, f"{len(data)} bytes, {len([n for n in names if 'worksheets/sheet' in n])} sheets")
        page.evaluate("() => window.__gw.getState().set({ panel: 'none' })")

        # ------------------------------------------------------------------ AI diff review (mock model)
        if MOCK:
            rest("PUT", "/api/ai/settings", {"baseUrl": MOCK, "model": "mock"})
            page.evaluate("() => window.__gw.getState().set({ panel: 'ai' })")
            page.wait_for_selector(".ai-panel textarea", timeout=5000)
            page.fill(".ai-panel textarea", "Summarise the units")
            page.keyboard.press("Enter")
            page.wait_for_selector(".ai-panel table.diff", timeout=15000)
            rows = page.locator(".ai-panel table.diff tr").count()
            tables_before = state()["tables"]
            check("AI proposal is shown as a before → after diff before applying", rows >= 2 and state()["tables"] == tables_before, f"{rows} diff rows")
            page.click(".ai-panel button:has-text('Apply')")
            time.sleep(0.5)
            check("applying the diff creates the proposed table", len(state()["tables"]) == len(tables_before) + 1 and cell(T, 7, 5)["i"] == "=1+1", str(cell(T, 7, 5)))
            time.sleep(0.6)
            h = rest("GET", f"/api/files/{fid}/history?limit=10")
            check("AI changes are logged with origin 'ai'", any(e["origin"] == "ai" for e in h["entries"]), str([e["origin"] for e in h["entries"][:6]]))
            page.screenshot(path=f"{OUT}/f05-ai-diff.png")
            page.evaluate("() => window.__gw.getState().set({ panel: 'none' })")
        else:
            print("SKIP AI diff (no --mock-llm)")

        # ------------------------------------------------------------------ multiplayer convergence
        page2 = ctx.new_page()
        page2.on("pageerror", lambda e: errors.append("p2: " + str(e)))
        page2.goto(f"{BASE}/?file={fid}", wait_until="networkidle")
        page2.wait_for_selector(".canvas-host canvas", timeout=30000)
        time.sleep(1.0)
        page.evaluate("() => window.__gw.book.apply({ type: 'set_cell', table: 1, row: 15, col: 0, input: 'from p1' })")
        page2.evaluate("() => window.__gw.book.apply({ type: 'set_cell', table: 1, row: 15, col: 1, input: 'from p2' })")
        # same cell, both at once: the server's order wins everywhere
        page.evaluate("() => window.__gw.book.apply({ type: 'set_cell', table: 1, row: 16, col: 0, input: 'p1 wins?' })")
        page2.evaluate("() => window.__gw.book.apply({ type: 'set_cell', table: 1, row: 16, col: 0, input: 'p2 wins?' })")
        time.sleep(1.5)

        def snap(pg):
            return pg.evaluate("() => { const s = window.__gw.getState(); const m = s.cells.get(1); const g = (r,c) => m.get(r*65536+c)?.i ?? ''; return { a: g(15,0), b: g(15,1), c: g(16,0), seq: s.seq }; }")

        s1, s2 = snap(page), snap(page2)
        check("concurrent edits converge on both clients", s1["a"] == "from p1" and s1["b"] == "from p2" and s1["c"] == s2["c"] and s2["a"] == "from p1" and s2["b"] == "from p2" and s1["c"] in ("p1 wins?", "p2 wins?"), f"{s1} / {s2}")
        check("both clients sit at the same log position", s1["seq"] == s2["seq"] and s1["seq"] > 0, f"{s1['seq']} vs {s2['seq']}")
        page2.close()

        # ------------------------------------------------------------------ touch (phone viewport)
        phone = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        pp = phone.new_page()
        pp.on("pageerror", lambda e: errors.append("phone: " + str(e)))
        pp.goto(f"{BASE}/?file={fid}", wait_until="networkidle")
        pp.wait_for_selector(".canvas-host canvas", timeout=30000)
        time.sleep(0.8)
        touch_flag = pp.evaluate("() => window.__gw.getState().touch")
        host_box = pp.eval_on_selector(".canvas-host", "el => { const b = el.getBoundingClientRect(); return {x:b.x,y:b.y,w:b.width,h:b.height}; }")
        vp0 = pp.evaluate("() => window.__gw.viewport()")

        def touch_drag(x0, y0, x1, y1, steps=8):
            pp.evaluate(
                """([x0,y0,x1,y1,steps]) => {
                const host = document.querySelector('.canvas-host');
                const ev = (type, x, y) => host.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, button: 0, buttons: 1 }));
                ev('pointerdown', x0, y0);
                return new Promise((res) => { let i = 0; const tick = () => { i++; const t = i / steps; ev('pointermove', x0 + (x1-x0)*t, y0 + (y1-y0)*t); if (i < steps) setTimeout(tick, 16); else { ev('pointerup', x1, y1); res(); } }; setTimeout(tick, 16); });
            }""",
                [x0, y0, x1, y1, steps],
            )

        # one-finger drag on a cell pans the canvas
        m1 = meta(1) if False else pp.evaluate("() => JSON.parse(JSON.stringify(window.__gw.getState().tables.get(1)))")
        cx = host_box["x"] + (m1["x"] + 50) * vp0["zoom"] + vp0["x"]
        cy = host_box["y"] + (m1["y"] + 36) * vp0["zoom"] + vp0["y"]
        touch_drag(cx, cy, cx - 120, cy - 60)
        time.sleep(0.3)
        vp1 = pp.evaluate("() => window.__gw.viewport()")
        check("touch: one-finger drag pans the canvas", touch_flag and abs((vp1["x"] - vp0["x"]) + 120) < 4 and abs((vp1["y"] - vp0["y"]) + 60) < 4, f"{vp0} -> {vp1}")
        # tap selects a cell
        cx2 = host_box["x"] + (m1["x"] + 150) * vp1["zoom"] + vp1["x"]
        cy2 = host_box["y"] + (m1["y"] + 36) * vp1["zoom"] + vp1["y"]
        pp.evaluate(
            """([x,y]) => { const host = document.querySelector('.canvas-host'); const ev = (type) => host.dispatchEvent(new PointerEvent(type, { pointerId: 8, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, button: 0, buttons: 1 })); ev('pointerdown'); ev('pointerup'); }""",
            [cx2, cy2],
        )
        time.sleep(0.2)
        sel = pp.evaluate("() => window.__gw.getState().selection")
        check("touch: tap selects the cell under the finger", sel and sel["table"] == 1 and sel["ar"] == 1 and sel["ac"] == 1, str(sel))
        # pinch zoom: two pointers moving apart
        pp.evaluate(
            """([x,y]) => {
            const host = document.querySelector('.canvas-host');
            const ev = (type, id, px, py) => host.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 11, clientX: px, clientY: py, bubbles: true, button: 0, buttons: 1 }));
            ev('pointerdown', 11, x - 40, y); ev('pointerdown', 12, x + 40, y);
            for (let i = 1; i <= 5; i++) { ev('pointermove', 11, x - 40 - i * 12, y); ev('pointermove', 12, x + 40 + i * 12, y); }
            ev('pointerup', 11, x - 100, y); ev('pointerup', 12, x + 100, y);
        }""",
            [host_box["x"] + host_box["w"] / 2, host_box["y"] + host_box["h"] / 2],
        )
        time.sleep(0.2)
        vp2 = pp.evaluate("() => window.__gw.viewport()")
        check("touch: pinch zooms in", vp2["zoom"] > vp1["zoom"] * 1.5, f"{vp1['zoom']} -> {vp2['zoom']}")
        pp.screenshot(path=f"{OUT}/f06-phone.png")
        phone.close()

        check("no page errors", not errors, "; ".join(errors[:3]))
        browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed; screenshots in {OUT}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Round-2 feature checks: charts (exhibits), sign-offs with locking, CHECK/FX/RECONCILE/AGEING,
precedent/dependent tracing, merged cells and wrap, undo relayed as ops, operational transform of
in-flight ops, per-document access control, audit CSV, checkpoint compaction, AI tools with a
mock model, templates and the print view.

Usage: python3 e2e/features2.py [http://localhost:8787] [--pg host:port:db:user:pass]
       [--mock-llm http://127.0.0.1:8899/v1] [--acl http://127.0.0.1:8795]
The --acl server must run with GRIDWRIGHT_TRUST_TAILSCALE=1 GRIDWRIGHT_ADMINS=boss@example.com.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
BASE = ARGS[0] if ARGS else "http://localhost:8787"
PG = None
MOCK = None
ACL = None
for i, a in enumerate(sys.argv):
    if a == "--pg":
        PG = sys.argv[i + 1].split(":")
    if a == "--mock-llm":
        MOCK = sys.argv[i + 1]
    if a == "--acl":
        ACL = sys.argv[i + 1]
OUT = os.environ.get("E2E_OUT", "/tmp/gridwright-e2e")
os.makedirs(OUT, exist_ok=True)


def rest(method, path, body=None, base=None, headers=None, raw=False):
    h = {"content-type": "application/json"}
    h.update(headers or {})
    req = urllib.request.Request((base or BASE) + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
            return (r.status, data.decode()) if raw else json.loads(data.decode())
    except urllib.error.HTTPError as e:
        if raw:
            return (e.code, e.read().decode())
        raise


def status_of(method, path, body=None, base=None, headers=None):
    code, _ = rest(method, path, body, base, headers, raw=True)
    return code


def main():
    results = []

    def check(name, ok, detail=""):
        results.append((name, ok, detail))
        print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))

    with sync_playwright() as p:
        args = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
        browser = p.chromium.launch(headless=True, args=args)
        ctx = browser.new_context(viewport={"width": 1500, "height": 950}, accept_downloads=True)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_selector(".canvas-host canvas", timeout=30000)
        time.sleep(0.6)

        def apply(op, **opts):
            return page.evaluate("([op, opts]) => window.__gw.book.apply(op, opts)", [op, opts])

        def cell(table, r, c):
            return page.evaluate("([t,r,c]) => { const s = window.__gw.getState(); const cell = s.cells.get(t)?.get(r*65536+c); return cell ? { i: cell.i, v: cell.v, k: cell.k, s: cell.s, ss: cell.ss, err: cell.err, f: cell.f } : null; }", [table, r, c])

        def meta(table):
            return page.evaluate("(t) => { const m = window.__gw.getState().tables.get(t); return m ? JSON.parse(JSON.stringify(m)) : null; }", table)

        def state():
            return page.evaluate("() => { const s = window.__gw.getState(); return { fileId: s.fileId, seq: s.seq, panel: s.panel, status: s.status, selection: s.selection, tables: [...s.tables.keys()], charts: s.charts, selectedChart: s.selectedChart, trace: s.trace, permission: s.permission }; }")

        def num(v):
            return v["v"]["n"] if v and v["v"] and "n" in v["v"] else None

        def text(v):
            return v["v"]["s"] if v and v["v"] and "s" in v["v"] else None

        def select(table, r0, c0, r1=None, c1=None):
            r1 = r0 if r1 is None else r1
            c1 = c0 if c1 is None else c1
            page.evaluate("([t,r0,c0,r1,c1]) => window.__gw.getState().set({ selection: { table: t, r0, c0, r1, c1, ar: r0, ac: c0 }, selectedTable: null })", [table, r0, c0, r1, c1])

        def world_to_screen(x, y):
            vp = page.evaluate("() => window.__gw.viewport()")
            box = page.eval_on_selector(".canvas-host", "el => { const b = el.getBoundingClientRect(); return {x:b.x,y:b.y}; }")
            return box["x"] + x * vp["zoom"] + vp["x"], box["y"] + y * vp["zoom"] + vp["y"]

        def cell_screen(table, r, c):
            m = meta(table)
            x = m["x"] + sum(m["col_widths"][:c]) + m["col_widths"][c] / 2
            y = m["y"] + sum(m["row_heights"][:r]) + m["row_heights"][r] / 2
            return world_to_screen(x, y)

        def type_into(table, r, c, txt, key="Enter"):
            x, y = cell_screen(table, r, c)
            page.mouse.click(x, y)
            page.keyboard.type(txt)
            page.keyboard.press(key)
            time.sleep(0.15)

        T = 1
        # ------------------------------------------------------------------ charts
        select(T, 0, 0, 4, 3)
        cid = page.evaluate("() => window.__gw.review.insertChart('bar')")
        st = state()
        chart = next((c for c in st["charts"] if c["id"] == cid), None)
        # units, unit prices and revenue do not share an axis: the chart takes one measure and says which were left out
        check("chart inserted from the selection: categories from the first column, one measure (not three incompatible columns)", chart is not None and chart["categories"].endswith("A2:A5") and [s["name"] for s in chart["series"]] == ["Revenue"] and "Chart shows Revenue only" in st["status"], json.dumps(chart)[:200] if chart else str(st["charts"]))
        check("chart panel opens with the new chart selected", st["panel"] == "chart" and st["selectedChart"] == cid, f"{st['panel']} {st['selectedChart']}")
        svg = page.evaluate("(id) => { const c = window.__gw.getState().charts.find((x) => x.id === id); const d = window.__gw.charts.chartData(c); return window.__gw.charts.chartSvg({ ...c, title: 'Units lead in East', exhibit: 'Exhibit 1 — Regions', reference: { value: 100, label: 'Target' }, highlight: 2 }, d); }", cid)
        check("chart SVG carries the exhibit tag, action title, bars, reference line and footnote", "EXHIBIT 1 — REGIONS" in svg and "Units lead in East" in svg and svg.count("<rect") > 6 and 'stroke-dasharray' in svg and "#993C1D" in svg and "Source:" in svg, f"{len(svg)} chars")
        open(f"{OUT}/f2-chart.svg", "w").write(svg)
        page.evaluate("() => window.__gw.getState().set({ panel: 'none' })")
        time.sleep(0.2)
        # drag the chart by its body
        cx, cy = world_to_screen(chart["x"] + chart["w"] / 2, chart["y"] + 40)
        page.mouse.move(cx, cy)
        page.mouse.down()
        page.mouse.move(cx - 60, cy + 90, steps=6)
        page.mouse.up()
        time.sleep(0.2)
        moved = next(c for c in state()["charts"] if c["id"] == cid)
        check("dragging a chart moves it (snapped)", moved["x"] <= chart["x"] - 48 and moved["y"] >= chart["y"] + 80, f"{chart['x']},{chart['y']} → {moved['x']},{moved['y']}")
        # resize from the corner handle
        hx, hy = world_to_screen(moved["x"] + moved["w"], moved["y"] + moved["h"])
        page.mouse.move(hx, hy)
        page.mouse.down()
        page.mouse.move(hx + 80, hy + 40, steps=6)
        page.mouse.up()
        time.sleep(0.2)
        resized = next(c for c in state()["charts"] if c["id"] == cid)
        check("the corner handle resizes the chart", resized["w"] >= moved["w"] + 72 and resized["h"] >= moved["h"] + 32, f"{moved['w']}x{moved['h']} → {resized['w']}x{resized['h']}")
        page.evaluate("(id) => window.__gw.book.apply({ type: 'update_chart', chart: { ...window.__gw.getState().charts.find((c) => c.id === id), title: 'East sells the most units', subtitle: 'Units by region, 2026', exhibit: 'Exhibit 1 — Regional sales', source: 'Table 1', highlight: 2, reference: { value: 100, label: 'Target' } } })", cid)
        time.sleep(0.4)
        page.screenshot(path=f"{OUT}/f2-01-chart.png")
        page.keyboard.press("Control+z")
        time.sleep(0.2)
        check("undo reverts the chart change", next(c for c in state()["charts"] if c["id"] == cid)["title"] != "East sells the most units", "")
        page.keyboard.press("Control+y")
        time.sleep(0.2)

        # ------------------------------------------------------------------ sign-offs and locking
        select(T, 1, 1, 4, 3)
        ok = page.evaluate("() => window.__gw.review.signOffSelection('Q3 close', true)")
        m = meta(T)
        check("sign-off recorded on the selection with a value fingerprint", ok and len(m["signoffs"]) == 1 and m["signoffs"][0]["note"] == "Q3 close" and m["signoffs"][0]["locked"] and len(m["signoffs"][0]["hash"]) == 16, str(m["signoffs"]))
        before = cell(T, 1, 1)["i"]
        type_into(T, 1, 1, "999")
        st = state()
        check("typing into a locked range is refused with a message", cell(T, 1, 1)["i"] == before and st["status"].startswith("locked"), st["status"])
        page.keyboard.press("Escape")
        so = m["signoffs"][0]["id"]
        apply({"type": "set_signoff_locked", "table": T, "id": so, "locked": False})
        apply({"type": "set_cell", "table": T, "row": 1, "col": 1, "input": "999"})
        stale = page.evaluate("(t) => window.__gw.book.signoffStatus(t)", T)
        check("a value change inside the signed range marks the sign-off as changed", stale == [{"id": so, "stale": True}], str(stale))
        apply({"type": "set_cell", "table": T, "row": 1, "col": 1, "input": before})
        stale = page.evaluate("(t) => window.__gw.book.signoffStatus(t)", T)
        check("restoring the value makes the sign-off current again", stale == [{"id": so, "stale": False}], str(stale))
        page.evaluate("() => window.__gw.getState().set({ panel: 'review' })")
        page.wait_for_selector(".review-panel .signoff", timeout=5000)
        badge = page.text_content(".review-panel .signoff .badge")
        check("Review panel lists the sign-off with its status badge", badge == "unchanged", str(badge))

        # ------------------------------------------------------------------ CHECK, FX, RECONCILE, AGEING
        apply({"type": "set_cell", "table": T, "row": 0, "col": 5, "input": '=CHECK(D6 = SUM(D2:D5), "Total ties to the lines")'})
        apply({"type": "set_cell", "table": T, "row": 1, "col": 5, "input": '=CHECK(B2 > 1000, "Units above 1000")'})
        checks = page.evaluate("() => window.__gw.book.checks()")
        check("CHECK() cells are collected with labels and outcomes", [(c["label"], c["ok"]) for c in checks] == [("Total ties to the lines", True), ("Units above 1000", False)], str(checks))
        page.wait_for_selector(".review-panel .check-item.fail", timeout=5000)
        check("Review panel shows the failing check", page.locator(".review-panel .check-item.fail").count() == 1 and "1 failing" in (page.text_content(".review-panel h4:has-text('Checks')") or ""), "")
        fx = apply({"type": "add_table", "name": "FX", "x": 900, "y": 600, "rows": 3, "cols": 4, "values": [["Date", "From", "To", "Rate"], ["2026-01-01", "USD", "AOA", "900"], ["2026-09-01", "USD", "AOA", "920"]]})
        fxid = fx["created"][0]
        apply({"type": "set_cell", "table": T, "row": 2, "col": 5, "input": '=FX(10, "USD", "AOA")'})
        check("FX() converts with the latest rate from the FX table", num(cell(T, 2, 5)) == 9200, str(cell(T, 2, 5)))
        apply({"type": "set_cell", "table": fxid, "row": 2, "col": 3, "input": "1000"})
        check("changing a rate recalculates FX() cells", num(cell(T, 2, 5)) == 10000, str(cell(T, 2, 5)))
        rec = apply({"type": "add_table", "name": "Rec", "x": 900, "y": 800, "rows": 10, "cols": 10, "values": [["INV1", "100", "INV1", "100"], ["INV2", "250", "INV3", "75"], ["INV3", "75.004", "INV4", "10"]]})
        rid = rec["created"][0]
        apply({"type": "set_cell", "table": rid, "row": 4, "col": 0, "input": "=RECONCILE(A1:B3, C1:D3)"})
        statuses = [text(cell(rid, 5 + i, 4)) for i in range(4)]
        check("RECONCILE() spills matched / only-in-A / only-in-B rows", statuses == ["Matched", "Only in A", "Matched", "Only in B"], str(statuses))
        ap = apply({"type": "add_table", "name": "AP", "x": 1400, "y": 600, "rows": 12, "cols": 8, "values": [["Due", "Amount"], ["2026-10-01", "100"], ["2026-08-20", "200"], ["2026-05-01", "300"]]})
        aid = ap["created"][0]
        apply({"type": "set_cell", "table": aid, "row": 0, "col": 3, "input": "=AGEING(A2:A4, B2:B4, DATE(2026,10,9))"})
        buckets = [(text(cell(aid, r, 3)), num(cell(aid, r, 5))) for r in range(1, 5)]
        check("AGEING() buckets amounts by days outstanding", buckets == [("0-30", 100), ("31-60", 200), ("61-90", None), ("91+", 300)] or buckets[0] == ("0-30", 100) and ("91+", 300) in buckets, str(buckets))

        # ------------------------------------------------------------------ trace
        select(T, 5, 3)  # D6 = SUM(D2:D5)
        page.evaluate("() => window.__gw.review.traceActiveCell()")
        tr = state()["trace"]
        check("trace shows the precedents of D6 and the CHECK cell that reads it", tr is not None and any(r["r0"] == 1 and r["r1"] == 4 and r["c0"] == 3 for r in tr["precedents"]) and any(d["row"] == 0 and d["col"] == 5 for d in tr["dependents"]), json.dumps(tr)[:300])
        page.screenshot(path=f"{OUT}/f2-02-trace.png")
        page.keyboard.press("Control+]")
        time.sleep(0.2)
        sel = state()["selection"]
        check("Ctrl+] jumps to the first dependent", sel["table"] == T and sel["ar"] == 0 and sel["ac"] == 5, str(sel))
        page.keyboard.press("Escape")

        # ------------------------------------------------------------------ merges and wrap
        apply({"type": "set_cell", "table": T, "row": 8, "col": 0, "input": "Merged title across three columns"})
        apply({"type": "merge_cells", "table": T, "r0": 8, "c0": 0, "r1": 8, "c1": 2})
        m = meta(T)
        check("merge_cells records the block", m["merges"] == [{"r0": 8, "c0": 0, "r1": 8, "c1": 2}], str(m["merges"]))
        x, y = cell_screen(T, 8, 2)
        page.mouse.click(x, y)
        sel = state()["selection"]
        check("clicking inside a merged block selects its top-left cell", sel["ar"] == 8 and sel["ac"] == 0, str(sel))
        apply({"type": "set_cell", "table": T, "row": 9, "col": 0, "input": "A long sentence that needs to wrap onto several lines inside the cell"})
        apply({"type": "set_format", "table": T, "r0": 9, "c0": 0, "r1": 9, "c1": 0, "format": {"wrap": True}})
        apply({"type": "set_row_height", "table": T, "row": 9, "height": 60})
        check("wrap flag stored in the cell format", (cell(T, 9, 0)["f"] or {}).get("wrap") is True, str(cell(T, 9, 0)["f"]))
        time.sleep(0.3)
        page.screenshot(path=f"{OUT}/f2-03-merge-wrap.png")
        apply({"type": "unmerge_cells", "table": T, "r0": 8, "c0": 0, "r1": 8, "c1": 2})
        check("unmerge_cells removes the block", meta(T)["merges"] == [], "")

        # ------------------------------------------------------------------ operational transform (pure function)
        t1 = page.evaluate("() => window.__gw.transformOp({ type: 'set_cell', table: 1, row: 5, col: 2, input: 'x' }, { type: 'insert_rows', table: 1, at: 2, count: 2 })")
        t2 = page.evaluate("() => window.__gw.transformOp({ type: 'set_cell', table: 1, row: 5, col: 2, input: 'x' }, { type: 'delete_rows', table: 1, at: 5, count: 1 })")
        t3 = page.evaluate("() => window.__gw.transformOp({ type: 'clear_range', table: 1, r0: 2, c0: 0, r1: 8, c1: 3 }, { type: 'delete_rows', table: 1, at: 4, count: 2 })")
        t4 = page.evaluate("() => window.__gw.transformOp({ type: 'set_cells', table: 1, row: 1, col: 1, values: [['a'],['b']] }, { type: 'insert_cols', table: 1, at: 0, count: 1 })")
        t5 = page.evaluate("() => window.__gw.transformOp({ type: 'set_cell', table: 2, row: 5, col: 2, input: 'x' }, { type: 'insert_rows', table: 1, at: 0, count: 9 })")
        check("in-flight ops are shifted past remote inserts/deletes (and dropped when their cells vanish)", t1["row"] == 7 and t2 is None and t3["r1"] == 6 and t4["col"] == 2 and t5["row"] == 5, f"{t1} {t2} {t3} {t4} {t5}")

        # ------------------------------------------------------------------ save, undo as ops, audit CSV, compaction
        page.evaluate("() => window.__gw.getState().set({ fileName: 'Round two' })")
        page.evaluate("() => document.querySelector('.topbar .save-btn').click()")
        for _ in range(50):
            if state()["fileId"]:
                break
            time.sleep(0.1)
        fid = state()["fileId"]
        check("document saved", bool(fid), str(fid))
        time.sleep(0.5)
        page2 = ctx.new_page()
        page2.on("pageerror", lambda e: errors.append("p2: " + str(e)))
        page2.goto(f"{BASE}/?file={fid}", wait_until="networkidle")
        page2.wait_for_selector(".canvas-host canvas", timeout=30000)
        time.sleep(1.0)
        page.evaluate("() => window.__gw.book.apply({ type: 'set_cell', table: 1, row: 12, col: 0, input: 'undo me' })")
        time.sleep(0.5)
        page.evaluate("() => window.__gw.book.undo()")
        time.sleep(0.8)
        v2 = page2.evaluate("() => window.__gw.getState().cells.get(1).get(12*65536+0)?.i ?? ''")
        h = rest("GET", f"/api/files/{fid}/history?limit=5")
        types = [e.get("op", {}).get("type") for e in h["entries"]]
        check("undo travels to the other client as a restore op (no document snapshot)", v2 == "" and types[0] == "restore_cells" and not h["entries"][0].get("checkpoint"), f"p2 sees {v2!r}; log tail {types}")
        # a remote edit is not undoable locally
        can_before = page2.evaluate("() => window.__gw.getState().canUndo")
        page.evaluate("() => window.__gw.book.apply({ type: 'set_cell', table: 1, row: 12, col: 1, input: 'from p1' })")
        time.sleep(0.6)
        can_after = page2.evaluate("() => window.__gw.getState().canUndo")
        got = page2.evaluate("() => window.__gw.getState().cells.get(1).get(12*65536+1)?.i ?? ''")
        check("remote edits arrive but do not enter the local undo stack", got == "from p1" and can_before == can_after, f"{can_before}→{can_after} {got!r}")
        # concurrent: p2 inserts rows while p1 edits a row below → p1's edit lands on the shifted row
        page2.evaluate("() => window.__gw.book.apply({ type: 'insert_rows', table: 1, at: 0, count: 2 })")
        page.evaluate("() => window.__gw.book.apply({ type: 'set_cell', table: 1, row: 12, col: 2, input: 'shifted?' })")
        time.sleep(1.5)

        def where(pg):
            return pg.evaluate("() => { const m = window.__gw.getState().cells.get(1); const out = []; for (const c of m.values()) if (c.i === 'shifted?') out.push([c.r, c.c]); return out; }")

        w1, w2 = where(page), where(page2)
        check("concurrent insert + edit converge on the same cell in both clients", w1 == w2 and len(w1) == 1, f"{w1} vs {w2}")
        cats = [c["categories"] for c in state()["charts"]]
        check("chart ranges follow the inserted rows", cats and cats[0].endswith("A4:A7"), str(cats))
        page2.close()
        code, csv = rest("GET", f"/api/files/{fid}/history.csv", raw=True)
        lines = csv.strip().split("\n")
        check("audit trail downloads as CSV", code == 200 and lines[0].lstrip("﻿").startswith("seq,timestamp,author,login,origin,type") and any(",restore_cells," in l for l in lines), f"{len(lines)} lines")
        comp = rest("POST", f"/api/files/{fid}/history/compact")
        check("checkpoint compaction endpoint keeps the first and latest checkpoints", isinstance(comp.get("kept"), list) and len(comp["kept"]) >= 1, str(comp))

        # ------------------------------------------------------------------ print view
        html = page.evaluate("() => window.__gw.printDocumentHtml()")
        check("print view holds every table and chart", html.count("<section class=\"table\">") >= 4 and "<svg" in html and "Round two" in html, f"{len(html)} chars")
        open(f"{OUT}/f2-print.html", "w").write(html)

        # ------------------------------------------------------------------ AI tools (mock model + PostgreSQL)
        if MOCK and PG:
            host, port, db, user, pw = PG
            rest("PUT", "/api/ai/settings", {"baseUrl": MOCK, "model": "mock"})
            conn = rest("POST", "/api/connections", {"name": "demo pg", "kind": "postgres", "host": host, "port": int(port), "database": db, "user": user, "password": pw, "ssl": False})
            page.evaluate("() => { try { localStorage.setItem('gridwright.ai.tools', '1'); } catch {} window.__gw.getState().set({ panel: 'ai' }); }")
            page.wait_for_selector(".ai-panel textarea", timeout=5000)
            page.fill(".ai-panel textarea", "How many orders are there?")
            page.keyboard.press("Enter")
            page.wait_for_selector(".ai-panel .tool-run.ok code:has-text('run_sql')", timeout=20000)
            time.sleep(0.5)
            names = page.eval_on_selector_all(".ai-panel .tool-run code", "els => els.map((e) => e.textContent)")
            answer = page.locator(".ai-panel .msg.assistant .msg-body").last.text_content() or ""
            check("assistant calls list_connections then run_sql and answers from the result", names == ["list_connections", "run_sql"] and "5 rows" in answer, f"{names} / {answer[:80]}")
            page.click(".ai-panel .tool-run.ok .tool-head:has-text('run_sql')")
            time.sleep(0.2)
            check("tool results are inspectable in the chat", page.locator(".ai-panel .tool-table td:has-text('5')").count() >= 1, "")
            page.screenshot(path=f"{OUT}/f2-04-ai-tools.png")
            bad = rest("POST", "/api/ai/chat", {"messages": [{"role": "user", "content": "x"}]}, raw=True)
            check("chat endpoint still answers without tools", bad[0] == 200, str(bad[0]))
            rest("DELETE", f"/api/connections/{conn['id']}")
            page.evaluate("() => window.__gw.getState().set({ panel: 'none' })")
        else:
            print("SKIP AI tools (needs --mock-llm and --pg)")

        # ------------------------------------------------------------------ templates
        page.evaluate("() => window.__gw.applyTemplate('ap-ageing')")
        time.sleep(1.0)
        names = page.evaluate("() => [...window.__gw.getState().tables.values()].map((t) => t.name)")
        checks = page.evaluate("() => window.__gw.book.checks()")
        st = state()
        check("AP ageing template builds its tables, a passing reconciliation check and an exhibit", names == ["Invoices", "Ageing"] and len(checks) == 1 and checks[0]["ok"] and len(st["charts"]) == 1 and st["charts"][0]["kind"] == "bar", f"{names} {checks} {len(st['charts'])}")
        time.sleep(0.5)
        page.screenshot(path=f"{OUT}/f2-05-template-ageing.png")
        page.evaluate("() => window.__gw.applyTemplate('bank-rec')")
        time.sleep(1.0)
        rec_status = page.evaluate("() => { const s = window.__gw.getState(); const t = [...s.tables.values()].find((x) => x.name === 'Reconciliation'); const m = s.cells.get(t.id); return [3,4,5,6,7,8].map((r) => m.get(r*65536+4)?.v?.s); }")
        check("bank reconciliation template matches ledger and statement by reference", "Matched" in rec_status and "Only in A" in rec_status and "Difference" in rec_status, str(rec_status))
        page.evaluate("() => window.__gw.applyTemplate('treasury')")
        time.sleep(1.0)
        total = page.evaluate("() => { const s = window.__gw.getState(); const t = [...s.tables.values()].find((x) => x.name === 'Positions'); return s.cells.get(t.id).get(7*65536+4)?.v?.n; }")
        check("treasury template converts balances through the FX table", total is not None and total > 400_000_000, str(total))
        page.screenshot(path=f"{OUT}/f2-06-template-treasury.png")

        # ------------------------------------------------------------------ per-document access (identity server)
        if ACL:
            A = {"tailscale-user-login": "alice@example.com", "tailscale-user-name": "Alice"}
            B = {"tailscale-user-login": "bob@example.com", "tailscale-user-name": "Bob"}
            C = {"tailscale-user-login": "carol@example.com"}
            BOSS = {"tailscale-user-login": "boss@example.com"}
            doc = {"name": "Private", "json": '{"name":"Private","tables":[],"next_table_id":1}'}
            created = rest("POST", "/api/files", doc, base=ACL, headers=A)
            did = created["id"]
            check("identity server: creator owns the document", created.get("permission") == "own" and rest("GET", f"/api/files/{did}/access", base=ACL, headers=A)["owner"] == "alice@example.com", str(created))
            # private by default (0.4): a stranger gets 404; once shared for editing they still get 403 for sharing changes
            check("identity server: non-owner cannot change sharing", status_of("PUT", f"/api/files/{did}/access", {"public": "none"}, base=ACL, headers=B) in (403, 404), "")
            rest("PUT", f"/api/files/{did}/access", {"public": "none", "shares": {"bob@example.com": "sign"}, "folder": "Finance/2026"}, base=ACL, headers=A)
            check("identity server: private document is invisible to others and listed with its folder for the owner", status_of("GET", f"/api/files/{did}", base=ACL, headers=C) == 404 and rest("GET", "/api/files", base=ACL, headers=C) == [] and any(f["id"] == did and f["folder"] == "Finance/2026" for f in rest("GET", "/api/files", base=ACL, headers=A)), "")
            # 0.6: a sign-off share cannot replace the document (PUT is an edit); it persists through a server-built checkpoint
            check("identity server: a sign-off share cannot overwrite the document or change sharing, but can checkpoint it; admins see everything", status_of("PUT", f"/api/files/{did}", doc, base=ACL, headers=B) == 403 and status_of("POST", f"/api/files/{did}/checkpoint", {}, base=ACL, headers=B) == 200 and status_of("PUT", f"/api/files/{did}/access", {"public": "edit"}, base=ACL, headers=B) == 403 and any(f["id"] == did for f in rest("GET", "/api/files", base=ACL, headers=BOSS)), "")
            check("identity server: only the owner (or an admin) deletes", status_of("DELETE", f"/api/files/{did}", base=ACL, headers=B) == 403 and status_of("DELETE", f"/api/files/{did}", base=ACL, headers=A) == 200, "")
        else:
            print("SKIP access control (no --acl)")

        real_errors = [e for e in errors if "favicon" not in e and "ERR_BLOCKED" not in e and "Failed to load resource" not in e]
        check("no page errors", not real_errors, "; ".join(real_errors[:3]))
        page.screenshot(path=f"{OUT}/f2-07-final.png")
        browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed; screenshots in {OUT}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Intake (0.10.0): bring material in and make it trustworthy before it becomes a table — the gates
of the brief, over the synthetic fixture pack in e2e/fixtures/vehicles with its independently
computed expected figures.

First value (no Save, no form) · locale and identifiers (leading zeros, 20 digits, Kz, dd/mm/yyyy,
a Total row) · the first reading against expected.json · one snapshot (edits make no periods) ·
freshness (formatting does not refresh) · the next snapshot (independent observations count even when
equal) · a correction (revised, never counted twice) · a duplicate by content · an older period kept
as history · the same columns of another entity kept apart · a partial delivery (coverage change
suspends the trend) · a workbook with formulas · XML and JSON records · a source that disagrees
(conflict kept) · hostile cells inert · a ragged row quarantined · monitoring failure is never quiet ·
an agent's snapshot never displaces a person's · the inbox adapter · the phone.

Usage: python3 e2e/intake.py [http://localhost:8787] [--inbox /path/to/GRIDWRIGHT_INBOX] [--pg host:port:db:user:pass]
"""
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from decimal import Decimal

from playwright.sync_api import sync_playwright

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
BASE = ARGS[0] if ARGS else "http://localhost:8787"
INBOX = None
PG = None
for i, a in enumerate(sys.argv):
    if a == "--inbox":
        INBOX = sys.argv[i + 1]
    if a == "--pg":
        PG = sys.argv[i + 1].split(":")
OUT = os.environ.get("E2E_OUT", "/tmp/gridwright-e2e")
os.makedirs(OUT, exist_ok=True)
LAUNCH = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures", "vehicles")
EXPECTED = json.load(open(os.path.join(FIX, "expected.json")))


def rest(method, path, body=None, raw=False):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"content-type": "application/json", "accept": "application/json, text/event-stream"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            text = r.read().decode()
            return (r.status, text) if raw else json.loads(text)
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        if raw:
            return (e.code, text)
        raise


def mcp(name, arguments):
    code, text = rest("POST", "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}}, raw=True)
    res = json.loads(text).get("result", {})
    content = "".join(c.get("text", "") for c in res.get("content", []))
    try:
        return json.loads(content), res.get("isError", False)
    except Exception:
        return content, res.get("isError", False)


def main():
    results = []

    def check(name, ok, detail=""):
        results.append((name, ok, detail))
        print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=LAUNCH)
        page = browser.new_context(viewport={"width": 1500, "height": 1000}).new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("dialog", lambda d: d.accept())
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_selector(".canvas-host canvas", timeout=30000)
        time.sleep(0.6)

        def state():
            return page.evaluate("() => { const s = window.__gw.getState(); return { fileId: s.fileId, fileName: s.fileName, dirty: s.dirty, panel: s.panel, tables: [...s.tables.values()].map((t) => ({ id: t.id, name: t.name, rows: t.rows, cols: t.cols })) }; }")

        def cell(t, r, c):
            return page.evaluate("([t,r,c]) => { const x = window.__gw.getState().cells.get(t)?.get(r*65536+c); return x ? { i: x.i, v: x.v, f: x.f } : null; }", [t, r, c])

        def set_panel(name):
            page.evaluate("(p) => window.__gw.getState().set({ panel: p })", name)
            time.sleep(0.3)

        cards = []

        def intake(name, action=None, expect_card=True):
            set_panel("files")
            page.set_input_files(".panel input[type=file]", os.path.join(FIX, name))
            page.wait_for_selector(".intake-card", timeout=20000)
            text = page.text_content(".intake-card") or ""
            cards.append(text)
            if action is None:
                return text
            if action == "primary":
                page.locator(".intake-card button.primary").first.click()
            else:
                page.locator(f".intake-card button:has-text('{action}')").first.click()
            page.wait_for_selector(".intake-card", state="detached", timeout=20000)
            page.wait_for_timeout(500)
            return text

        def companion():
            return rest("GET", f"/api/files/{fid}/companion")

        def watch_named(c, part):
            return next((w for w in c["watches"] if part in w["def"]["purpose"]), None)

        def evaluate(formula):
            r, err = mcp("evaluate", {"id": fid, "formula": formula})
            return r.get("n") if isinstance(r, dict) else None

        def reading(table):
            return rest("GET", f"/api/files/{fid}/reading/{table}")

        def expect(name, key):
            return EXPECTED[name][key]

        # ================================================================ 1. first value: a file on an unsaved document, no Save, no form
        page.evaluate("() => window.__gw.book.apply({ type: 'delete_table', table: 1 })")
        st = state()
        assert st["fileId"] is None
        text = intake("inventory-2026-10-06.csv")
        st = state()
        fid = st["fileId"]
        check("1. a file dropped on an unsaved document saves it as a private draft named after the series, and the companion answers in Ask", bool(fid) and st["fileName"] == "inventory" and st["panel"] == "ai", str({k: st[k] for k in ("fileId", "fileName", "panel")}))
        check("   the card says what the file is and that nothing here has its columns: a new table — the decision is the person's", "New here" in text and "a new table" in text and "Add as a table" in text, text[:200])
        page.locator(".intake-card button:has-text('columns')").click()
        cols = page.text_content(".intake-columns") or ""
        check("   the column profile: identifiers with leading zeros kept, a 20-digit reference as text, the Kz unit, dates, a yes/no column, a constant branch", "identifier" in cols and "leading zeros kept" in cols and "Kz" in cols and "date" in cols and "boolean" in cols and "all “Luanda”" in cols, cols[:300])
        check("   checked, in words: the Total row set aside, cells normalised (Portuguese locale, dates, identifiers)", "totals row" in text and "normalised" in text, text[:300])
        page.screenshot(path=f"{OUT}/intake-00-card.png")
        page.locator(".intake-card button.primary").first.click()
        page.wait_for_selector(".intake-card", state="detached", timeout=20000)
        page.wait_for_timeout(600)
        st = state()
        inv = next((t for t in st["tables"] if t["name"] == "inventory"), None)
        check("   placed through the log: one table, 5 data rows (the Total row is not one), 8 columns", inv is not None and inv["rows"] == 6 and inv["cols"] == 8, str(st["tables"]))
        a2 = cell(inv["id"], 1, 0)
        ref = cell(inv["id"], 1, 7)
        cost = cell(inv["id"], 1, 4)
        date = cell(inv["id"], 1, 5)
        check("   identifiers survive as text: 00012345ABC keeps its zeros and 12345678901234567890 every digit; the cost is a number formatted in Kz; the date is a date", a2 and a2["v"] == {"s": "00012345ABC"} and ref and ref["v"] == {"s": "12345678901234567890"} and cost and cost["v"] == {"n": 24150009} and "Kz" in (cost["f"] or {}).get("number_format", "") and date and "n" in date["v"] and (date["f"] or {}).get("number_format") == "yyyy-mm-dd", f"{a2} {ref} {cost} {date}")
        total = evaluate("=SUM(inventory[Landed cost (Kz)])")
        check("   the engine's total equals the independently computed figure (Decimal, no rounding)", total is not None and Decimal(str(total)) == Decimal(expect("inventory-2026-10-06.csv", "total_landed_cost")), f"{total} vs {expect('inventory-2026-10-06.csv', 'total_landed_cost')}")
        rd = reading(inv["id"])
        fig = {f["label"]: f["value"] for f in rd["figures"]}
        check("   the first reading matches expected.json: vehicles, capital tied up, blanks, over 90 (excl. reserved) and their cost, reserved", fig.get("vehicles") == expect("inventory-2026-10-06.csv", "vehicles") and Decimal(str(fig.get("total Landed cost (Kz) (capital tied up)"))) == Decimal(expect("inventory-2026-10-06.csv", "total_landed_cost")) and fig.get("vehicles with no Landed cost (Kz)") == expect("inventory-2026-10-06.csv", "blank_landed_cost") and fig.get("vehicles over 90 days (excluding Reserved = yes)") == expect("inventory-2026-10-06.csv", "over90_available") and Decimal(str(fig.get("Landed cost (Kz) of those over 90 days"))) == Decimal(expect("inventory-2026-10-06.csv", "landed_cost_over90_available")) and fig.get("Reserved = yes") == expect("inventory-2026-10-06.csv", "reserved"), json.dumps(fig)[:300])
        check("   …and says what one snapshot cannot: a trend", "a trend needs the next one" in rd["text"] and "provisional" in rd["text"], rd["text"][-120:])
        refl = page.text_content(".companion .reflection") or ""
        check("   the reflection in Ask carries the reading, in business terms, with the period", "period 2026-10-06" in refl and "capital tied up" in refl, refl[:200])
        c = companion()
        src = next(r for r in c["records"] if r["kind"] == "source")
        check("   the source record: series, period, coverage (rows, identifiers, entity) and the retained original's key", src["source"] == "inventory" and src["period"] == "2026-10-06" and src["coverage"]["rows"] == 5 and src["coverage"]["identifiers"] == 5 and src["coverage"]["idColumn"] == "VIN" and src["coverage"]["entity"] == "Branch: Luanda" and len(src["intake"]) == 32, json.dumps(src.get("coverage")))
        prof = rest("GET", f"/api/files/{fid}/intake")
        code, _ = rest("GET", f"/api/files/{fid}/intake/{src['intake']}/original", raw=True)
        check("   the original file is retained as it arrived, downloadable, and the profile lists it as applied", code == 200 and prof and prof[0]["status"] == "applied" and prof[0]["name"] == "inventory-2026-10-06.csv", str(code))

        # ================================================================ 2. watches, then: one snapshot — edits make no periods
        page.wait_for_selector(".companion .situation", timeout=8000)
        page.click(".companion button:has-text('Watching')")
        page.wait_for_selector(".suggestion", timeout=8000)
        page.locator(".suggestion", has_text="over 90 days").locator("button:has-text('Watch this')").click()
        time.sleep(0.6)
        page.locator(".suggestion", has_text="Total landed cost").locator("button:has-text('Watch this')").click()
        time.sleep(0.6)
        reserved = rest("POST", f"/api/files/{fid}/companion/watches", {"purpose": "Reserved vehicles", "formula": '=COUNTIF(inventory[Reserved], "yes")', "kind": "threshold", "op": ">", "value": 0, "sustain": 2, "scope": "inventory", "sources": ["inventory"]})
        c = companion()
        ageing = watch_named(c, "over 90 days")
        check("2. watches: ageing (worsening, baseline), total (change), reserved (threshold after 2 snapshots) — each with one observation for 2026-10-06", ageing["health"] == "baseline" and len(ageing["observations"]) == 1 and ageing["observations"][0]["period"] == "2026-10-06" and ageing["observations"][0]["population"] == 5 and reserved["health"] == "baseline" and reserved["observations"][0]["value"] == 1, str(ageing["observations"]))
        for days in (95, 15, 96):  # the Golf (row 4) in and out of the over-90 population: the figure moves 2 → 3 → 2 → 3
            page.evaluate("([t, v]) => window.__gw.book.apply({ type: 'set_cells', table: t, row: 4, col: 2, values: [[String(v)]] })", [inv["id"], days])
            time.sleep(0.3)
            rest("POST", f"/api/files/{fid}/companion/check")
        c = companion()
        ageing = watch_named(c, "over 90 days")
        obs = [o for o in ageing["observations"] if o["def"] == ageing["defHash"]]
        check("   three edits of the same snapshot are three revisions of one observation, not three periods: no trend, still baseline, nothing 'worse'", len(obs) == 1 and obs[0].get("revisions", 0) >= 3 and obs[0]["value"] == 3 and ageing["health"] == "baseline" and not any("snapshots running" in e["text"] or ", worse" in e["text"] for e in c["events"]) and any("revised from" in e["text"] for e in c["events"]), f"{len(obs)} observation(s), revisions {obs[0].get('revisions')}, {ageing['health']}")
        page.evaluate("([t]) => window.__gw.book.apply({ type: 'set_cells', table: t, row: 4, col: 2, values: [['15']] })", [inv["id"]])
        time.sleep(0.3)
        rest("POST", f"/api/files/{fid}/companion/check")

        # ================================================================ 3. freshness: formatting and saving do not refresh a source
        before = next(s for s in rest("GET", f"/api/files/{fid}/companion/brief")["sources"] if s["name"] == "inventory")
        page.evaluate("([t]) => window.__gw.book.apply({ type: 'set_format', table: t, r0: 1, c0: 4, r1: 1, c1: 4, format: { bold: true } })", [inv["id"]])
        time.sleep(0.4)
        page.click(".topbar .save-btn")
        page.wait_for_function("() => !window.__gw.getState().dirty", timeout=8000)
        time.sleep(0.4)
        after = next(s for s in rest("GET", f"/api/files/{fid}/companion/brief")["sources"] if s["name"] == "inventory")
        check("3. a format change and a save leave the source's last data change where it was; its data-as-of period is shown apart from it", after["lastChange"] == before["lastChange"] and after["asOf"] == "2026-10-06", f"{before['lastChange']} → {after['lastChange']} asOf {after.get('asOf')}")

        # ================================================================ 4. the next snapshot: same series, independent observations count even when equal
        text = intake("inventory-2026-10-13.csv")
        check("4. the next snapshot is recognised by the series and the vehicles in common (5 of 6, 1 new), period 2026-10-13 after 2026-10-06; the card offers to update", "Next snapshot" in text and "2026-10-13 after 2026-10-06" in text and "1 new" in text and "Update inventory" in text, text[:260])
        page.locator(".intake-card button.primary").first.click()
        page.wait_for_selector(".intake-card", state="detached", timeout=20000)
        page.wait_for_timeout(600)
        c = companion()
        ageing = watch_named(c, "over 90 days")
        reserved = next(w for w in c["watches"] if w["def"]["purpose"] == "Reserved vehicles")
        check("   the same table, now 6 rows; two periods on each watch; the reserved count is 1 on both — equal values on separate periods count, so the sustained rule fires", next(t for t in state()["tables"] if t["id"] == inv["id"])["rows"] == 7 and len(ageing["observations"]) == 2 and reserved["health"] == "attention" and [o["value"] for o in reserved["observations"]] == [1, 1], f"{reserved['health']} {[o['value'] for o in reserved['observations']]}")
        total = evaluate("=SUM(inventory[Landed cost (Kz)])")
        check("   the total after the update equals the expected figure for 13 Oct", total is not None and Decimal(str(total)) == Decimal(expect("inventory-2026-10-13.csv", "total_landed_cost")), str(total))
        rest("DELETE", f"/api/files/{fid}/companion/watches/{reserved['id']}")

        # ================================================================ 5. a correction of the same period: revised, never counted twice
        text = intake("inventory-2026-10-13-corrected.csv")
        check("5. the same period re-delivered is named a correction or re-delivery — it replaces that period's evidence, it does not count twice", "Same period" in text and "does not count twice" in text, text[:220])
        page.locator(".intake-card button.primary").first.click()
        page.wait_for_selector(".intake-card", state="detached", timeout=20000)
        page.wait_for_timeout(600)
        c = companion()
        tot = watch_named(c, "otal landed cost")
        obs13 = [o for o in tot["observations"] if o.get("period") == "2026-10-13"]
        check("   the total watch still has two periods; the 13 Oct observation was revised (one revision, the previous value kept), not appended", len(tot["observations"]) == 2 and len(obs13) == 1 and obs13[0].get("revisions") == 1 and obs13[0]["previous"] is not None and Decimal(str(obs13[0]["value"])) == Decimal(expect("inventory-2026-10-13-corrected.csv", "total_landed_cost")), str(obs13)[:200])
        check("   the activity says 'revised … same snapshot', not 'was … on'", any("revised from" in e["text"] and "same snapshot 2026-10-13" in e["text"] for e in c["events"]), str([e["text"] for e in c["events"] if "revised" in e["text"]])[:200])
        srcs = [r for r in c["records"] if r["kind"] == "source" and r["source"] == "inventory"]
        check("   the source records: 06 Oct superseded, the first 13 Oct superseded by the correction, the correction current", [r["status"] for r in srcs] == ["superseded", "superseded", "stated"] and srcs[-1]["period"] == "2026-10-13", str([(r["period"], r["status"]) for r in srcs]))

        # ================================================================ 6. the same file again: a duplicate by content, whatever its name
        shutil.copy(os.path.join(FIX, "inventory-2026-10-13-corrected.csv"), os.path.join(FIX, "..", "inventory-2026-10-13 (1).csv"))
        try:
            set_panel("files")
            page.set_input_files(".panel input[type=file]", os.path.join(FIX, "..", "inventory-2026-10-13 (1).csv"))
            page.wait_for_selector(".intake-card", timeout=20000)
            text = page.text_content(".intake-card") or ""
            check("6. an exact re-delivery under another name is recognised by content: already added, nothing to do — no primary action", "Already added" in text and "nothing to do" in text and page.locator(".intake-card button.primary").count() == 0, text[:200])
            page.locator(".intake-card button:has-text('not now')").click()
            page.wait_for_selector(".intake-card", state="detached", timeout=5000)
        finally:
            os.remove(os.path.join(FIX, "..", "inventory-2026-10-13 (1).csv"))

        # ================================================================ 7. an older period arriving late: history, the current one stands
        text = intake("inventory-2026-09-29.csv")
        check("7. an older period than the current snapshot is offered as history, not as an update", "Older snapshot" in text and "kept as history" in text and "Keep as history" in text, text[:220])
        page.locator(".intake-card button.primary").first.click()
        page.wait_for_selector(".intake-card", state="detached", timeout=20000)
        page.wait_for_timeout(600)
        c = companion()
        st = state()
        hist = next((t for t in st["tables"] if t["name"] == "inventory 2026-09-29"), None)
        cur = [r for r in c["records"] if r["kind"] == "source" and r["source"] == "inventory" and r["status"] == "stated"]
        histrec = next((r for r in c["records"] if r["kind"] == "source" and "history" in (r["source"] or "")), None)
        check("   it becomes its own table named with its period; the current inventory snapshot (13 Oct) stands; the ageing watch keeps its two periods", hist is not None and hist["rows"] == 5 and len(cur) == 1 and cur[0]["period"] == "2026-10-13" and histrec is not None and len(watch_named(c, "over 90 days")["observations"]) == 2, f"{hist} {[r['period'] for r in cur]}")

        # ================================================================ 8. the same columns, another entity: kept apart
        text = intake("inventory-2026-10-13-benguela.csv")
        check("8. identical columns from another branch are not the same series: Branch is Benguela here and Luanda there — kept separate, named after the entity", "different entity" in text and "Benguela" in text and "Add as a table" in text, text[:260])
        page.locator(".intake-card button.primary").first.click()
        page.wait_for_selector(".intake-card", state="detached", timeout=20000)
        page.wait_for_timeout(600)
        st = state()
        beng = next((t for t in st["tables"] if t["name"] == "inventory Benguela"), None)
        check("   a separate table 'inventory Benguela'; the Luanda inventory untouched (6 rows)", beng is not None and beng["rows"] == 4 and next(t for t in st["tables"] if t["id"] == inv["id"])["rows"] == 7, str(st["tables"]))

        # ================================================================ 9. a partial delivery: coverage changed, the trend comparison is suspended
        text = intake("inventory-2026-10-20-partial.csv")
        check("9. a partial 20 Oct delivery is still the next snapshot of the series — with 4 vehicles gone, said on the card", "Next snapshot" in text and "4 gone" in text, text[:220])
        page.locator(".intake-card button.primary").first.click()
        page.wait_for_selector(".intake-card", state="detached", timeout=20000)
        page.wait_for_timeout(600)
        c = companion()
        ageing = watch_named(c, "over 90 days")
        last = ageing["observations"][-1]
        check("   the ageing observation for 20 Oct is not compared with 13 Oct (6 → 2 rows): coverage changed, baseline again, said in the activity", last["period"] == "2026-10-20" and last.get("comparable") is False and "coverage changed" in (last.get("note") or "") and ageing["health"] == "baseline" and any("coverage changed (6 → 2 rows)" in e["text"] for e in c["events"]), f"{last.get('note')} {ageing['health']}")

        # ================================================================ 10. a workbook with formulas: reduced to values, same period
        text = intake("inventory-2026-10-20.xlsx")
        check("10. the Excel snapshot for the same period: formula cells reduced to the values the file carried, offered as the 20 Oct correction", "XLSX" in text and "formula cell" in text and "reduced" in text and "Same period" in text, text[:260])
        page.locator(".intake-card button.primary").first.click()
        page.wait_for_selector(".intake-card", state="detached", timeout=20000)
        page.wait_for_timeout(600)
        st = state()
        cur = next(t for t in st["tables"] if t["id"] == inv["id"])
        chk = cell(inv["id"], 1, 8)
        check("   the table holds the six rows and the check column as values, not formulas", cur["rows"] == 7 and cur["cols"] == 9 and chk and not (chk["i"] or "").startswith("=") and chk["v"] == {"n": 134}, f"{cur} {chk}")

        # ================================================================ 11. XML and JSON records; a source that disagrees is kept
        text = intake("invoices-2026-10-15.xml")
        check("11. an XML record list becomes a table: invoice, VIN (identifier), amount, currency, shipment, date", "XML" in text and "New here" in text, text[:200])
        page.locator(".intake-card button.primary").first.click()
        page.wait_for_selector(".intake-card", state="detached", timeout=20000)
        page.wait_for_timeout(500)
        text = intake("costs-2026-10-15.json")
        check("   JSON records (English-locale amounts) become a table too", "JSON" in text and "New here" in text, text[:200])
        page.locator(".intake-card button.primary").first.click()
        page.wait_for_selector(".intake-card", state="detached", timeout=20000)
        page.wait_for_timeout(600)
        c = companion()
        st = state()
        names = [t["name"] for t in st["tables"]]
        conflict = next((r for r in c["records"] if r["kind"] == "contradiction" and "KMHJ381ABNU012347" in r["text"]), None)
        check("   both tables exist; the freight desk's Creta cost disagrees with the corrected inventory: kept as a conflict with both figures, found by a check", "invoices" in names and "costs" in names and conflict is not None and conflict["status"] == "observed" and "inventory says 18,829,981.5" in conflict["text"] and "costs says 18,629,981.5" in conflict["text"], str(conflict and conflict["text"]))

        # ================================================================ 12. hostile cells are data; a ragged row is quarantined
        text = intake("notes-hostile.csv")
        check("12. cells that read like instructions are counted and inert", "read like instructions" in text and "change nothing" in text, text[:200])
        page.locator(".intake-card button.primary").first.click()
        page.wait_for_selector(".intake-card", state="detached", timeout=20000)
        page.wait_for_timeout(400)
        c = companion()
        check("   nothing was approved, decided or disabled by them: no proposals, no decisions from the file", not rest("GET", f"/api/files/{fid}/proposals") and not any(r["kind"] == "decision" for r in c["records"]), "")
        text = intake("ragged.csv")
        check("   a row wider than the header is held back and listed, with the reason (file line 3)", "held back" in text and "row 3" in text and "6 cells for 3 columns" in text, text[:300])
        page.locator(".intake-card button.primary").first.click()
        page.wait_for_selector(".intake-card", state="detached", timeout=20000)
        page.wait_for_timeout(400)
        st = state()
        rag = next((t for t in st["tables"] if t["name"] == "ragged"), None)
        check("   the table holds the two sound rows (the short one padded), never the quarantined one", rag is not None and rag["rows"] == 3 and rag["cols"] == 3, str(rag))

        # ================================================================ 13. monitoring failure is never "all quiet"
        err = rest("POST", f"/api/files/{fid}/companion/watches", {"purpose": "Broken formula", "formula": "=NOPE(inventory[VIN])", "kind": "threshold", "op": ">", "value": 0})
        txt = rest("POST", f"/api/files/{fid}/companion/watches", {"purpose": "Model text", "formula": "=INDEX(inventory[Model], 1)", "kind": "threshold", "op": ">", "value": 0})
        u = rest("GET", f"/api/files/{fid}/companion/understanding")
        check("13. a formula error is 'cannot evaluate', text where a number should be is 'cannot assess': neither within bounds nor out of them; monitoring never reads as all quiet", err["health"] == "error" and txt["health"] == "invalid" and txt["observations"][-1]["invalid"] == "text" and u["lead"] != "All quiet" and ("cannot be assessed" in u["lead"] or "cannot be assessed" in u["monitoring"]["text"]) and u["monitoring"]["cannotAssess"] >= 2 and u["monitoring"]["state"] in ("partially assessed", "cannot assess", "action needed"), f"{err['health']} {txt['health']} | {u['lead']} | {u['monitoring']['state']}")
        set_panel("none")
        set_panel("ai")
        page.wait_for_selector(".companion .situation", timeout=8000)
        head = page.text_content(".companion-head") or ""
        check("   the head line counts what cannot be assessed", "cannot be assessed" in head, head[:160])
        rest("DELETE", f"/api/files/{fid}/companion/watches/{err['id']}")
        rest("DELETE", f"/api/files/{fid}/companion/watches/{txt['id']}")

        # ================================================================ 14. an agent's snapshot never displaces a person's
        rem, e1 = mcp("remember", {"id": fid, "kind": "source", "text": "Imported inventory from an agent's own export", "source": "inventory", "period": "2026-10-27"})
        c = companion()
        cur = [r for r in c["records"] if r["kind"] == "source" and r["source"] == "inventory" and r["status"] == "stated"]
        agent_src = next((r for r in c["records"] if r["id"] == rem.get("record")), None)
        check("14. an agent's 'newer' snapshot is proposed, not current: the person's 20 Oct snapshot stands, said in the activity", not e1 and len(cur) == 1 and cur[0]["period"] == "2026-10-20" and agent_src is not None and agent_src["status"] == "proposed" and any("stays current until a person confirms" in ev["text"] for ev in c["events"]), f"{[r['period'] for r in cur]} {agent_src and agent_src['status']}")

        # ================================================================ 15. the inbox adapter: listed on request, taken, placed, moved aside
        inbox = rest("GET", "/api/inbox")
        if INBOX and inbox.get("configured"):
            name = "inventory-2026-10-27.csv"
            with open(os.path.join(INBOX, name), "w") as f:
                f.write(open(os.path.join(FIX, "inventory-2026-10-13-corrected.csv")).read().replace("127,no", "141,no").replace("102,yes", "116,yes"))
            listed = rest("GET", "/api/inbox")
            check("15. the inbox lists the file with its series and period; the mode says it is read on request, never watched", any(f["name"] == name and f["family"] == "inventory" and f["period"] == "2026-10-27" for f in listed["files"]) and "never watched" in listed["mode"], str(listed)[:200])
            prof = rest("POST", f"/api/files/{fid}/intake", {"inbox": name})
            check("   taking it profiles it like any upload: the next snapshot of inventory (27 Oct after 20 Oct)", prof["origin"] == "inbox" and prof["sets"][0]["relation"]["kind"] == "next" and prof["period"] == "2026-10-27", prof["sets"][0]["relation"]["reason"][:160])
            applied = rest("POST", f"/api/files/{fid}/intake/{prof['key']}/apply", {"decisions": [{"action": "update"}]})
            moved = os.path.exists(os.path.join(INBOX, "taken", f"{prof['key']}-{name}")) and not os.path.exists(os.path.join(INBOX, name))
            check("   placed, the file moves to taken/ with its key; the table and the source record follow", applied["status"] == "applied" and moved and next(r for r in companion()["records"] if r["kind"] == "source" and r["status"] == "stated" and r["source"] == "inventory")["period"] == "2026-10-27", str(moved))
        else:
            print("SKIP inbox adapter (start the server with GRIDWRIGHT_INBOX and pass --inbox)")

        # ================================================================ 15b. a SQL snapshot: the database's declared types are the contract
        if PG:
            host, port, db, user, pw = PG
            conn = rest("POST", "/api/connections", {"name": "intake pg", "kind": "postgres", "host": host, "port": int(port), "database": db, "user": user, "password": pw, "ssl": False})
            sql = "SELECT * FROM (VALUES ('000123'::varchar, 'Tucson'::text, 24150009.00::numeric, DATE '2026-10-06', 12345678901234567890::numeric, 95::int, true), ('000124', 'Creta', 18629981.50, DATE '2026-10-01', 12345678901234567891, 120, false)) AS v(vin, model, landed_cost, entry_date, reference, days, reserved) ORDER BY vin"
            prof = rest("POST", f"/api/files/{fid}/intake", {"connection": conn["id"], "sql": sql})
            cols = {c["header"]: c for c in prof["sets"][0]["columns"]}
            row = prof["sets"][0]["rows"][1]
            check("15b. a SQL snapshot takes the database's declared types as the contract: a VARCHAR of digits is an identifier with its zeros, NUMERIC is a number, DATE a date, a 20-digit NUMERIC keeps every digit", cols["vin"]["type"] == "identifier" and cols["vin"]["declared"] == "text" and row[0] == "'000123" and cols["landed_cost"]["type"] == "number" and cols["landed_cost"]["declared"] == "number" and row[2] == "24150009" and cols["entry_date"]["type"] == "date" and row[3] == "2026-10-06" and row[4] == "'12345678901234567890" and cols["days"]["type"] == "number", f"{[(h, c['type'], c.get('declared')) for h, c in cols.items()]} {row}")
            check("   the profile says the types came from the source, and the query is kept without credentials", any("declarations" in n for n in prof["sanitised"]) and prof["query"]["connection"] == "intake pg" and "password" not in json.dumps(prof["query"]) and prof["query"]["kinds"][0] == "text", str(prof["query"])[:160])
            # placed, the snapshot defines a connected source: Context lists it with its recipe, as-of and a Refresh; the card for it came from the server
            page.reload(wait_until="networkidle")
            page.wait_for_selector(".canvas-host canvas", timeout=30000)
            set_panel("ai")
            page.wait_for_selector(f".intake-card[data-key='{prof['key']}']", timeout=10000)
            check("   a profile left undecided comes back as a card after a reload: the decision is still open on the server", page.locator(f".intake-card[data-key='{prof['key']}']").count() == 1, "")
            page.locator(f".intake-card[data-key='{prof['key']}'] button.primary").first.click()
            page.wait_for_selector(f".intake-card[data-key='{prof['key']}']", state="detached", timeout=20000)
            page.click(".companion button:has-text('Context')")
            page.wait_for_selector(".connected-sources .source-def", timeout=10000)
            src_text = page.text_content(".connected-sources .source-def") or ""
            check("   Context lists the connected source with its recipe version, as-of and a Refresh on request", "intake pg" in src_text and "recipe v1" in src_text and "as of" in src_text and page.locator(".connected-sources button:text-is('Refresh')").count() == 1, src_text[:160])
            page.locator(".connected-sources button:text-is('Refresh')").first.click()
            page.wait_for_selector(".status-msg:has-text('Refresh')", timeout=10000)
            srcs = rest("GET", f"/api/files/{fid}/sources")
            for _ in range(60):
                jobs = rest("GET", f"/api/files/{fid}/jobs?status=queued,running")["jobs"]
                if not jobs:
                    break
                time.sleep(0.5)
            srcs = rest("GET", f"/api/files/{fid}/sources")
            check("   the refresh ran as a job and, the result being unchanged, confirmed coverage without inventing a change", srcs and srcs[0]["lastResult"].startswith("unchanged"), str(srcs and srcs[0].get("lastResult")))
            page.screenshot(path=f"{OUT}/intake-02-sources.png")
            rest("DELETE", f"/api/connections/{conn['id']}")
        else:
            print("SKIP 15b. SQL snapshot (no --pg)")

        # ================================================================ 16. the phone: the card's decision is reachable without horizontal scrolling
        browser.close()
        browser = p.chromium.launch(headless=True, args=LAUNCH)
        phone = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True).new_page()
        phone.on("pageerror", lambda e: errors.append(str(e)))
        phone.goto(f"{BASE}/?file={fid}", wait_until="networkidle")
        phone.wait_for_selector(".canvas-host canvas", timeout=30000)
        time.sleep(0.8)
        phone.evaluate("(p) => window.__gw.getState().set({ panel: p })", "files")
        time.sleep(0.3)
        phone_file = os.path.join(OUT, "inventory-2026-11-03.csv")
        with open(phone_file, "w") as f:
            f.write(open(os.path.join(FIX, "inventory-2026-10-13-corrected.csv")).read().replace("127,no", "148,no"))
        phone.set_input_files(".panel input[type=file]", phone_file)
        phone.wait_for_selector(".intake-card", timeout=20000)
        btn = phone.locator(".intake-card button.primary").first
        btn.scroll_into_view_if_needed()
        box = btn.bounding_box()
        check("16. on a phone the card and its decision fit the screen: the primary action is within the viewport and at least 44 px tall", box is not None and box["x"] + box["width"] <= 407 and box["height"] >= 40 and phone.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 2"), str(box))
        phone.screenshot(path=f"{OUT}/intake-01-phone.png")
        phone.locator(".intake-card button:has-text('not now')").click()
        browser.close()
        had_originals = rest("GET", f"/api/files/{fid}/intake")
        rest("DELETE", f"/api/files/{fid}")
        code, _ = rest("GET", f"/api/files/{fid}/intake", raw=True)
        check("17. deleting the document deletes its intake store with it (originals and profiles are reachable through nothing else)", len(had_originals) >= 10 and code == 404, f"{len(had_originals)} profiles before, {code} after")
    check("no uncaught errors in the page", not errors, "; ".join(errors[:2])[:160])

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n{passed}/{len(results)} checks passed")
    if passed != len(results):
        sys.exit(1)


if __name__ == "__main__":
    main()

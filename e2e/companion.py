#!/usr/bin/env python3
"""The companion (0.8.1): the simple loop — drop a file, one tap on a suggestion, drop next week's
file, read the brief — plus the gates behind it: context from successive snapshots with their
periods read from the file names, exclusions carried by the watches themselves, a change raised only
once it is sustained over comparable snapshots, one evolving issue, "not checked" ≠ "no issues", a
moved threshold as a decision, an agent's proposals ratified by a person, the graph and what a change
reaches, the LangGraph cycle, and the model's reading only on request.

Usage: python3 e2e/companion.py [http://localhost:8787] [--mock-llm http://127.0.0.1:8899/v1]
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
BASE = ARGS[0] if ARGS else "http://localhost:8787"
MOCK = None
for i, a in enumerate(sys.argv):
    if a == "--mock-llm":
        MOCK = sys.argv[i + 1]
OUT = os.environ.get("E2E_OUT", "/tmp/gridwright-e2e")
os.makedirs(OUT, exist_ok=True)
LAUNCH = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]


def rest(method, path, body=None, raw=False):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"content-type": "application/json", "accept": "application/json, text/event-stream"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
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


HEADER = "VIN,Model,Days in stock,Reserved,Landed cost\n"
SNAPSHOTS = {
    # 6 Oct: two available vehicles over 90 days (Tucson 120, Creta 95); the Golf has no landed cost
    "inventory-2026-10-06.csv": HEADER + "KMHJ381ABNU012345,Tucson,120,no,24150009\nKMHJ381ABNU012346,Tucson,95,yes,24150009\nKMHJ381ABNU012347,Creta,95,no,18629981\nWVWZZZ1KZBW123456,Golf,15,no,\nAHTEB3CD700012345,Hilux,60,no,540000000\n",
    # 13 Oct: three (the Hilux reaches 91); the reserved Tucson ages too but does not count; the Golf is costed
    "inventory-2026-10-13.csv": HEADER + "KMHJ381ABNU012345,Tucson,127,no,24150009\nKMHJ381ABNU012346,Tucson,102,yes,24150009\nKMHJ381ABNU012347,Creta,102,no,18629981\nWVWZZZ1KZBW123456,Golf,22,no,22785000\nAHTEB3CD700012345,Hilux,91,no,540000000\n",
    # 20 Oct: four (the Golf as well): rising for two snapshots running
    "inventory-2026-10-20.csv": HEADER + "KMHJ381ABNU012345,Tucson,134,no,24150009\nKMHJ381ABNU012346,Tucson,109,yes,24150009\nKMHJ381ABNU012347,Creta,109,no,18629981\nWVWZZZ1KZBW123456,Golf,91,no,22785000\nAHTEB3CD700012345,Hilux,98,no,540000000\n",
}


def main():
    results = []

    def check(name, ok, detail=""):
        results.append((name, ok, detail))
        print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))

    tmp = tempfile.mkdtemp(prefix="gw-snap-")
    paths = {}
    for name, text in SNAPSHOTS.items():
        paths[name] = os.path.join(tmp, name)
        with open(paths[name], "w") as f:
            f.write(text)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=LAUNCH)
        page = browser.new_context(viewport={"width": 1500, "height": 950}).new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        dialogs = []
        page.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_selector(".canvas-host canvas", timeout=30000)
        time.sleep(0.6)

        def state():
            return page.evaluate("() => { const s = window.__gw.getState(); return { fileId: s.fileId, attention: s.attention, panel: s.panel, tables: [...s.tables.values()].map((t) => ({ id: t.id, name: t.name, rows: t.rows, cols: t.cols })) }; }")

        def cell(t, r, c):
            return page.evaluate("([t,r,c]) => { const x = window.__gw.getState().cells.get(t)?.get(r*65536+c); return x ? x.i : null; }", [t, r, c])

        def set_panel(name):
            page.evaluate("(p) => window.__gw.getState().set({ panel: p })", name)
            time.sleep(0.3)

        def companion():
            return rest("GET", f"/api/files/{fid}/companion")

        def wait_companion(pred, timeout=10.0):
            deadline = time.time() + timeout
            c = companion()
            while time.time() < deadline and not pred(c):
                time.sleep(0.3)
                c = companion()
            return c

        def import_file(name):
            set_panel("files")
            page.set_input_files(".panel input[type=file]", paths[name])
            # a Playwright wait (not time.sleep) so the confirm dialog is delivered to the handler meanwhile
            page.wait_for_timeout(1500)

        def watch_named(c, part):
            return next((w for w in c["watches"] if part in w["def"]["purpose"]), None)

        # ------------------------------------------------------------------ drop the first file
        page.evaluate("() => window.__gw.book.apply({ type: 'delete_table', table: 1 })")
        page.click(".topbar .save-btn")
        page.wait_for_function("() => window.__gw.getState().fileId && !window.__gw.getState().dirty", timeout=8000)
        fid = state()["fileId"]
        import_file("inventory-2026-10-06.csv")
        st = state()
        inv = next((t for t in st["tables"] if t["name"] == "inventory"), None)
        check("a file becomes a table named after its series, not its date (inventory-2026-10-06.csv → inventory)", inv is not None and inv["rows"] == 6, str(st["tables"]))
        c = wait_companion(lambda c: any(r["kind"] == "source" for r in c["records"]))
        src = next(r for r in c["records"] if r["kind"] == "source")
        check("the snapshot is recorded with its period read from the file name and its series as the source", src["period"] == "2026-10-06" and src["source"] == "inventory" and src["links"] == [{"table": inv["id"]}], json.dumps(src)[:160])
        set_panel("ai")
        page.wait_for_selector(".companion .brief", timeout=8000)
        refl = page.text_content(".companion .reflection") or ""
        check("the reflection says what was linked and for which period", "linked to inventory" in refl and "period 2026-10-06" in refl, refl[:140])

        # ------------------------------------------------------------------ one tap: the companion proposes what to watch
        page.click(".companion button:has-text('Watching')")
        page.wait_for_selector(".suggestion", timeout=8000)
        sgs = page.locator(".suggestion").all_text_contents()
        check("watches are proposed from the columns, in plain words: ageing (excluding reserved), missing landed cost, duplicate VINs, total", any("Vehicles over 90 days (excl. reserved)" in s for s in sgs) and any("Vehicles with no landed cost" in s for s in sgs) and any("Duplicate VINs" in s for s in sgs) and any("Total landed cost" in s for s in sgs), str(sgs)[:300])
        page.locator(".suggestion", has_text="over 90 days").locator("button").click()
        time.sleep(0.8)
        page.locator(".suggestion", has_text="no landed cost").locator("button").click()
        time.sleep(0.8)
        c = wait_companion(lambda c: len(c["watches"]) == 2)
        ageing = watch_named(c, "over 90 days")
        blanks = watch_named(c, "no landed cost")
        check("one tap makes an approved watch with a generated formula; nothing was typed", ageing and ageing["authority"] == "approved" and ageing["def"]["kind"] == "worsening" and "COUNTIFS" in ageing["def"]["formula"] and '"no"' in ageing["def"]["formula"], str(ageing and ageing["def"]))
        check("the first snapshot gives a first observation with its period; the companion waits for the next snapshot before saying more", ageing["observations"][-1]["value"] == 2 and ageing["observations"][-1]["period"] == "2026-10-06" and ageing["health"] == "baseline", f"{ageing['health']} {ageing['observations']}")
        check("a data-quality watch speaks at once: one vehicle has no landed cost", blanks["health"] == "attention" and blanks["issue"]["status"] == "open" and "1" in blanks["issue"]["summary"], blanks.get("issue", {}).get("summary"))
        words = page.text_content(".watch-item") or ""
        check("the watch is shown in words — value, period, rule — with formulas behind 'details'", "2 (2026-10-06)" in words and "rising snapshot after snapshot" in words and "COUNTIFS" not in words, words[:200])

        # ------------------------------------------------------------------ drop next week's file: same table, formulas and watches kept
        import_file("inventory-2026-10-13.csv")
        check("a file with the same columns asks to update the table (OK = same table, formulas and watches kept)", len(dialogs) == 1 and "update inventory" in dialogs[0] and "period 2026-10-13" in dialogs[0], str(dialogs))
        st = state()
        check("the table was updated in place: same id, new values, still one table", len(st["tables"]) == 1 and st["tables"][0]["id"] == inv["id"] and cell(inv["id"], 5, 2) == "91", str(st["tables"]))
        c = wait_companion(lambda c: len([o for o in watch_named(c, "over 90 days")["observations"]]) >= 2)
        ageing = watch_named(c, "over 90 days")
        srcs = [r for r in c["records"] if r["kind"] == "source"]
        check("the new snapshot supersedes the old one in the context, with its own period", len(srcs) == 2 and srcs[0]["status"] == "superseded" and srcs[1]["period"] == "2026-10-13" and srcs[1]["status"] == "stated", str([(r["period"], r["status"]) for r in srcs]))
        check("one comparable observation per snapshot; the reserved vehicle ageing past 90 days does not count: 3, not 4", ageing["observations"][-1]["value"] == 3 and ageing["observations"][-1]["period"] == "2026-10-13" and ageing["observations"][-1]["breach"], str(ageing["observations"][-1]))
        check("one worsening is worth a look, not yet an issue", ageing["health"] == "baseline" and not ageing.get("issue") and any("3 (was 2 on 2026-10-06), worse" in e["text"] and "watching for another snapshot" in e["text"] for e in c["events"]), str([e["text"] for e in c["events"]][-3:]))
        blanks = watch_named(c, "no landed cost")
        set_panel("none")
        set_panel("ai")
        page.wait_for_selector(".companion .brief", timeout=8000)
        lead = page.text_content(".companion .companion-lead") or ""
        changed = page.text_content(".companion .brief") or ""
        check("the brief says what moved between snapshots, in business terms, without formulas or bookkeeping", "3 (was 2 on 2026-10-06), worse" in changed and "no landed cost" in changed and "COUNTIFS" not in changed and "reassessing" not in changed, changed[:300])
        page.screenshot(path=f"{OUT}/companion-00-brief.png")

        # ------------------------------------------------------------------ the third snapshot: sustained, now an issue
        import_file("inventory-2026-10-20.csv")
        c = wait_companion(lambda c: watch_named(c, "over 90 days")["observations"][-1]["value"] == 4 and watch_named(c, "over 90 days")["health"] == "attention")
        ageing = watch_named(c, "over 90 days")
        check("rising for two snapshots running: now an issue, one, with the three snapshots as evidence", ageing["health"] == "attention" and ageing["issue"]["revision"] == 1 and ageing["issue"]["evidence"] == ["2026-10-06: 2", "2026-10-13: 3", "2026-10-20: 4"] and "rising for 2 snapshots running" in ageing["issue"]["summary"], str(ageing["issue"])[:240])
        check("the missing landed cost was costed in the 13 Oct snapshot and resolved after two snapshots back within bounds", watch_named(c, "no landed cost")["health"] == "ok" and not watch_named(c, "no landed cost").get("issue") and len(watch_named(c, "no landed cost")["history"]) == 1, str(watch_named(c, "no landed cost")["health"]))
        page.wait_for_function("() => window.__gw.getState().attention === 1", timeout=8000)
        check("the Ask button carries the count", page.text_content(".topbar button .count") == "1", page.text_content(".topbar button .count"))
        issue_id = ageing["issue"]["id"]

        # ------------------------------------------------------------------ what matters, in two boxes
        set_panel("ai")
        page.wait_for_selector(".companion .brief", timeout=8000)
        page.click(".companion button:has-text('Context')")
        page.wait_for_selector(".companion-section input", timeout=5000)
        page.fill(".companion-section input[placeholder^='What matters']", "preserve replacement-cost margin on every disposal")
        page.keyboard.press("Enter")
        time.sleep(0.6)
        page.fill(".companion-section input[placeholder^='What to leave out']", "customer-reserved vehicles in inventory")
        page.keyboard.press("Enter")
        time.sleep(0.8)
        c = companion()
        kinds = {r["kind"]: r for r in c["records"]}
        check("what matters and what to leave out are two boxes; both recorded as the person's words", kinds.get("objective", {}).get("status") == "stated" and kinds.get("exclusion", {}).get("status") == "stated", str(sorted(kinds)))
        page.fill(".ai-panel textarea", "Decision: hold the Creta until the December campaign")
        page.keyboard.press("Enter")
        time.sleep(0.8)
        check("a statement typed into the chat is recorded, not asked", any(r["kind"] == "decision" for r in companion()["records"]) and page.locator(".ai-panel .msg").count() == 0, "")

        # ------------------------------------------------------------------ the graph: tables are the nodes
        g = rest("GET", f"/api/files/{fid}/companion/graph?changed=table:{inv['id']}")
        edge_kinds = {(e["from"].split(":")[0], e["type"], e["to"].split(":")[0]) for e in g["edges"]}
        check("the graph: the table, its snapshots, the records and the watches, with edges read off the workbook and the context", {("table", "fed_by", "source"), ("watch", "watches", "table"), ("record", "constrains", "watch"), ("watch", "raises", "issue"), ("source", "supersedes", "source"), ("record", "excludes", "table")} <= edge_kinds, str(sorted(edge_kinds)))
        check("a change to inventory reaches both watches", len(g["affected"]["watches"]) == 2, str(g["affected"]))
        check("the activity (not the brief) names what was reassessed when the table changed", any(e["kind"] == "trace" and "inventory changed" in e["text"] and "reassessing" in e["text"] for e in c["events"]), "")

        # ------------------------------------------------------------------ the cycle as a LangGraph workflow
        try:
            import langgraph  # noqa: F401

            here = os.path.dirname(os.path.abspath(__file__))
            out = subprocess.run([sys.executable, os.path.join(here, "..", "integrations", "langgraph", "companion_graph.py"), BASE, fid, "--changed", f"table:{inv['id']}", "--json"], capture_output=True, text=True, timeout=120)
            lg = json.loads(out.stdout) if out.returncode == 0 else {}
            check("the LangGraph workflow (ingest → recheck → assess → brief) runs over the graph: attention, one case for the open issue", out.returncode == 0 and lg.get("level") == "attention" and len(lg["affected"]["watches"]) == 2 and len(lg["cases"]) == 1, (out.stderr or out.stdout)[-200:])
        except ImportError:
            print("SKIP LangGraph workflow (pip install langgraph)")

        # ------------------------------------------------------------------ the person challenges it: a threshold instead
        moved = rest("PUT", f"/api/files/{fid}/companion/watches/{ageing['id']}", {"def": {"kind": "threshold", "op": ">", "value": 5}, "reason": "five is the usual carry-over before the December campaign"})
        c = companion()
        decision = [r for r in c["records"] if r["kind"] == "decision" and "carry-over" in r["text"]]
        check("changing the rule is a recorded decision with a name and a reason; the old issue closes and the baseline restarts", moved.get("issue") is None and len(moved["history"]) == 1 and len(decision) == 1 and decision[0]["by"]["name"] and moved["observations"][-1]["def"] != ageing["observations"][-1]["def"], f"{moved['health']} {decision and decision[0]['text']}")

        # ------------------------------------------------------------------ not checked ≠ no issues
        w3 = rest("POST", f"/api/files/{fid}/companion/watches", {"purpose": "Reserved share", "formula": '=COUNTIF(inventory[Reserved], "yes") / COUNTA(inventory[VIN])', "kind": "threshold", "op": ">", "value": 0.5, "sources": ["inventory"], "freshnessHours": 0.00001})
        c = companion()
        check("a stale essential source suspends the conclusion: 'not checked', distinct from 'fine'", w3["health"] == "stale" and any(m.startswith("Not checked") for m in c["brief"]["matters"]), w3["health"])
        rest("DELETE", f"/api/files/{fid}/companion/watches/{w3['id']}")

        # ------------------------------------------------------------------ an agent proposes; a person ratifies
        rem, err = mcp("remember", {"id": fid, "kind": "hypothesis", "text": "Higher freight on SH-001 may explain part of the margin deterioration", "source": "agent reading of purchase-invoices-sept.xlsx"})
        pw, err2 = mcp("propose_watch", {"id": fid, "purpose": "Replacement-cost margin floor", "formula": "=MIN(inventory[Landed cost])", "kind": "threshold", "op": "<", "value": 1000000})
        c = companion()
        hyp = next((r for r in c["records"] if r["kind"] == "hypothesis"), None)
        prop = next((x for x in c["watches"] if x["id"] == pw.get("watch")), None)
        check("an agent's record is proposed, not stated; its watch is proposed, not approved, and not evaluated", not err and not err2 and hyp and hyp["status"] == "proposed" and prop and prop["authority"] == "proposed" and prop["observations"] == [], f"{hyp and hyp['status']} / {prop and prop['authority']}")
        set_panel("none")
        set_panel("ai")
        page.wait_for_selector(".companion .brief", timeout=8000)
        page.click(".companion button:has-text('Context')")
        page.wait_for_selector(".ctx-item.proposed", timeout=5000)
        page.click(".ctx-item.proposed button:has-text('confirm')")
        time.sleep(0.6)
        page.click(".companion button:has-text('Watching')")
        page.wait_for_selector(".watch-item.proposed", timeout=5000)
        page.click(".watch-item.proposed button:has-text('Approve')")
        time.sleep(0.8)
        c = companion()
        check("a person confirms and approves from the panel; the approved watch is then evaluated", next(r for r in c["records"] if r["kind"] == "hypothesis")["status"] == "confirmed" and next(x for x in c["watches"] if x["id"] == pw["watch"])["authority"] == "approved" and len(next(x for x in c["watches"] if x["id"] == pw["watch"])["observations"]) >= 1, "")
        att, _ = mcp("list_attention", {"id": fid})
        check("MCP exposes the attention gate for a decision-case system", isinstance(att["issues"], list) and "brief" in att, "")

        # ------------------------------------------------------------------ the model only on request
        if MOCK:
            rest("PUT", "/api/ai/settings", {"baseUrl": MOCK, "model": "mock"})
            # reopen an issue to interpret: the agent's margin-floor watch breaches at once (min landed cost 18.6 m is not < 1 m... so use the duplicates suggestion instead)
            dup = rest("POST", f"/api/files/{fid}/companion/watches", {"purpose": "inventory: duplicate VIN", "formula": "=COUNTA(inventory[VIN]) - COUNTUNIQUE(inventory[VIN])", "kind": "threshold", "op": ">", "value": -1, "sustain": 1})
            interp = rest("POST", f"/api/files/{fid}/companion/interpret/{dup['issue']['id']}")
            check("the interpretation is stored on the issue with the model id and the revision it describes", interp.get("interpretation", {}).get("model") == "mock" and interp["interpretation"]["revision"] == interp["revision"], str(interp.get("interpretation"))[:120])
            page.wait_for_selector(".watch-item .interpretation", timeout=8000)
            check("the panel shows the model's reading labelled as its words, beside the evidence", "model's reading" in (page.text_content(".watch-item .interpretation") or ""), "")
            rest("DELETE", f"/api/files/{fid}/companion/watches/{dup['id']}")
        else:
            print("SKIP interpretation (no --mock-llm)")
        page.screenshot(path=f"{OUT}/companion-01.png")
        browser.close()
        rest("DELETE", f"/api/files/{fid}")
        code, _ = rest("GET", f"/api/files/{fid}/companion", raw=True)
        check("deleting the document deletes its companion state", code == 404, str(code))
        void = issue_id
        del void
    check("no uncaught errors in the page", not errors, "; ".join(errors[:2])[:160])

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n{passed}/{len(results)} checks passed")
    if passed != len(results):
        sys.exit(1)


if __name__ == "__main__":
    main()

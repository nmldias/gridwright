#!/usr/bin/env python3
"""The companion (0.8): one evolving inventory case, from the first piece of information onwards.

Builds context from successive additions (an inventory snapshot, cost records, an objective, an
exclusion), remembers the exclusion in what it watches, detects a relevant change only once it is
sustained over comparable observations, keeps one evolving issue rather than ten alerts, tells
"no material issues" apart from "not checked: stale source", records a moved threshold as a
decision with a name on it, keeps an agent's records and watches as proposals until a person
confirms them, exposes the graph of tables with the edges a change reaches, and asks the model to
interpret an issue only on request — its words stored as its own.

Usage: python3 e2e/companion.py [http://localhost:8787] [--mock-llm http://127.0.0.1:8899/v1]
"""
import json
import os
import subprocess
import sys
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


INVENTORY = [
    ["VIN", "Model", "Days in stock", "Reserved", "Landed cost"],
    ["KMHJ381ABNU012345", "Tucson", "120", "no", "24150009"],
    ["KMHJ381ABNU012346", "Tucson", "95", "yes", "24150009"],
    ["KMHJ381ABNU012347", "Creta", "40", "no", "18629981"],
    ["WVWZZZ1KZBW123456", "Golf", "15", "no", ""],
    ["AHTEB3CD700012345", "Hilux", "60", "no", "540000000"],
]


def main():
    results = []

    def check(name, ok, detail=""):
        results.append((name, ok, detail))
        print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=LAUNCH)
        page = browser.new_context(viewport={"width": 1500, "height": 950}).new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_selector(".canvas-host canvas", timeout=30000)
        time.sleep(0.6)

        def state():
            return page.evaluate("() => { const s = window.__gw.getState(); return { fileId: s.fileId, attention: s.attention, panel: s.panel, tables: [...s.tables.values()].map((t) => ({ id: t.id, name: t.name })) }; }")

        def apply(op):
            return page.evaluate("(op) => window.__gw.book.apply(op)", op)

        def set_panel(name):
            page.evaluate("(p) => window.__gw.getState().set({ panel: p })", name)
            time.sleep(0.3)

        def companion():
            return rest("GET", f"/api/files/{fid}/companion")

        def wait_companion(pred, timeout=8.0):
            deadline = time.time() + timeout
            c = companion()
            while time.time() < deadline and not pred(c):
                time.sleep(0.3)
                c = companion()
            return c

        # ------------------------------------------------------------------ first piece of information: a snapshot
        # the sample table becomes the inventory; an import would create the same 'source' record (recordImport)
        apply({"type": "rename_table", "table": 1, "name": "Inventory"})
        apply({"type": "set_cells", "table": 1, "row": 0, "col": 0, "values": INVENTORY})
        apply({"type": "resize_table", "table": 1, "rows": 6, "cols": 5})
        page.click(".topbar .save-btn")
        page.wait_for_function("() => window.__gw.getState().fileId && !window.__gw.getState().dirty", timeout=8000)
        fid = state()["fileId"]
        set_panel("ai")
        page.wait_for_selector(".companion", timeout=5000)
        page.wait_for_function("() => !!document.querySelector('.companion .brief')", timeout=8000)
        lead = page.text_content(".companion .companion-lead") or ""
        check("with nothing watched the brief says so, calmly", lead == "All quiet" and "Nothing is being watched yet" in (page.text_content(".companion .brief") or ""), lead)
        src = rest("POST", f"/api/files/{fid}/companion/records", {"kind": "source", "text": "Imported inventory-2026-10-06.xlsx: 5 rows into Inventory (fields: VIN, Model, Days in stock, Reserved, Landed cost)", "source": "inventory-2026-10-06.xlsx", "links": [{"table": 1}]})
        check("an added snapshot is a source record with its file, its table and no period yet (arrival is not the period)", src["kind"] == "source" and src["status"] == "stated" and src.get("period") is None and src["links"] == [{"table": 1}], json.dumps(src)[:160])

        # ------------------------------------------------------------------ what matters, in the person's words
        page.fill(".ai-panel textarea", "Objective: preserve replacement-cost margin on every disposal")
        page.keyboard.press("Enter")
        time.sleep(0.6)
        page.fill(".ai-panel textarea", "Exclude: customer-reserved vehicles in Inventory from the disposal analysis")
        page.keyboard.press("Enter")
        time.sleep(0.8)
        c = companion()
        kinds = {r["kind"]: r for r in c["records"]}
        check("a statement typed into Ask is recorded, not asked: an objective and an exclusion with status stated", kinds.get("objective", {}).get("status") == "stated" and "replacement-cost margin" in kinds.get("objective", {}).get("text", "") and kinds.get("exclusion", {}).get("status") == "stated", str(list(kinds)))
        refl = page.text_content(".companion .reflection") or ""
        check("a small, correctable reflection shows what was recorded", "Recorded exclusion" in refl and "correct" in refl and "remove" in refl, refl[:120])
        check("the chat did not go to the model for a statement", page.locator(".ai-panel .msg").count() == 0, "")
        time.sleep(0.5)

        # ------------------------------------------------------------------ second source: costs, a contradiction noticed
        rest("POST", f"/api/files/{fid}/companion/records", {"kind": "source", "text": "Imported purchase-invoices-sept.xlsx: 4 rows into Costs", "source": "purchase-invoices-sept.xlsx", "period": "2026-09"})
        rest("POST", f"/api/files/{fid}/companion/records", {"kind": "contradiction", "text": "Invoice INV-2201 states freight 4,200 for shipment SH-001; the Inventory sheet carries 3,900", "source": "purchase-invoices-sept.xlsx vs Inventory"})
        src2 = rest("POST", f"/api/files/{fid}/companion/records", {"kind": "source", "text": "Imported inventory-2026-10-09.xlsx: 5 rows into Inventory", "source": "inventory-2026-10-06.xlsx", "links": [{"table": 1}]})
        c = companion()
        old = next(r for r in c["records"] if r["id"] == src["id"])
        check("a newer snapshot of the same source supersedes the older one (by source, not by arrival)", old["status"] == "superseded" and old["supersededBy"] == src2["id"], old["status"])
        check("facts, objectives, hypotheses, contradictions and decisions stay distinct kinds, not one narrative", sorted({r["kind"] for r in c["records"]}) == ["contradiction", "exclusion", "objective", "source"], str(sorted({r["kind"] for r in c["records"]})))

        # ------------------------------------------------------------------ what to watch: the exclusion is in the formula
        w = rest("POST", f"/api/files/{fid}/companion/watches", {"purpose": "Vehicles over 90 days in stock", "scope": "available vehicles; customer-reserved excluded", "formula": '=COUNTIFS(Inventory[Days in stock], ">90", Inventory[Reserved], "no")', "kind": "threshold", "op": ">", "value": 1, "sustain": 2, "response": "case", "sources": ["Inventory"], "freshnessHours": 24})
        check("a person's watch is approved at once and checked: one comparable observation, baseline building", w["authority"] == "approved" and w["health"] == "baseline" and len(w["observations"]) == 1 and w["observations"][0]["value"] == 1, f"{w['health']} {w['observations']}")
        w2 = rest("POST", f"/api/files/{fid}/companion/watches", {"purpose": "Vehicles with incomplete landed cost", "scope": "all vehicles", "formula": "=COUNTBLANK(Inventory[Landed cost])", "kind": "threshold", "op": ">", "value": 0, "sustain": 1, "response": "brief"})
        check("a watch with sustain 1 reports on the first breach: one vehicle has no landed cost", w2["health"] == "attention" and w2["issue"]["status"] == "open" and "1 > 0" in w2["issue"]["summary"], w2.get("issue", {}).get("summary"))
        c = companion()
        check("the brief leads with why it matters and what to do, the Ask button carries the count", any("incomplete landed cost" in m for m in c["brief"]["matters"]) and any("Investigate" in n for n in c["brief"]["next"]) and c["brief"]["health"]["attention"] == 1, str(c["brief"]["matters"]))
        page.wait_for_function("() => window.__gw.getState().attention === 1", timeout=8000)
        check("the Ask button shows the attention count, pushed by the server", page.text_content(".topbar button .count") == "1", page.text_content(".topbar button .count"))

        # ------------------------------------------------------------------ the graph: tables are the nodes
        g = rest("GET", f"/api/files/{fid}/companion/graph?changed=table:1")
        ids = {n["id"] for n in g["nodes"]}
        kinds_of_edges = {(e["from"].split(":")[0], e["type"], e["to"].split(":")[0]) for e in g["edges"]}
        check("the graph has the table, its sources, the records and the watches as nodes", "table:1" in ids and f"source:{src2['id']}" in ids and any(i.startswith("watch:") for i in ids) and any(i.startswith("record:") for i in ids), str(sorted(ids))[:200])
        check("edges are read off the workbook and the context: fed_by, watches, about/excludes, constrains, raises, supersedes", {("table", "fed_by", "source"), ("watch", "watches", "table"), ("record", "constrains", "watch"), ("watch", "raises", "issue"), ("source", "supersedes", "source")} <= kinds_of_edges, str(sorted(kinds_of_edges)))
        check("a change to Inventory reaches both watches and the records about it", len(g["affected"]["watches"]) == 2 and any(e["type"] == "excludes" and e["to"] == "table:1" for e in g["edges"]), str(g["affected"]))

        # ------------------------------------------------------------------ a relevant change, detected only when sustained
        apply({"type": "set_cell", "table": 1, "row": 3, "col": 2, "input": "100"})  # Creta now 100 days, available
        c = wait_companion(lambda c: len(next(x for x in c["watches"] if x["id"] == w["id"])["observations"]) >= 2)
        w_now = next(x for x in c["watches"] if x["id"] == w["id"])
        check("the change is observed after the edit (debounced check from the audit log): value 2 — one breach is not yet a pattern, so no issue", w_now["observations"][-1]["value"] == 2 and w_now["observations"][-1]["breach"] and w_now["health"] == "ok" and not w_now.get("issue"), f"{w_now['health']} {[o['value'] for o in w_now['observations']]}")
        check("Inventory changed → the activity names what was reassessed", any("Inventory changed" in e["text"] and "reassessing" in e["text"] for e in c["events"]), str([e["text"] for e in c["events"]][-4:]))
        # the reserved vehicle going over 90 days does not count: the exclusion is remembered — but the breach is now sustained
        apply({"type": "set_cell", "table": 1, "row": 2, "col": 2, "input": "130"})
        c = wait_companion(lambda c: next(x for x in c["watches"] if x["id"] == w["id"])["observations"][-1]["seq"] > w_now["observations"][-1]["seq"])
        w_now2 = next(x for x in c["watches"] if x["id"] == w["id"])
        check("a reserved vehicle ageing past 90 days changes nothing: the exclusion is in what is watched (value still 2)", w_now2["observations"][-1]["value"] == 2, str(w_now2["observations"][-1]))
        check("the breach, sustained over 2 comparable observations, now needs attention: one issue opened", w_now2["health"] == "attention" and w_now2.get("issue", {}).get("status") == "open" and w_now2["issue"]["revision"] == 1, f"{w_now2['health']}")
        issue_id = w_now2["issue"]["id"]
        check("the issue carries evidence with dates and revisions, the scope as uncertainty, and the response as next step", len(w_now2["issue"]["evidence"]) >= 2 and any("customer-reserved excluded" in u for u in w_now2["issue"]["uncertainty"]) and "decision case" in w_now2["issue"]["next"], str(w_now2["issue"])[:200])
        page.wait_for_function("() => window.__gw.getState().attention === 2", timeout=8000)
        page.screenshot(path=f"{OUT}/companion-00-brief.png")
        # one issue, evolving — not ten alerts
        apply({"type": "set_cell", "table": 1, "row": 4, "col": 2, "input": "91"})  # Golf now over 90 too
        c = wait_companion(lambda c: next(x for x in c["watches"] if x["id"] == w["id"])["observations"][-1]["value"] == 3)
        w_now3 = next(x for x in c["watches"] if x["id"] == w["id"])
        check("a further deterioration strengthens the same issue (revision 2) instead of raising another", w_now3["issue"]["id"] == issue_id and w_now3["issue"]["revision"] == 2 and len([x for x in c["watches"] if x.get("issue")]) == 2 and sum(1 for e in c["events"] if e["kind"] == "issue" and "Strengthened" in e["text"]) == 1, f"revision {w_now3['issue']['revision']}")
        check("comparable observations only: every observation carries the definition it was made under", len({o["def"] for o in w_now3["observations"]}) == 1, "")

        # ------------------------------------------------------------------ the cycle as a LangGraph workflow over the graph
        try:
            import langgraph  # noqa: F401

            here = os.path.dirname(os.path.abspath(__file__))
            out = subprocess.run([sys.executable, os.path.join(here, "..", "integrations", "langgraph", "companion_graph.py"), BASE, fid, "--changed", "table:1", "--json"], capture_output=True, text=True, timeout=120)
            lg = json.loads(out.stdout) if out.returncode == 0 else {}
            check("the LangGraph workflow (ingest → recheck → assess → brief) runs over the graph: the change reaches both watches, the gate says attention, one case per open issue", out.returncode == 0 and lg.get("level") == "attention" and len(lg["affected"]["watches"]) == 2 and len(lg["cases"]) == 2 and all("revision" in c for c in lg["cases"]), (out.stderr or out.stdout)[-200:])
        except ImportError:
            print("SKIP LangGraph workflow (pip install langgraph)")

        # ------------------------------------------------------------------ the person challenges it: moves the threshold
        moved = rest("PUT", f"/api/files/{fid}/companion/watches/{w['id']}", {"def": {"value": 3}, "reason": "three is the usual seasonal carry-over before the December campaign"})
        c = companion()
        decision = [r for r in c["records"] if r["kind"] == "decision"]
        check("a moved threshold is a decision with a name and a reason, never a silent normalisation; the baseline restarts and the old issue closes", moved["health"] in ("baseline", "unchecked", "ok") and len(moved["observations"]) >= 1 and moved["observations"][-1]["def"] != w_now3["observations"][-1]["def"] and moved.get("issue") is None and len(moved["history"]) == 1 and len(decision) == 1 and "seasonal" in decision[0]["text"] and decision[0]["by"]["name"], f"{moved['health']} {decision[0]['text'] if decision else ''}")
        check("the brief says a baseline is being built — a valid state, not a failure", any("building a baseline" in m for m in c["brief"]["matters"]) or c["brief"]["health"]["baseline"] >= 1, str(c["brief"]["matters"]))

        # ------------------------------------------------------------------ monitoring health: stale is not "no issues"
        w3 = rest("POST", f"/api/files/{fid}/companion/watches", {"purpose": "Reserved share", "formula": '=COUNTIF(Inventory[Reserved], "yes") / COUNTA(Inventory[VIN])', "kind": "threshold", "op": ">", "value": 0.5, "sources": ["Inventory"], "freshnessHours": 0.00001})
        check("an essential source older than allowed suspends the conclusion: health 'stale', distinct from 'within bounds'", w3["health"] == "stale" and w3["observations"][-1]["fresh"] is False, w3["health"])
        c = companion()
        check("the brief distinguishes 'not checked: source stale' from 'no material issues'", any(m.startswith("Not checked") for m in c["brief"]["matters"]) and any("Refresh Inventory" in n for n in c["brief"]["next"]), str(c["brief"]["matters"]))
        rest("DELETE", f"/api/files/{fid}/companion/watches/{w3['id']}")

        # ------------------------------------------------------------------ an agent proposes; a person ratifies
        rem, err = mcp("remember", {"id": fid, "kind": "hypothesis", "text": "Higher freight on SH-001 may explain part of the margin deterioration", "source": "agent reading of purchase-invoices-sept.xlsx"})
        pw, err2 = mcp("propose_watch", {"id": fid, "purpose": "Replacement-cost margin floor", "formula": "=MIN(Inventory[Landed cost])", "kind": "threshold", "op": "<", "value": 1000000})
        c = companion()
        hyp = next((r for r in c["records"] if r["kind"] == "hypothesis"), None)
        prop = next((x for x in c["watches"] if x["id"] == pw.get("watch")), None)
        check("an agent's record is proposed, not stated; its watch is proposed, not approved, and is not evaluated", not err and not err2 and hyp and hyp["status"] == "proposed" and hyp["origin"] == "agent" and prop and prop["authority"] == "proposed" and prop["health"] == "proposed" and prop["observations"] == [], f"{hyp and hyp['status']} / {prop and prop['authority']}")
        check("the brief asks for the person's input on proposals", any("proposed watch" in n for n in c["brief"]["next"]) and any("proposed by an agent" in n for n in c["brief"]["next"]), str(c["brief"]["next"]))
        # in the panel: confirm the hypothesis, approve the watch
        page.evaluate("() => window.__gw.getState().set({ panel: 'none' })")
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
        hyp = next(r for r in c["records"] if r["kind"] == "hypothesis")
        prop = next(x for x in c["watches"] if x["id"] == pw["watch"])
        check("a person confirms the hypothesis and approves the watch from the panel; the approved watch is then evaluated", hyp["status"] == "confirmed" and prop["authority"] == "approved" and len(prop["observations"]) >= 1, f"{hyp['status']} / {prop['authority']} {prop['health']}")
        ctx, _ = mcp("read_context", {"id": fid})
        att, _ = mcp("list_attention", {"id": fid})
        check("MCP exposes the context and the attention gate for a decision-case system", any(r["kind"] == "objective" for r in ctx["records"]) and isinstance(att["issues"], list) and "brief" in att, str(att)[:120])

        # ------------------------------------------------------------------ interpretation: the model only on request, its words as its own
        w2_now = next(x for x in c["watches"] if x["id"] == w2["id"])
        if MOCK:
            rest("PUT", "/api/ai/settings", {"baseUrl": MOCK, "model": "mock"})
            interp = rest("POST", f"/api/files/{fid}/companion/interpret/{w2_now['issue']['id']}")
            check("the interpretation is stored on the issue with the model id and the revision it describes", interp.get("interpretation", {}).get("model") == "mock" and interp["interpretation"]["revision"] == interp["revision"] and len(interp["interpretation"]["text"]) > 10, str(interp.get("interpretation"))[:120])
            page.wait_for_selector(".watch-item .interpretation", timeout=8000)
            check("the panel shows the model's reading labelled as its words, beside the deterministic evidence", page.locator(".watch-item .interpretation").count() >= 1 and "model's reading" in (page.text_content(".watch-item .interpretation") or "") and page.locator(".watch-item .issue b:has-text('Evidence')").count() >= 1, "")
        else:
            print("SKIP interpretation (no --mock-llm)")

        # ------------------------------------------------------------------ resolution
        apply({"type": "set_cell", "table": 1, "row": 4, "col": 4, "input": "22785000"})  # the Golf gets a landed cost
        c = wait_companion(lambda c: next(x for x in c["watches"] if x["id"] == w2["id"]).get("issue") is None, timeout=10)
        w2_end = next(x for x in c["watches"] if x["id"] == w2["id"])
        if w2_end.get("issue"):
            # one observation back within bounds is not enough: a second comparable one is needed
            apply({"type": "set_cell", "table": 1, "row": 4, "col": 1, "input": "Golf GTI"})
            c = wait_companion(lambda c: next(x for x in c["watches"] if x["id"] == w2["id"]).get("issue") is None, timeout=10)
            w2_end = next(x for x in c["watches"] if x["id"] == w2["id"])
        check("back within bounds on two comparable observations resolves the issue into the watch's history", w2_end.get("issue") is None and len(w2_end["history"]) == 1 and w2_end["history"][0]["status"] == "resolved" and w2_end["health"] == "ok", f"{w2_end['health']} {len(w2_end['history'])}")
        page.screenshot(path=f"{OUT}/companion-01.png")
        browser.close()
        rest("DELETE", f"/api/files/{fid}")
        code, _ = rest("GET", f"/api/files/{fid}/companion", raw=True)
        check("deleting the document deletes its companion state", code == 404, str(code))
    check("no uncaught errors in the page", not errors, "; ".join(errors[:2])[:160])

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n{passed}/{len(results)} checks passed")
    if passed != len(results):
        sys.exit(1)


if __name__ == "__main__":
    main()

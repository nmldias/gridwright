#!/usr/bin/env python3
"""The situation (0.9.0): the journey from the brief — add information → a correctable
understanding → investigate with scoped tools → accept steering → reassess genuine updates →
review material changes — run as the evaluation the concept note asks for: a sequence of messy
information with facts withheld until the right moment, the seven test situations, and the
measures (interruptions, repeated explanations, missed issues, verification effort, time to a
decision-ready position). Synthetic data only.

Usage: python3 e2e/situation.py [http://localhost:8787] [--mock-llm http://127.0.0.1:8899/v1]
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


HEADER = "VIN,Model,Days in stock,Reserved,Landed cost\n"
FILES = {
    # 6 Oct: two available vehicles over 90 days; one reserved over 90; the Golf has no landed cost; nothing over 120
    "inventory-2026-10-06.csv": HEADER + "KMHJ381ABNU012345,Tucson,120,no,24150009\nKMHJ381ABNU012346,Tucson,95,yes,24150009\nKMHJ381ABNU012347,Creta,95,no,18629981\nWVWZZZ1KZBW123456,Golf,15,no,\nAHTEB3CD700012345,Hilux,60,no,540000000\n",
    # invoices, 15 Oct: the Tucson's landed cost disagrees with the inventory; no invoice for shipment SH-001
    "invoices-2026-10-15.csv": "Invoice,VIN,Landed cost,Shipment\nF-1001,KMHJ381ABNU012345,25000000,SH-002\nF-1002,KMHJ381ABNU012347,18629981,SH-002\n",
    # 13 Oct: the headline (available over 90) is flat at 2, but the reserved population over 90 doubled; the Tucson passes 120; the Golf is costed
    "inventory-2026-10-13.csv": HEADER + "KMHJ381ABNU012345,Tucson,127,no,24150009\nKMHJ381ABNU012346,Tucson,102,yes,24150009\nKMHJ381ABNU012347,Creta,102,no,18629981\nWVWZZZ1KZBW123456,Golf,95,yes,22785000\nAHTEB3CD700012345,Hilux,67,no,540000000\n",
    # invoices, 22 Oct: the SH-001 invoice arrives; the Tucson's cost now agrees
    "invoices-2026-10-22.csv": "Invoice,VIN,Landed cost,Shipment\nF-1001,KMHJ381ABNU012345,24150009,SH-002\nF-1002,KMHJ381ABNU012347,18629981,SH-002\nF-1003,AHTEB3CD700012345,540000000,SH-001\n",
    # generated material: a brief exported and re-imported must not count as a second source
    "companion-brief-2026-10-13.csv": "Note,Figure\nTotal landed cost,600000000\n",
}


def main():
    results = []
    t0 = time.time()
    decision_ready = None

    def check(name, ok, detail=""):
        results.append((name, ok, detail))
        print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))

    tmp = tempfile.mkdtemp(prefix="gw-situation-")
    paths = {}
    for name, text in FILES.items():
        paths[name] = os.path.join(tmp, name)
        with open(paths[name], "w") as f:
            f.write(text)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=LAUNCH)
        page = browser.new_context(viewport={"width": 1500, "height": 1000}).new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        dialogs = []
        prompt_answer = {"text": ""}

        def on_dialog(d):
            dialogs.append(d.message)
            if d.type == "prompt":
                d.accept(prompt_answer["text"])
            else:
                d.accept()

        page.on("dialog", on_dialog)
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_selector(".canvas-host canvas", timeout=30000)
        time.sleep(0.6)

        def state():
            return page.evaluate("() => { const s = window.__gw.getState(); return { fileId: s.fileId, attention: s.attention, panel: s.panel, tables: [...s.tables.values()].map((t) => ({ id: t.id, name: t.name, rows: t.rows, cols: t.cols })) }; }")

        def set_panel(name):
            page.evaluate("(p) => window.__gw.getState().set({ panel: p })", name)
            time.sleep(0.3)

        def companion():
            return rest("GET", f"/api/files/{fid}/companion")

        def understanding():
            return rest("GET", f"/api/files/{fid}/companion/understanding")

        def wait_companion(pred, timeout=12.0):
            deadline = time.time() + timeout
            c = companion()
            while time.time() < deadline and not pred(c):
                time.sleep(0.3)
                c = companion()
            return c

        def import_file(name):
            set_panel("files")
            page.set_input_files(".panel input[type=file]", paths[name])
            page.wait_for_timeout(1800)

        def say(text):
            set_panel("ai")
            page.wait_for_selector(".ai-panel textarea", timeout=8000)
            page.fill(".ai-panel textarea", text)
            page.keyboard.press("Enter")
            time.sleep(0.9)

        def open_ask():
            set_panel("none")
            set_panel("ai")
            page.wait_for_selector(".companion .situation", timeout=8000)

        def situation_text():
            return page.text_content(".companion .situation") or ""

        def watch_named(c, part):
            return next((w for w in c["watches"] if part in w["def"]["purpose"]), None)

        def rec(c, kind, part=""):
            return next((r for r in c["records"] if r["kind"] == kind and part in r["text"]), None)

        # ================================================================ 1. an unclear concern: first reading, no investigation launched
        page.evaluate("() => window.__gw.book.apply({ type: 'delete_table', table: 1 })")
        page.click(".topbar .save-btn")
        page.wait_for_function("() => window.__gw.getState().fileId && !window.__gw.getState().dirty", timeout=8000)
        fid = state()["fileId"]
        import_file("inventory-2026-10-06.csv")
        inv = next(t for t in state()["tables"] if t["name"] == "inventory")
        u = understanding()
        check("1. before any objective: the first reading states what it rests on and that it is not the complete position, and launches nothing", "No objective stated yet" in u["statement"] and "inventory (snapshot 2026-10-06, 5 rows" in u["statement"] and "not the complete position" in u["statement"] and u["investigations"] == [], u["statement"][:200])
        check("   …and the next move asks for what matters instead of guessing it", "Say what matters" in u["next"] and u["stance"] in ("quiet", "observation"), u["next"])
        say("Objective: release cash tied up in stock (review by 2026-12-01)")
        say("Constraint: replacement-cost margin stays positive on every disposal")
        say("Exclude: customer-reserved vehicles in inventory")
        c = wait_companion(lambda c: rec(c, "objective") and rec(c, "constraint") and rec(c, "exclusion"))
        obj = rec(c, "objective")
        check("   three statements typed into the chat frame the situation: objective (with its review date), constraint, exclusion — none went to the model", obj and obj["reviewBy"] == "2026-12-01" and rec(c, "constraint") and rec(c, "exclusion") and page.locator(".ai-panel .msg").count() == 0, f"{obj and obj.get('reviewBy')}")
        open_ask()
        st = situation_text()
        check("   the situation at the top of Ask shows the understanding element by element, each correctable", "Working toward" in st and "release cash tied up in stock" in st and "Within" in st and "Leaving out" in st and "customer-reserved" in st and "Based on" in st and "not the complete position" in st, st[:220])
        page.screenshot(path=f"{OUT}/situation-00-first-reading.png")

        # ================================================================ 2. one tap on a suggestion; a decision with the conditions behind it
        page.click(".companion button:has-text('Watching')")
        page.wait_for_selector(".suggestion", timeout=8000)
        page.locator(".suggestion", has_text="over 90 days").locator("button:has-text('Watch this')").click()
        c = wait_companion(lambda c: watch_named(c, "over 90 days") is not None and watch_named(c, "over 90 days")["observations"])
        ageing = watch_named(c, "over 90 days")
        check("2. the ageing watch carries its complement: the population the exclusion leaves out is watched alongside (2 available, 1 reserved over 90)", ageing["def"].get("complement") and ageing["observations"][-1]["value"] == 2 and ageing["observations"][-1]["complement"] == 1, str(ageing["observations"][-1]))
        over120 = rest("POST", f"/api/files/{fid}/companion/watches", {"purpose": "Vehicles over 120 days", "formula": '=COUNTIF(inventory[Days in stock], ">120")', "kind": "threshold", "op": ">", "value": 0, "sustain": 1, "scope": "inventory", "sources": ["inventory"]})
        check("   a second watch (over 120 days) is fine on the first snapshot: nothing over 120 yet", over120["health"] == "ok" and over120["observations"][-1]["value"] == 0, over120["health"])
        say("Decision: hold the Creta until the December campaign — because a customer order is expected; reconsider if the order lapses")
        c = wait_companion(lambda c: rec(c, "decision", "Creta"))
        dec = rec(c, "decision", "Creta")
        check("   a decision typed with its reason and what would make us reconsider is kept as such: why + one condition (not yet watched)", dec["why"] == "a customer order is expected" and dec["conditions"] == [{"text": "the order lapses"}], json.dumps(dec.get("conditions")))
        open_ask()
        page.click(".companion button:has-text('Context')")
        page.wait_for_selector(".ctx-item.decision", timeout=5000)
        page.locator(".ctx-item.decision button:has-text('add a condition')").click()
        page.locator(".ctx-item.decision select").select_option(value=over120["id"])
        page.fill(".ctx-item.decision input[placeholder='what would make us reconsider']", "no vehicle goes past 120 days")
        page.locator(".ctx-item.decision button:has-text('Keep')").click()
        c = wait_companion(lambda c: len(rec(c, "decision", "Creta")["conditions"]) == 2)
        rest("POST", f"/api/files/{fid}/companion/check")
        c = companion()
        dec = rec(c, "decision", "Creta")
        check("   a condition tied to a watch from the panel: the companion now knows it holds", dec["conditions"][1]["watch"] == over120["id"] and dec["conditions"][1]["holds"] is True and dec["conditions"][0].get("holds") is None, json.dumps(dec["conditions"]))
        page.wait_for_function("() => /\\(holds\\)/.test(document.querySelector('.ctx-item.decision')?.textContent ?? '')", timeout=8000)
        cond_words = page.text_content(".ctx-item.decision") or ""
        check("   the decision shows why, and each condition with its state in words (holds / not watched — confirm by hand)", "Why:" in cond_words and "holds" in cond_words and "not watched" in cond_words, cond_words[:200])

        # ================================================================ 3. what should have happened: an expectation, kept apart from a missing event
        say("Expect: final freight invoice for SH-001 by 2026-10-08 in invoices")
        c = wait_companion(lambda c: rec(c, "expectation"))
        exp = rec(c, "expectation")
        rest("POST", f"/api/files/{fid}/companion/check")
        exp = rec(companion(), "expectation")
        check("3. the expectation is recorded with its due date, its source and what the evidence row would carry", exp["due"] == "2026-10-08" and exp["source"] == "invoices" and exp["match"] == "SH-001", json.dumps({k: exp.get(k) for k in ("due", "source", "match")}))
        check("   with no invoices table to look in, it is 'not checked' — not 'missing', not 'did not happen'", exp["expected"]["state"] == "unchecked" and "Not checked" in exp["expected"]["text"] and "no table" in exp["expected"]["text"], exp["expected"]["text"])

        # ================================================================ 4. two authoritative-looking sources conflict
        import_file("invoices-2026-10-15.csv")
        c = wait_companion(lambda c: rec(c, "contradiction") is not None)
        conflict = rec(c, "contradiction")
        exp = rec(c, "expectation")
        check("4. the invoices disagree with the inventory on one landed cost: the conflict is kept (found by a check, both figures), with what depends on it", conflict["status"] == "observed" and "inventory says 24,150,009" in conflict["text"] and "invoices says 25,000,000" in conflict["text"] and conflict["bearing"], f"{conflict['text']} | {conflict['bearing']}")
        check("   now that invoices exist and reach past the due date, the expectation is 'missing': no evidence in the source we checked — whether the event happened is the person's to say", exp["expected"]["state"] == "missing" and "No evidence" in exp["expected"]["text"] and "yours to say" in exp["expected"]["text"], exp["expected"]["text"])
        u = understanding()
        if decision_ready is None and u["stance"] in ("question", "decision"):
            decision_ready = time.time() - t0
        check("   the stance is a material question — two sources disagree — and the next move is to settle it, not to analyse further", u["stance"] == "question" and u["lead"] == "Two sources disagree" and u["next"].startswith("Settle which source is right"), f"{u['stance']} | {u['lead']} | {u['next'][:80]}")
        open_ask()
        check("   the lead at the top of Ask says so", (page.text_content(".companion-lead") or "") == "Two sources disagree", page.text_content(".companion-lead"))
        page.screenshot(path=f"{OUT}/situation-01-conflict.png")
        page.click(".companion button:has-text('Context')")
        page.wait_for_selector(".ctx-item.contradiction", timeout=5000)
        prompt_answer["text"] = "the inventory is right: the invoice carries freight twice"
        page.locator(".ctx-item.contradiction button:has-text('settle')").click()
        c = wait_companion(lambda c: rec(c, "contradiction")["status"] == "resolved")
        conflict = rec(c, "contradiction")
        u = understanding()
        check("   settled from the panel with a reason: resolved, kept under 'settled', and the stance moves to the next material question (the missing invoice)", conflict["resolution"].startswith("the inventory is right") and u["lead"] == "Something expected has not arrived" and u["next"].startswith("Chase it"), f"{u['lead']} | {u['next'][:90]}")

        # ================================================================ 5. steering: a rejected proposal is remembered with its reason; a suggestion set aside says why
        prop, err = mcp("propose_edit", {"id": fid, "title": "Discount the Creta by 10%", "rationale": "ageing", "actions": [{"action": "set_cell", "table": "inventory", "ref": "E4", "input": "16766983"}]})
        pid = prop.get("proposal") if isinstance(prop, dict) else None
        rest("POST", f"/api/files/{fid}/proposals/{pid}/decide", {"decision": "rejected", "note": "no blanket discounts; the Creta is held for a customer order"})
        c = companion()
        rej = rec(c, "decision", "Rejected")
        ctx, _ = mcp("read_context", {"id": fid})
        check("5. a rejected proposal becomes a decision with the person's reason, and agents read it under 'rejected' before proposing again", rej and "Discount the Creta by 10%" in rej["text"] and "no blanket discounts" in rej["text"] and any("no blanket discounts" in (x.get("note") or "") for x in ctx["rejected"]), str(ctx.get("rejected"))[:160])
        open_ask()
        page.click(".companion button:has-text('Watching')")
        page.wait_for_selector(".suggestion", timeout=8000)
        page.locator(".suggestion", has_text="Inventory: duplicate VINs").locator("button:has-text('not now')").click()
        time.sleep(0.8)
        visible = page.locator(".suggestion").all_text_contents()
        c = companion()
        check("   'not now' sets a suggestion aside with its reason, out of the list but never out of sight", not any("Inventory: duplicate VINs" in s for s in visible) and any("Invoices: duplicate VINs" in s for s in visible) and any(d["reason"] == "not now" and "Inventory: duplicate VINs" in d["purpose"] for d in c["dismissed"]), str(c["dismissed"]))
        page.click(".companion button:has-text('Context')")
        page.wait_for_selector(".companion-section:has-text('Set aside')", timeout=5000)
        aside = page.text_content(".companion-section") or ""
        check("   Context lists what was set aside, with the reason, and can bring it back", "Set aside" in aside and "Inventory: duplicate VINs" in aside and "not now" in aside and page.locator("button:has-text('bring back')").count() == 1, "")
        page.locator("button:has-text('bring back')").click()
        c = wait_companion(lambda c: not c["dismissed"])
        check("   brought back: the suggestion returns", any("Inventory: duplicate VINs" in s["purpose"] for s in rest("GET", f"/api/files/{fid}/companion/suggest")), "")

        # ================================================================ 6. the next snapshot: a flat headline hides a moving population; a decision's condition fails
        import_file("inventory-2026-10-13.csv")
        c = wait_companion(lambda c: watch_named(c, "over 90 days")["observations"][-1].get("period") == "2026-10-13" and rec(c, "decision", "Creta").get("revisit") is not None)
        ageing = watch_named(c, "over 90 days")
        moved = [e for e in c["events"] if "exclusion is carrying the movement" in e["text"]]
        check("6. the headline is flat (2 available over 90) but what the exclusion leaves out doubled (1 → 2): the companion says the definition, not the business, is what is quiet", ageing["observations"][-1]["value"] == 2 and ageing["observations"][-1]["complement"] == 2 and len(moved) == 1 and "went 1 → 2" in moved[0]["text"] and moved[0]["level"] == "watch", moved and moved[0]["text"][:160])
        dec = rec(c, "decision", "Creta")
        over = next(w for w in c["watches"] if w["id"] == over120["id"])
        check("   the Tucson passes 120 days: the watch behind the hold decision breaches, the condition no longer holds, the decision is flagged to revisit — once", over["health"] == "attention" and dec["revisit"] and dec["revisit"]["condition"] == "no vehicle goes past 120 days" and dec["conditions"][1]["holds"] is False and len([e for e in c["events"] if e["text"].startswith("Revisit")]) == 1, str(dec["revisit"])[:160])
        u = understanding()
        check("   the stance is a decision to present — 'A decision needs another look' — ahead of the open issue behind it", u["stance"] == "decision" and u["lead"] == "A decision needs another look" and "Revisit" in u["next"] and "no vehicle goes past 120 days" in u["next"], f"{u['lead']} | {u['next'][:100]}")
        open_ask()
        page.click(".companion button:has-text('Context')")
        page.wait_for_selector(".ctx-item.decision.revisit", timeout=5000)
        check("   the decision in Context carries the revisit note with the failing condition", "Revisit:" in (page.text_content(".ctx-item.decision.revisit") or "") and "no longer appears to hold" in (page.text_content(".ctx-item.decision.revisit") or ""), "")
        page.screenshot(path=f"{OUT}/situation-02-revisit.png")

        # ================================================================ 7. investigate with scoped tools (the LangChain + DeepAgents + LangGraph stack, through the mock model)
        stack = rest("GET", "/api/investigation")
        if MOCK and stack.get("available"):
            rest("PUT", "/api/ai/settings", {"baseUrl": MOCK, "model": "mock"})
            open_ask()
            page.click(".companion button:has-text('Watching')")
            page.wait_for_selector(".watch-item.attention .issue button:has-text('Investigate (agent)')", timeout=8000)
            page.locator(".watch-item.attention .issue button:has-text('Investigate (agent)')").first.click()
            c = wait_companion(lambda c: c["investigations"] and c["investigations"][-1]["status"] != "running", timeout=120)
            inv1 = c["investigations"][-1]
            steps = [s["tool"] for s in inv1["steps"]]
            run = next((r for r in c["runs"] if r["id"] in inv1["runs"]), None)
            check("7. the investigation ran as a separate process acting for the requester: read_context → run_python → remember, findings in its own words", inv1["status"] == "done" and steps[:3] == ["read_context", "run_python", "remember"] and inv1["answer"].startswith("Findings:") and inv1["model"] == "mock", f"{inv1['status']} {steps} {inv1.get('error')}")
            check("   generated code ran in Gridwright's sandbox against the live document, recorded with code hash, sandbox and time; nothing written", run and run["ok"] and run["sandbox"] in ("bwrap", "unshare", "none") and run["codeHash"] and run["purpose"].startswith("count vehicles"), str(run))
            hyp = next((r for r in c["records"] if r["kind"] == "hypothesis" and r["origin"] == "agent"), None)
            check("   what it found is proposed, by 'an investigation', not stated — the person ratifies", hyp and hyp["status"] == "proposed" and hyp["by"]["name"].startswith("investigation"), str(hyp and hyp["by"]))
            page.wait_for_selector(".investigation.done", timeout=8000)
            if page.locator(".investigation.done button:has-text('details')").count():
                page.locator(".investigation.done button:has-text('details')").click()
            time.sleep(0.3)
            inv_text = page.text_content(".investigation.done") or ""
            check("   the panel shows the investigation: status, sandboxed runs, proposed records, the steps and the findings labelled as the agent's words", "1 sandboxed run" in inv_text and "1 proposed record" in inv_text and "run_python" in inv_text and "agent's findings" in inv_text, inv_text[:200])
            page.screenshot(path=f"{OUT}/situation-03-investigation.png")
            # the thread is durable: a second run from the command line continues where the first left off
            here = os.path.dirname(os.path.abspath(__file__))
            script = os.path.join(here, "..", "integrations", "companion", "investigate.py")
            db = os.path.join(tmp, "threads.sqlite")
            env = {**os.environ, "OPENAI_BASE_URL": MOCK, "GRIDWRIGHT_MODEL": "mock", "OPENAI_API_KEY": "none", "GRIDWRIGHT_THREADS_DB": db}
            r1 = subprocess.run([sys.executable, script, fid, "--question", "Investigate the ageing issue.", "--thread", f"test:{fid}", "--base", BASE, "--json"], capture_output=True, text=True, timeout=180, env=env)
            r2 = subprocess.run([sys.executable, script, fid, "--question", "What did you find?", "--thread", f"test:{fid}", "--base", BASE, "--json"], capture_output=True, text=True, timeout=180, env=env)
            try:
                j1 = json.loads(r1.stdout.strip().split("\n")[-1])
                j2 = json.loads(r2.stdout.strip().split("\n")[-1])
            except Exception:
                j1, j2 = {}, {}
            check("   durable state: the second investigation on the same thread continues from the first (the thread grew, checkpointed in SQLite)", r1.returncode == 0 and r2.returncode == 0 and j2.get("messages_in_thread", 0) > j1.get("messages_in_thread", 0) > 0, f"{j1.get('messages_in_thread')} → {j2.get('messages_in_thread')} {(r1.stderr or r2.stderr)[-160:]}")
            # the agent may propose, not ratify: without the loopback token it is simply a caller; with it, confirming is refused (exercised in controls)
        else:
            print(f"SKIP investigation ({'no --mock-llm' if not MOCK else stack.get('reason')})")
            inv1 = None

        # ================================================================ 8. an assumption changes during execution: earlier conclusions become provisional
        ex = rec(companion(), "exclusion")
        rest("PUT", f"/api/files/{fid}/companion/records/{ex['id']}", {"text": "customer-reserved and demonstrator vehicles in inventory"})
        c = companion()
        u = understanding()
        changed = [e for e in c["events"] if e["kind"] == "assumption" and e["text"].startswith("Assumption changed")]
        check("8. correcting the exclusion is an assumption change: said once, in the activity, with what it makes provisional", len(changed) == 1 and "exclusion" in changed[0]["text"] and "provisional" in changed[0]["text"], changed and changed[0]["text"][:160])
        if inv1:
            check("   the investigation made under the earlier assumption is marked provisional, in the brief and on the record — not silently current", u["investigations"][-1].get("stale") is True and any("made under earlier assumptions" in n for n in rest("GET", f"/api/files/{fid}/companion/brief")["next"]), str(rest("GET", f"/api/files/{fid}/companion/brief")["next"]))
            open_ask()
            page.click(".companion button:has-text('Watching')")
            page.wait_for_selector(".investigation.stale", timeout=8000)
            check("   the panel says so on the investigation itself", "provisional — assumptions changed since" in (page.text_content(".investigation.stale") or ""), "")

        # ================================================================ 9. the invoice arrives: the expectation is met; private and generated material stay in their place
        import_file("invoices-2026-10-22.csv")
        c = wait_companion(lambda c: rec(c, "expectation")["expected"]["state"] == "met")
        exp = rec(c, "expectation")
        check("9. the next invoices snapshot carries SH-001: the expectation is met, by evidence, with the snapshot named", "Arrived" in exp["expected"]["text"] and "SH-001" in exp["expected"]["text"] and "2026-10-22" in exp["expected"]["text"], exp["expected"]["text"])
        say("Private: hypothesis: reservations may be recorded to keep vehicles out of the ageing count")
        c = wait_companion(lambda c: rec(c, "hypothesis", "reservations may"))
        priv = rec(c, "hypothesis", "reservations may")
        ctx_out, _ = mcp("read_context", {"id": fid})
        ctx_in = rest("GET", f"/api/files/{fid}/companion/context")
        check("   a private hypothesis stays with its author: in the person's own context, never in what an outside agent reads", priv["private"] is True and not any("reservations may" in r["text"] for r in ctx_out["records"]) and any("reservations may" in r["text"] for r in ctx_in["records"]), "")
        import_file("companion-brief-2026-10-13.csv")
        c = wait_companion(lambda c: rec(c, "source", "companion-brief") is not None)
        src = rec(c, "source", "companion-brief")
        u = understanding()
        check("   a re-imported brief is recognised as generated material: kept, but never counted as independent evidence", src["derivative"] is True and any(cv.get("derivative") for cv in u["coverage"]) and "generated — not independent evidence" in u["statement"], u["statement"][-200:])

        # ================================================================ 10. a repeated exception becomes a process question, not a series of surprises
        sg = rest("GET", f"/api/files/{fid}/companion/suggest")
        blank_def = next(s for s in sg if "no landed cost" in s["purpose"] and "Inventory" in s["purpose"])["def"]
        blanks = rest("POST", f"/api/files/{fid}/companion/watches", blank_def)
        golf = 4  # the Golf's row (0-based, header row 0); landed cost in column 4, model in column 1

        def edit(row, col, value):
            page.evaluate("([t, r, c, v]) => window.__gw.book.apply({ type: 'set_cells', table: t, row: r, col: c, values: [[v]] })", [inv["id"], row, col, value])
            time.sleep(0.35)
            rest("POST", f"/api/files/{fid}/companion/check")

        for i in range(3):
            edit(golf, 4, "")
            edit(golf, 4, "22785000")
            edit(golf, 1, f"Golf{' ' * (i + 1)}")
        c = companion()
        w = next(x for x in c["watches"] if x["id"] == blanks["id"])
        pattern = [e for e in c["events"] if e["kind"] == "pattern"]
        check("10. the same gap three times across snapshots: once, the companion asks whether the cause is upstream — without blame", len(pattern) == 1 and "3 times" in pattern[0]["text"] and "upstream" in pattern[0]["text"] and "not misconduct" in pattern[0]["text"] and (len(w["history"]) + (1 if w.get("issue") else 0)) >= 3, pattern and pattern[0]["text"][:160])

        # ================================================================ 11. consequential assumptions carry a review date
        rest("POST", f"/api/files/{fid}/companion/records", {"kind": "constraint", "text": "prioritise liquidity over margin until the FX backlog clears", "reviewBy": "2026-10-01"})
        rest("POST", f"/api/files/{fid}/companion/check")
        c = companion()
        u = understanding()
        review = [e for e in c["events"] if e["text"].startswith("Reconfirm")]
        check("11. an assumption past its review date is asked to be reconfirmed, once, and ranks among the uncertainties", len(review) == 1 and "prioritise liquidity" in review[0]["text"] and any(x["kind"] == "review" for x in u["uncertain"]), review and review[0]["text"][:160])

        # ================================================================ 12. return after an interruption: the decision context is restored without rereading anything
        page.goto(f"{BASE}/?file={fid}", wait_until="networkidle")
        page.wait_for_selector(".canvas-host canvas", timeout=30000)
        time.sleep(0.8)
        open_ask()
        st = situation_text()
        lead = page.text_content(".companion-lead") or ""
        nxt = page.text_content(".next-move .next-text") or ""
        check("12. after a reload the situation is there — objective, constraints, exclusions, what it rests on, decisions standing, the next move — with no chat to reread", "release cash tied up in stock" in st and "demonstrator" in st and "Based on" in st and "decision" in st and lead and nxt and page.locator(".ai-panel .msg").count() == 0, f"{lead} | {nxt[:80]}")
        page.screenshot(path=f"{OUT}/situation-04-return.png")

        # ================================================================ the measures
        c = companion()
        events = [e for e in c["events"] if e["kind"] != "trace"]
        attention_events = [e for e in events if e["level"] == "attention"]
        watch_events = [e for e in events if e["level"] == "watch"]
        texts = [e["text"] for e in events]
        # a repeated explanation is the companion saying the same thing again with nothing new in between (three genuine re-openings are three episodes, not repetition)
        repeated = [t for i, t in enumerate(texts) if i and texts[i - 1] == t]
        planted = {
            "missing landed cost": any("no landed cost" in e["text"] and e["level"] == "attention" for e in events),
            "sources disagree": any(e["kind"] == "conflict" for e in events),
            "exclusion carrying the movement": any("exclusion is carrying the movement" in e["text"] for e in events),
            "expected invoice not arrived": any("No evidence" in e["text"] for e in events),
            "decision to revisit": any(e["text"].startswith("Revisit") for e in events),
            "recurring gap": any(e["kind"] == "pattern" for e in events),
            "assumption due for review": any(e["text"].startswith("Reconfirm") for e in events),
        }
        awaiting = len([r for r in c["records"] if r["status"] == "proposed"]) + len([w for w in c["watches"] if w["authority"] == "proposed"])
        brief_changed = rest("GET", f"/api/files/{fid}/companion/brief")["changed"]
        print("\nMEASURES (this run, synthetic data, no real model)")
        print(f"  time to a decision-ready position: {decision_ready:.1f} s after the first file" if decision_ready else "  time to a decision-ready position: n/a")
        print(f"  interruptions: {len(attention_events)} attention-level, {len(watch_events)} worth-a-look, over 5 files and {len(events)} events")
        print(f"  repeated explanations (the same line twice running): {len(repeated)}" + (f" — {repeated[:3]}" if repeated else ""))
        print(f"  planted issues surfaced: {sum(planted.values())}/{len(planted)}" + ("" if all(planted.values()) else f" — missed: {[k for k, v in planted.items() if not v]}"))
        print(f"  verification effort left to the person: {awaiting} proposed item(s) to confirm or retire")
        check("measure: every planted issue surfaced, and nothing was said twice running", all(planted.values()) and not repeated, str([k for k, v in planted.items() if not v]) + str(repeated[:3]))
        check("measure: the brief never repeats itself", len(brief_changed) == len(set(brief_changed)), "")
        browser.close()
        rest("DELETE", f"/api/files/{fid}")
    check("no uncaught errors in the page", not errors, "; ".join(errors[:2])[:160])

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n{passed}/{len(results)} checks passed")
    if passed != len(results):
        sys.exit(1)


if __name__ == "__main__":
    main()

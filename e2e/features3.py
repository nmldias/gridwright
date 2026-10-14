#!/usr/bin/env python3
"""Round-3 feature checks: SQL policy (read-only sessions, database-side refusal, row and time
limits, per-connection allow-lists), run records for code cells (history and CSV), the MCP server
(typed tools, proposals, refused writes), the proposal review flow in the browser, and
private-by-default sharing on the identity server.

Usage: python3 e2e/features3.py [http://localhost:8787] [--pg host:port:db:user:pass]
       [--acl http://127.0.0.1:8795]
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
ACL = None
for i, a in enumerate(sys.argv):
    if a == "--pg":
        PG = sys.argv[i + 1].split(":")
    if a == "--acl":
        ACL = sys.argv[i + 1]
OUT = os.environ.get("E2E_OUT", "/tmp/gridwright-e2e")
os.makedirs(OUT, exist_ok=True)

MCP_TOOLS = sorted(["list_documents", "read_document", "read_table", "read_range", "evaluate", "run_checks", "read_history", "list_connections", "run_sql", "propose_edit", "list_proposals", "read_context", "read_graph", "remember", "propose_watch", "list_attention"])


def rest(method, path, body=None, base=None, headers=None, raw=False):
    h = {"content-type": "application/json"}
    h.update(headers or {})
    req = urllib.request.Request((base or BASE) + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
            return (r.status, data.decode()) if raw else json.loads(data.decode())
    except urllib.error.HTTPError as e:
        if raw:
            return (e.code, e.read().decode())
        raise


def mcp(method, params=None, base=None, msg_id=1):
    body = {"jsonrpc": "2.0", "id": msg_id, "method": method}
    if params is not None:
        body["params"] = params
    code, text = rest("POST", "/mcp", body, base=base, headers={"accept": "application/json, text/event-stream"}, raw=True)
    return code, (json.loads(text) if text.strip().startswith("{") else {"raw": text})


def tool(name, args, base=None):
    """Call an MCP tool; returns (is_error, text)."""
    _, r = mcp("tools/call", {"name": name, "arguments": args}, base=base, msg_id=7)
    res = r.get("result", {})
    text = "".join(c.get("text", "") for c in res.get("content", []))
    return bool(res.get("isError")), text


def conn_body(password, **extra):
    host, port, db, user, _ = PG
    body = {"name": "demo pg", "kind": "postgres", "host": host, "port": int(port), "database": db, "user": user, "password": password, "ssl": False}
    body.update(extra)
    return body


def main():
    results = []
    page_errors = []

    def check(name, ok, detail=""):
        results.append((name, ok, detail))
        print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))

    # ------------------------------------------------------------------ MCP transport and tool list
    _, init = mcp("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "features3", "version": "1"}})
    res = init.get("result", {})
    check("MCP initialize answers with server info and the tools capability", bool(res.get("serverInfo")) and "tools" in res.get("capabilities", {}), json.dumps(init)[:160])
    _, listed = mcp("tools/list")
    names = sorted(t["name"] for t in listed.get("result", {}).get("tools", []))
    check("MCP lists the sixteen typed tools (workbook, proposals, SQL and the companion)", names == MCP_TOOLS, ", ".join(names))
    code, _ = rest("GET", "/mcp", raw=True)
    check("MCP refuses GET (stateless: POST only)", code == 405, str(code))
    # the engine throws plain strings; they must come back as a readable tool error, not a protocol error
    bad = rest("POST", "/api/files", {"name": "Malformed", "json": json.dumps({"name": "Malformed", "tables": [{"id": 1, "name": "T", "x": 0, "y": 0, "rows": 2, "cols": 2, "cells": {}}], "next_table_id": 2})})
    _, r = mcp("tools/call", {"name": "evaluate", "arguments": {"id": bad["id"], "formula": "=1+1"}}, msg_id=3)
    res = r.get("result", {})
    check("an engine refusal is reported as a tool error with the engine's message", res.get("isError") is True and "expected a sequence" in "".join(c.get("text", "") for c in res.get("content", [])), json.dumps(r)[:160])
    rest("DELETE", f"/api/files/{bad['id']}", raw=True)

    with sync_playwright() as p:
        args = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
        browser = p.chromium.launch(headless=True, args=args)
        ctx = browser.new_context(viewport={"width": 1500, "height": 950}, accept_downloads=True)
        page = ctx.new_page()
        page.on("pageerror", lambda e: page_errors.append(str(e)))
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_selector(".canvas-host canvas", timeout=30000)
        time.sleep(0.6)

        def apply(op, **opts):
            return page.evaluate("([op, opts]) => window.__gw.book.apply(op, opts)", [op, opts])

        def cell(table, r, c):
            return page.evaluate("([t,r,c]) => { const s = window.__gw.getState(); const cell = s.cells.get(t)?.get(r*65536+c); return cell ? { i: cell.i, v: cell.v, k: cell.k } : null; }", [table, r, c])

        def num(v):
            return v["v"]["n"] if v and v["v"] and "n" in v["v"] else None

        def state():
            return page.evaluate("() => { const s = window.__gw.getState(); return { fileId: s.fileId, panel: s.panel }; }")

        page.evaluate("() => window.__gw.getState().set({ fileName: 'Round three' })")
        page.evaluate("() => document.querySelector('.topbar .save-btn').click()")
        fid = None
        for _ in range(60):
            fid = state()["fileId"]
            if fid:
                break
            time.sleep(0.2)
        check("document saved (proposals and run records need a server-side document)", bool(fid), str(fid))
        time.sleep(0.5)

        # a scratch table for the run-record and proposal checks
        sname = f"Scratch{int(time.time()) % 100000}"
        created = apply({"type": "add_table", "name": sname, "x": 1500, "y": 1200, "rows": 12, "cols": 6, "values": [["Item", "Amount"], ["a", "10"], ["b", "20"]]})
        sid = created["created"][0]

        # ------------------------------------------------------------------ SQL policy (PostgreSQL)
        conn = None
        if PG:
            conn = rest("POST", "/api/connections", conn_body(PG[4]))
            check("connections are read-only by default", conn.get("readOnly") is True, str({k: conn.get(k) for k in ("readOnly", "maxRows", "timeoutMs")}))

            def q(cid, sql, extra=None, base=None, headers=None):
                body = {"sql": sql}
                body.update(extra or {})
                code, text = rest("POST", f"/api/connections/{cid}/query", body, base=base, headers=headers, raw=True)
                return code, text

            code, body = q(conn["id"], "DELETE FROM orders")
            check("writes are refused before they reach the database", code in (400, 403), f"{code} {body[:100]}")
            code, body = q(conn["id"], "SELECT 1; DROP TABLE orders")
            check("stacked statements are refused", code in (400, 403), f"{code} {body[:100]}")
            code, body = q(conn["id"], "SELECT pg_sleep(1)")
            check("time-wasting and file-touching functions are refused", code in (400, 403), f"{code} {body[:100]}")
            code, body = q(conn["id"], "SELECT nextval('orders_id_seq')")
            check("the database itself refuses a write hidden inside SELECT (read-only transaction)", code == 400 and "read-only" in body, f"{code} {body[:140]}")
            code, body = q(conn["id"], "SELECT region, SUM(amount)::float AS total FROM orders GROUP BY region ORDER BY region")
            res = json.loads(body) if code == 200 else {}
            check("SELECT runs and returns typed rows", code == 200 and res.get("rows") == [["North", 45.0], ["South", 60.0]], f"{code} {body[:120]}")
            code, body = q(conn["id"], "SELECT id, amount FROM orders ORDER BY id", {"limit": 3})
            res = json.loads(body) if code == 200 else {}
            check("row limits are enforced on the server and reported as truncation", code == 200 and len(res.get("rows", [])) == 3 and res.get("truncated") is True, f"{len(res.get('rows', []))} rows, truncated={res.get('truncated')}")
            rest("PUT", f"/api/connections/{conn['id']}", conn_body(PG[4], timeoutMs=300))
            code, body = q(conn["id"], "SELECT count(*) FROM generate_series(1, 400000000)")
            check("a statement past the connection's time limit is cancelled", code == 400 and any(w in body.lower() for w in ("cancel", "timeout", "statement")), f"{code} {body[:120]}")
            rest("PUT", f"/api/connections/{conn['id']}", conn_body(PG[4], timeoutMs=30000))

        # ------------------------------------------------------------------ run records (code cells)
        apply({"type": "set_cell", "table": sid, "row": 5, "col": 0, "input": "2 + 3", "kind": "javascript"})
        runs = []
        for _ in range(40):
            h = rest("GET", f"/api/files/{fid}/history?limit=50")
            runs = [e["run"] for e in h["entries"] if e.get("run")]
            if runs:
                break
            time.sleep(0.25)
        run = runs[0] if runs else {}
        check("a JavaScript cell run is recorded with code and output hashes and its runtime", bool(run) and run.get("kind") == "javascript" and run.get("codeHash") and run.get("outputHash") and run.get("runtime", {}).get("name") == "javascript", json.dumps(run)[:200])
        code, csv = rest("GET", f"/api/files/{fid}/history.csv", raw=True)
        check("run records appear in the audit CSV", code == 200 and any(",code_run," in line for line in csv.split("\n")), f"{code}")
        page.evaluate("() => window.__gw.getState().set({ panel: 'review' })")
        page.wait_for_selector(".review-panel .run-item", timeout=8000)
        item = page.locator(".review-panel .run-item").first.text_content() or ""
        check("the Review panel lists the run with a status badge", "javascript" in item and ("matches recorded run" in item or "failed" in item), item[:120])
        page.screenshot(path=f"{OUT}/f3-01-runs.png")

        # ------------------------------------------------------------------ MCP tools on the open document
        err, text = tool("read_table", {"id": fid, "table": sname, "max_rows": 5})
        check("MCP read_table returns the rows as display text", not err and "Item" in text and "Amount" in text, text[:100])
        err, text = tool("evaluate", {"id": fid, "formula": f"=SUM('{sname}'::B2:B3)", "table": sname})
        check("MCP evaluate computes a formula without changing the document", not err and "30" in text, text[:100])
        err, text = tool("propose_edit", {"id": fid, "title": "Total the amounts", "rationale": "Sum of the two lines", "actions": [{"action": "set_cell", "table": sname, "ref": "C3", "input": "=B2+B3"}]})
        try:
            prop = json.loads(text)
        except ValueError:
            prop = {}
        pid = prop.get("proposal")
        check("MCP propose_edit files a proposal with a before → after preview", not err and prop.get("status") == "pending" and prop.get("changes") == 1 and any(d.get("where", "").endswith("C3") for d in prop.get("preview", [])), text[:140])
        err, text = tool("propose_edit", {"id": fid, "title": "Bad", "actions": [{"action": "set_cell", "table": "NoSuchTable", "ref": "A1", "input": "1"}]})
        check("a proposal that cannot be validated is refused with the reason", err and "not found" in text, text[:120])
        err, text = tool("propose_edit", {"id": fid, "title": "Reject me", "actions": [{"action": "set_cell", "table": sname, "ref": "D2", "input": "99"}]})
        rej = json.loads(text) if not err else {}
        err, text = tool("list_proposals", {"id": fid, "status": "pending"})
        listed_ids = [p.get("id") for p in json.loads(text)] if not err else []
        check("list_proposals shows the pending proposals", pid in listed_ids and rej.get("proposal") in listed_ids, str(listed_ids)[:120])
        if PG:
            err, text = tool("run_sql", {"connection": conn["id"], "sql": "DELETE FROM orders"})
            check("MCP run_sql refuses writes through the same policy", err, text[:100])
            err, text = tool("run_sql", {"connection": conn["id"], "sql": "SELECT count(*) AS n FROM orders"})
            check("MCP run_sql answers reads", not err and "5" in text, text[:100])

        # ------------------------------------------------------------------ proposal review in the browser
        page.evaluate("() => window.__gw.getState().set({ panel: 'review' })")
        page.wait_for_selector(".review-panel .proposal.pending", timeout=8000)
        card = page.locator(".review-panel .proposal.pending", has_text="Total the amounts")
        check("the Review panel shows the pending proposal and its diff", card.count() == 1 and card.locator("table.diff-table").count() == 1, "")
        page.screenshot(path=f"{OUT}/f3-02-proposals.png")
        card.locator("button.primary").click()
        time.sleep(1.2)
        after = rest("GET", f"/api/files/{fid}/proposals/{pid}")
        check("applying in the Review panel applies the change and records the decision", after.get("status") == "applied" and after.get("decidedBy") and num(cell(sid, 2, 2)) == 30, f"status={after.get('status')}, C3={num(cell(sid, 2, 2))}")
        page.locator(".review-panel .proposal.pending", has_text="Reject me").locator("button", has_text="Reject").click()
        time.sleep(0.8)
        rejected = rest("GET", f"/api/files/{fid}/proposals/{rej.get('proposal')}")
        check("rejecting a proposal leaves the document unchanged", rejected.get("status") == "rejected" and num(cell(sid, 1, 3)) is None, str(rejected.get("status")))
        h = rest("GET", f"/api/files/{fid}/history?limit=200")
        agent_change = any(e.get("origin") == "agent" and (e.get("op") or {}).get("type") == "set_cell" for e in h["entries"])
        decision = any(e.get("origin") == "user" and pid in (e.get("note") or "") for e in h["entries"])
        check("the audit log keeps the agent's change and the person's decision apart", agent_change and decision, "")

        page.screenshot(path=f"{OUT}/f3-03-review.png")
        browser.close()

    check("no uncaught errors in the page", not page_errors, "; ".join(page_errors[:2])[:160])

    # ------------------------------------------------------------------ identity server: private by default, allow-lists
    if ACL:
        A = {"tailscale-user-login": "alice@example.com", "tailscale-user-name": "Alice"}
        B = {"tailscale-user-login": "bob@example.com", "tailscale-user-name": "Bob"}
        BOSS = {"tailscale-user-login": "boss@example.com"}
        health = rest("GET", "/api/health", base=ACL)
        check("the identity server defaults new documents to private", health.get("defaultSharing") == "none", str(health.get("defaultSharing")))
        created = rest("POST", "/api/files", {"name": "Policy", "json": '{"name":"Policy","tables":[],"next_table_id":1}'}, base=ACL, headers=A)
        acc = rest("GET", f"/api/files/{created['id']}/access", base=ACL, headers=A)
        check("a document created on the identity server is private until shared", acc.get("public") == "none", str(acc)[:120])
        if PG:
            c2 = rest("POST", "/api/connections", conn_body(PG[4], name="shared pg", allowed=["bob@example.com"]), base=ACL, headers=BOSS)
            code_a, _ = rest("POST", f"/api/connections/{c2['id']}/query", {"sql": "SELECT 1 AS one"}, base=ACL, headers=A, raw=True)
            check("a connection outside its allow-list is invisible to other people", code_a == 404, str(code_a))
            code_b, body_b = rest("POST", f"/api/connections/{c2['id']}/query", {"sql": "SELECT count(*) AS n FROM orders"}, base=ACL, headers=B, raw=True)
            check("an allowed person can query the connection", code_b == 200 and '"rows"' in body_b, f"{code_b} {body_b[:80]}")
            rest("DELETE", f"/api/connections/{c2['id']}", base=ACL, headers=BOSS)
        if conn:
            rest("DELETE", f"/api/connections/{conn['id']}")

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n{passed}/{len(results)} checks passed")
    if passed != len(results):
        sys.exit(1)


if __name__ == "__main__":
    main()

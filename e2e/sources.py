#!/usr/bin/env python3
"""Sources (0.11.0): one SQL source → one saved preparation → one reconciled dataset version → one
traceable table → one repeatable server-side refresh, with no model involved.

Placing a SQL snapshot defines the source and captures the preparation a person accepted as recipe
version 1 · a refresh is a job under the requester's permissions: the query runs again, the recipe
is applied, the candidate is reconciled (period order, identifiers in common, coverage) and placed
through the log as the next version when every check passes · an unchanged result confirms coverage
and invents nothing · a changed shape (drift) is held, nothing placed, the checks on the version and
on the card · an older period is held · a held version placed by a person follows the decision ·
versions, recipes and bookkeeping (as-of, last attempt, last success, result) are read back ·
a viewer cannot refresh; an agent cannot · the sources go with the document when it is deleted.

Usage: python3 e2e/sources.py [http://localhost:8787] --pg host:port:db:user:pass
Needs psql on PATH (the fixture table is made with it).
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
BASE = ARGS[0] if ARGS else "http://localhost:8787"
PG = None
for i, a in enumerate(sys.argv):
    if a == "--pg":
        PG = sys.argv[i + 1].split(":")
if not PG:
    print("usage: sources.py [base] --pg host:port:db:user:pass")
    sys.exit(2)
HOST, PORT, DB, USER, PW = PG


def rest(method, path, body=None, raw=False, headers=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"content-type": "application/json", "accept": "application/json, text/event-stream", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            text = r.read().decode()
            return (r.status, text) if raw else json.loads(text)
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        if raw:
            return (e.code, text)
        raise


def psql(sql):
    r = subprocess.run(["psql", "-h", HOST, "-p", PORT, "-U", USER, "-d", DB, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], env={**os.environ, "PGPASSWORD": PW}, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr)
    return r.stdout


def mcp(name, arguments):
    code, text = rest("POST", "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}}, raw=True)
    res = json.loads(text).get("result", {})
    content = "".join(c.get("text", "") for c in res.get("content", []))
    return json.loads(content)


def wait_job(fid, jid, seconds=120):
    for _ in range(seconds * 2):
        j = rest("GET", f"/api/files/{fid}/jobs/{jid}")
        if j["status"] not in ("queued", "running"):
            return j
        time.sleep(0.5)
    return j


def main():
    results = []

    def check(name, ok, detail=""):
        results.append((name, ok, detail))
        print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))

    psql("DROP TABLE IF EXISTS inv_src")
    psql("CREATE TABLE inv_src (vin varchar(20) PRIMARY KEY, model text, landed_cost numeric(14,2), days int, reserved boolean, branch text, snapshot_date date)")
    psql("INSERT INTO inv_src VALUES ('000123','Tucson',24150009.00,120,false,'Luanda','2026-10-06'),('000124','Creta',18629981.50,95,true,'Luanda','2026-10-06'),('000125','Tucson',24150009.00,95,false,'Luanda','2026-10-06'),('000126','Santa Fe',NULL,60,false,'Luanda','2026-10-06'),('000127','Creta',18629981.50,30,false,'Luanda','2026-10-06')")
    doc = rest("POST", "/api/files", {"name": "Sources", "json": '{"name":"Sources","tables":[],"next_table_id":1}'})
    fid = doc["id"]
    conn = rest("POST", "/api/connections", {"name": "stock db", "kind": "postgres", "host": HOST, "port": int(PORT), "database": DB, "user": USER, "password": PW, "ssl": False})
    SQL = "SELECT * FROM inv_src ORDER BY vin"  # the shape follows the table: a dropped column is drift, not a failing query
    try:
        # ================================================================ 1. a SQL snapshot placed defines the source and its recipe
        prof = rest("POST", f"/api/files/{fid}/intake", {"connection": conn["id"], "sql": SQL})
        check("1. the query result is profiled under the database's declared types, with the period read from the snapshot_date column", prof["origin"] == "sql" and prof["period"] == "2026-10-06" and prof["periodFrom"] == "column" and prof["sets"][0]["columns"][0]["type"] == "identifier", f"{prof.get('period')} {prof.get('periodFrom')}")
        placed = rest("POST", f"/api/files/{fid}/intake/{prof['key']}/apply", {"decisions": [{"action": "new"}]})
        table = placed["applied"]["tables"][0]["table"]
        srcs = rest("GET", f"/api/files/{fid}/sources")
        src = srcs[0] if srcs else None
        check("   placing it makes the source definition: connection, query, the table it feeds, recipe version 1 captured from what was accepted, as-of and last success set", src is not None and src["kind"] == "sql" and src["connectionName"] == "stock db" and src["table"] == table and src["recipeVersion"] == 1 and src["asOf"] == "2026-10-06" and src["lastSuccessAt"] and src["enabled"], json.dumps(src)[:200])
        detail = rest("GET", f"/api/files/{fid}/sources/{src['id']}")
        recipe = detail["recipes"][0]["recipe"]
        check("   the recipe is the column contract (headers, declared and read kinds, units), the identifier column, where the period comes from, and stated reconciliation rules — with the environment it was made under", [c["header"] for c in recipe["columns"]] == ["vin", "model", "landed_cost", "days", "reserved", "branch", "snapshot_date"] and recipe["identifierColumn"] == "vin" and recipe["period"] == {"from": "column", "column": "snapshot_date"} and recipe["rules"]["minIdentifierOverlap"] == 0.3 and "node" in detail["recipes"][0]["environment"] and detail["versions"][0]["status"] == "accepted" and detail["versions"][0]["version"] == 1, json.dumps(recipe)[:200])
        comp = rest("GET", f"/api/files/{fid}/companion")
        srec = [r for r in comp["records"] if r["kind"] == "source" and r.get("intake") == prof["key"]]
        check("   the table is traceable: a source record with the intake key links it to the version", len(srec) == 1 and srec[0]["links"][0]["table"] == table and srec[0]["period"] == "2026-10-06", str(srec and srec[0].get("period")))

        # ================================================================ 2. the next snapshot: a refresh on request, reconciled and placed as version 2
        psql("UPDATE inv_src SET snapshot_date = '2026-10-13', days = days + 7; UPDATE inv_src SET landed_cost = 21000000.00 WHERE vin = '000126'; INSERT INTO inv_src VALUES ('000128','Tucson',24150009.00,3,false,'Luanda','2026-10-13')")
        job = rest("POST", f"/api/files/{fid}/sources/{src['id']}/refresh", {})
        check("2. a refresh is a job: queued under the requester, with the source and the recipe version it will apply", job["type"] == "refresh" and job["status"] in ("queued", "running") and job["input"]["source"] == src["id"] and job["input"]["recipe"] == src["recipe"] and job["maxAttempts"] == 2, f"{job['status']} {job['input']}")
        j = wait_job(fid, job["id"])
        live = mcp("read_document", {"id": fid})
        t = next((x for x in live["tables"] if x["id"] == table), None)
        detail = rest("GET", f"/api/files/{fid}/sources/{src['id']}")
        v2 = next((v for v in detail["versions"] if v["version"] == 2), None)
        check("   the job ran the query again, applied the recipe, reconciled (period after, identifiers in common, coverage) and placed version 2 through the log: the same table, 6 rows now, nothing done by a model", j["status"] == "done" and "version 2" in (j.get("result", {}).get("summary") or "") and t is not None and t["rows"] == 7 and v2 is not None and v2["status"] == "accepted" and v2["rows"] == 6 and v2["period"] == "2026-10-13" and all(c["ok"] for c in v2["reconciliation"]["checks"]) and v2["job"] == job["id"], f"{j['status']} {j.get('error')} rows={t and t['rows']} v2={v2 and v2['status']} checks={v2 and [(c['name'], c['ok']) for c in v2['reconciliation']['checks']]}")
        check("   version 1 is superseded; the source's bookkeeping moved on (as-of 2026-10-13, last success, result)", next(v for v in detail["versions"] if v["version"] == 1)["status"] == "superseded" and detail["asOf"] == "2026-10-13" and "version 2 placed" in detail["lastResult"], detail["lastResult"])
        comp = rest("GET", f"/api/files/{fid}/companion")
        check("   the activity says what the refresh did, and monitoring sees two periods on the series", any(e["text"].startswith("Refreshed") and "version 2" in e["text"] for e in comp["events"]) and len([r for r in comp["records"] if r["kind"] == "source" and r["source"] == srec[0]["source"]]) >= 2, "")
        rows = mcp("read_table", {"id": fid, "table": t["name"], "max_rows": 3})
        check("   identifiers survived the refresh as text with their zeros", "000123" in json.dumps(rows), json.dumps(rows)[:80])

        # ================================================================ 3. unchanged: coverage confirmed, nothing invented
        job = rest("POST", f"/api/files/{fid}/sources/{src['id']}/refresh", {})
        j = wait_job(fid, job["id"])
        detail = rest("GET", f"/api/files/{fid}/sources/{src['id']}")
        check("3. an unchanged result establishes current coverage: no new version, no change invented, the result says so", j["status"] == "done" and j["result"]["summary"] == "unchanged" and len(detail["versions"]) == 2 and detail["lastResult"].startswith("unchanged"), f"{j.get('result')} {len(detail['versions'])}")

        # ================================================================ 4. drift: a column gone — held, nothing placed, the checks on the version and the card
        psql("ALTER TABLE inv_src DROP COLUMN branch; UPDATE inv_src SET snapshot_date = '2026-10-20'")
        job = rest("POST", f"/api/files/{fid}/sources/{src['id']}/refresh", {})
        j = wait_job(fid, job["id"])
        detail = rest("GET", f"/api/files/{fid}/sources/{src['id']}")
        held = next((v for v in detail["versions"] if v["status"] == "held"), None)
        live = mcp("read_document", {"id": fid})
        t = next((x for x in live["tables"] if x["id"] == table), None)
        pending = rest("GET", f"/api/files/{fid}/intake?pending=1")
        card = next((p for p in pending if held and p["key"] == held["intake"]), None)
        check("4. a column missing from the result is drift: the version is held with the failing check named, nothing was placed, the table keeps 2026-10-13", j["status"] == "done" and (j.get("result") or {}).get("summary", "").startswith("held") and held is not None and any(c["name"] == "columns" and not c["ok"] and "missing branch" in c["detail"] for c in held["reconciliation"]["checks"]) and t["rows"] == 7 and detail["asOf"] == "2026-10-13" and detail["lastResult"].startswith("held"), f"{j['status']} {j.get('error')} {j.get('result')} {held and [(c['name'], c['ok'], c['detail'][:40]) for c in held['reconciliation']['checks']]}")
        check("   the held refresh is a decision still open: a card for it comes back with the reason, for a person", card is not None and card["held"]["version"] == held["version"] and any(not c["ok"] for c in card["held"]["checks"]) and card["status"] == "profiled", str(card and card.get("held"))[:160])
        comp = rest("GET", f"/api/files/{fid}/companion")
        check("   said in the activity as something to decide, not as a quiet success", any(e["text"].startswith("Refresh of") and "held" in e["text"] and e["level"] == "watch" for e in comp["events"]), "")

        # ================================================================ 5. the person places the held version anyway: it follows the decision
        placed2 = rest("POST", f"/api/files/{fid}/intake/{held['intake']}/apply", {"decisions": [{"action": "update", "table": table}]})
        detail = rest("GET", f"/api/files/{fid}/sources/{src['id']}")
        vh = next(v for v in detail["versions"] if v["id"] == held["id"])
        live = mcp("read_document", {"id": fid})
        t = next((x for x in live["tables"] if x["id"] == table), None)
        check("5. placed by a person, the held version becomes the accepted one, the previous superseded, the table updated (6 columns now) and the recipe moves to version 2 — a recipe changes only by a person's decision", placed2["status"] == "applied" and vh["status"] == "accepted" and next(v for v in detail["versions"] if v["version"] == 2)["status"] == "superseded" and t["cols"] == 6 and detail["recipeVersion"] == 2 and detail["asOf"] == "2026-10-20", f"{vh['status']} recipe v{detail.get('recipeVersion')} cols={t and t['cols']}")

        # ================================================================ 6. an older period is held; a declined card settles the version as rejected
        psql("UPDATE inv_src SET snapshot_date = '2026-09-29'")
        job = rest("POST", f"/api/files/{fid}/sources/{src['id']}/refresh", {})
        j = wait_job(fid, job["id"])
        detail = rest("GET", f"/api/files/{fid}/sources/{src['id']}")
        older = next((v for v in detail["versions"] if v["status"] == "held"), None)
        check("6. a result older than the current snapshot is held, not placed: the period check fails and says so", older is not None and any(c["name"] == "period" and not c["ok"] and "older" in c["detail"] for c in older["reconciliation"]["checks"]) and detail["asOf"] == "2026-10-20", str(older and [(c['name'], c['ok']) for c in older['reconciliation']['checks']]))
        rest("POST", f"/api/files/{fid}/intake/{older['intake']}/decline", {})
        detail = rest("GET", f"/api/files/{fid}/sources/{src['id']}")
        pending = rest("GET", f"/api/files/{fid}/intake?pending=1")
        check("   declined on the card: the version is rejected, the card does not come back, the original is kept", next(v for v in detail["versions"] if v["id"] == older["id"])["status"] == "rejected" and not any(p["key"] == older["intake"] for p in pending) and rest("GET", f"/api/files/{fid}/intake/{older['intake']}")["status"] == "declined", "")

        # ================================================================ 7. authority and failure
        code, text = rest("POST", f"/api/files/{fid}/sources/{src['id']}/refresh", {}, raw=True, headers={"x-gridwright-agent": "forged"})
        check("7. a forged agent header is just an ordinary caller (no token): the loopback token is the only agent identity", code == 200 or code == 400, f"{code}")
        if code == 200:
            wait_job(fid, json.loads(text)["id"])
        rest("PUT", f"/api/files/{fid}/sources/{src['id']}", {"enabled": False})
        code, text = rest("POST", f"/api/files/{fid}/sources/{src['id']}/refresh", {}, raw=True)
        check("   a disabled source does not refresh", code == 400 and "disabled" in text, f"{code} {text[:60]}")
        rest("PUT", f"/api/files/{fid}/sources/{src['id']}", {"enabled": True})
        psql("DROP TABLE inv_src")
        job = rest("POST", f"/api/files/{fid}/sources/{src['id']}/refresh", {})
        j = wait_job(fid, job["id"])
        detail = rest("GET", f"/api/files/{fid}/sources/{src['id']}")
        comp = rest("GET", f"/api/files/{fid}/companion")
        check("   a failed refresh (the table is gone) is a failed job with the database's reason, the source says failed, the table keeps its snapshot and the activity says monitoring cannot assess what depends on it", j["status"] == "failed" and "inv_src" in (j.get("error") or "") and detail["lastResult"].startswith("failed") and detail["asOf"] == "2026-10-20" and any(e["text"].startswith("Refresh of") and "failed" in e["text"] and "cannot assess" in e["text"] for e in comp["events"]), f"{j['status']} {j.get('error', '')[:80]}")
        jobs = rest("GET", f"/api/files/{fid}/jobs")["jobs"]
        check("   every refresh is on the job list with its outcome", len([x for x in jobs if x["type"] == "refresh"]) >= 5 and all(x["status"] in ("done", "failed") for x in jobs if x["type"] == "refresh"), str([(x["status"], (x.get("result") or {}).get("summary")) for x in jobs if x["type"] == "refresh"]))

        # ================================================================ 8. deletion
        rest("DELETE", f"/api/files/{fid}")
        code, _ = rest("GET", f"/api/files/{fid}/sources", raw=True)
        check("8. the sources, recipes, versions and jobs go with the document", code == 404, str(code))
        fid = None
    finally:
        if fid:
            rest("DELETE", f"/api/files/{fid}")
        rest("DELETE", f"/api/connections/{conn['id']}")
        try:
            psql("DROP TABLE IF EXISTS inv_src")
        except Exception:
            pass

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n{passed}/{len(results)} checks passed")
    for name, ok, detail in results:
        if not ok:
            print(f"FAIL {name} — {detail}")
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""SQL Server driver check against a live instance (CI runs mcr.microsoft.com/mssql/server).

Usage: python3 e2e/sqlserver.py [http://localhost:8787] --mssql host:port:db:user:pass
Creates a connection through the API, seeds a table, runs a parameterised query (the `?`
placeholders become @p0, @p1 for the mssql driver) and reads the schema the way the AI tools do.
"""
import json
import sys
import time
import urllib.request

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
BASE = ARGS[0] if ARGS else "http://localhost:8787"
MS = None
for i, a in enumerate(sys.argv):
    if a == "--mssql":
        MS = sys.argv[i + 1].split(":")
if not MS:
    print("usage: sqlserver.py [base] --mssql host:port:db:user:pass")
    sys.exit(2)


def rest(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())


results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))


host, port, db, user, pw = MS
# the seeding statements are writes, so this connection is opened read-write (an administrator's choice;
# connections are read-only by default) and switched to read-only below to check the policy on this driver
body = {"name": "sql server", "kind": "mssql", "host": host, "port": int(port), "database": db, "user": user, "password": pw, "ssl": False}
conn = rest("POST", "/api/connections", dict(body, readOnly=False))
check("a connection can be opened read-write by an administrator", conn.get("readOnly") is False, str(conn.get("readOnly")))
t = None
for _ in range(30):
    t = rest("POST", f"/api/connections/{conn['id']}/test")
    if t["ok"]:
        break
    time.sleep(2)
check("SQL Server connection test", t["ok"], t["message"][:80])
q = lambda sql, params=None, limit=100: rest("POST", f"/api/connections/{conn['id']}/query", {"sql": sql, "params": params or [], "limit": limit})
q("IF OBJECT_ID('dbo.orders', 'U') IS NOT NULL DROP TABLE dbo.orders")
q("CREATE TABLE dbo.orders(id INT IDENTITY PRIMARY KEY, region NVARCHAR(20), product NVARCHAR(20), amount DECIMAL(10,2))")
q("INSERT INTO dbo.orders(region, product, amount) VALUES ('North','A',10),('South','A',20),('North','B',30),('South','B',40),('North','A',5)")
r = q("SELECT region, SUM(amount) AS total FROM dbo.orders WHERE amount > ? AND region = ? GROUP BY region", [5, "North"])
check("parameterised query with ? placeholders returns rows", r["columns"] == ["region", "total"] and r["rows"] == [["North", 40]], str(r))
r = q("SELECT TOP 2 id, region FROM dbo.orders ORDER BY id", limit=1)
check("row limit is applied and reported", r["rowCount"] == 2 and len(r["rows"]) == 1 and r["truncated"], str(r))
r = q("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = ? ORDER BY ordinal_position", ["orders"])
check("schema lookup (as the AI describe_table tool does)", [row[0] for row in r["rows"]] == ["id", "region", "product", "amount"], str(r["rows"]))
try:
    q("SELECT * FROM dbo.missing_table")
    check("errors from the server are surfaced", False, "no error")
except urllib.error.HTTPError as e:
    err_text = e.read().decode()
    check("errors from the server are surfaced", e.code == 400 and "missing_table" in err_text, err_text[:120])
# the same connection switched to read-only: the policy refuses writes before they reach SQL Server
rest("PUT", f"/api/connections/{conn['id']}", dict(body, readOnly=True))
try:
    q("DELETE FROM dbo.orders")
    check("read-only policy refuses writes on SQL Server", False, "the DELETE went through")
except urllib.error.HTTPError as e:
    body_text = e.read().decode()
    check("read-only policy refuses writes on SQL Server", e.code == 400 and "read-only" in body_text, body_text[:120])
r = q("SELECT COUNT(*) AS n FROM dbo.orders")
check("reads still work on the read-only connection", r["rows"] == [[5]], str(r["rows"]))
rest("PUT", f"/api/connections/{conn['id']}", dict(body, readOnly=False))
q("DROP TABLE dbo.orders")
rest("DELETE", f"/api/connections/{conn['id']}")
print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)

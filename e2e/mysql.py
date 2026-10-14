#!/usr/bin/env python3
"""MySQL / MariaDB driver and policy checks against a live server (CI runs the mariadb image).

Seeds a table through a read-write connection (an administrator's choice), then proves the
read-only policy on this driver: the text filter, the database-side read-only transaction
(@@transaction_read_only is 1 inside it), the statement timeout and the row limit.

Usage: python3 e2e/mysql.py [http://localhost:8787] --mysql host:port:db:user:pass
"""
import json
import sys
import time
import urllib.error
import urllib.request

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
BASE = ARGS[0] if ARGS else "http://localhost:8787"
MY = None
for i, a in enumerate(sys.argv):
    if a == "--mysql":
        MY = sys.argv[i + 1].split(":")
if not MY:
    print("usage: mysql.py [base] --mysql host:port:db:user:pass")
    sys.exit(2)


def rest(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())


results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))


host, port, db, user, pw = MY
body = {"name": "mariadb", "kind": "mysql", "host": host, "port": int(port), "database": db, "user": user, "password": pw, "ssl": False}
conn = rest("POST", "/api/connections", dict(body, readOnly=False))
t = None
for _ in range(30):
    t = rest("POST", f"/api/connections/{conn['id']}/test")
    if t["ok"]:
        break
    time.sleep(2)
check("MySQL connection test", t["ok"], t["message"][:80])
q = lambda sql, params=None, limit=100: rest("POST", f"/api/connections/{conn['id']}/query", {"sql": sql, "params": params or [], "limit": limit})


def refused(sql, **kw):
    try:
        q(sql, **kw)
        return None
    except urllib.error.HTTPError as e:
        return (e.code, e.read().decode())


q("DROP TABLE IF EXISTS orders")
q("CREATE TABLE orders(id INT AUTO_INCREMENT PRIMARY KEY, region VARCHAR(20), product VARCHAR(20), amount DECIMAL(10,2))")
q("INSERT INTO orders(region, product, amount) VALUES ('North','A',10),('South','A',20),('North','B',30),('South','B',40),('North','A',5)")
r = q("SELECT region, SUM(amount) AS total FROM orders WHERE amount > ? AND region = ? GROUP BY region", [5, "North"])
check("parameterised query with ? placeholders returns rows", r["columns"] == ["region", "total"] and r["rows"] == [["North", 40]], str(r))
def read_only_flag():
    """MariaDB exposes @@tx_read_only, MySQL 8 @@transaction_read_only."""
    try:
        return q("SELECT @@tx_read_only AS ro")["rows"][0][0]
    except urllib.error.HTTPError:
        return q("SELECT @@transaction_read_only AS ro")["rows"][0][0]


check("a read-write connection runs outside a read-only transaction", read_only_flag() == 0, str(read_only_flag()))

# the same connection, read-only: the policy on this driver
rest("PUT", f"/api/connections/{conn['id']}", dict(body, readOnly=True, timeoutMs=1000))
check("the database itself holds the session read-only (tx_read_only = 1)", read_only_flag() == 1, str(read_only_flag()))
# a write hidden inside a SELECT passes the text filter; the read-only transaction refuses it
rest("PUT", f"/api/connections/{conn['id']}", dict(body, readOnly=False))
q("CREATE SEQUENCE IF NOT EXISTS gw_seq")
rest("PUT", f"/api/connections/{conn['id']}", dict(body, readOnly=True, timeoutMs=1000))
code, text = refused("SELECT NEXTVAL(gw_seq) AS n") or (None, "")
check("the database refuses a write hidden inside SELECT (sequence advance in a read-only transaction)", code == 400 and "READ ONLY" in text.upper(), f"{code} {text[:100]}")
code, text = refused("DELETE FROM orders") or (None, "")
check("writes are refused before they reach the database", code == 400 and "read-only" in text, f"{code} {text[:80]}")
code, text = refused("SELECT SLEEP(3)") or (None, "")
check("a statement past the connection's time limit is interrupted by the database", code == 400 and any(w in text.lower() for w in ("interrupted", "timeout", "max_statement_time", "exceeded")), f"{code} {text[:100]}")
r = q("SELECT id, region FROM orders ORDER BY id", limit=2)
check("row limit is applied on the server and reported as truncation", len(r["rows"]) == 2 and r["truncated"] and r["rowCount"] == 3, str(r))
r = q("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position", ["orders"])
check("schema lookup (as the AI describe_table tool does)", [row[0] for row in r["rows"]] == ["id", "region", "product", "amount"], str(r["rows"]))
code, text = refused("SELECT * FROM missing_table") or (None, "")
check("errors from the server are surfaced", code == 400 and "missing_table" in text, text[:100])

rest("PUT", f"/api/connections/{conn['id']}", dict(body, readOnly=False))
q("DROP SEQUENCE IF EXISTS gw_seq")
q("DROP TABLE orders")
rest("DELETE", f"/api/connections/{conn['id']}")
print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)

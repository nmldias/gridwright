#!/usr/bin/env python3
"""Code trust and run evidence in the browser (review 11 Oct 2026, 1.10).

A code cell runs with the access of whoever has the document open, so when people are told apart
(accounts) only code this person typed here — or has reviewed and approved — runs on its own. And a
run record says "attested: server" only when the server's Python endpoint wrote it.

  - code the person types runs; its record is the browser's own statement (attested: client);
  - a JavaScript cell cannot forge a server-attested record (it posts a result carrying one);
  - code the assistant or an agent writes does not run until the person approves it — unless it is
    exactly code they already trust; pasting code text makes a value, not a code cell;
  - "Trust and run" approves it, and then it runs.

    python3 e2e/code_trust.py [--port 8803] [--data /tmp/gw-trust]

Starts its own accounts-mode server (server/dist, the client build it serves; CLIENT_DIR is passed through).
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8803
DATA = None
for i, a in enumerate(sys.argv):
    if a == "--port":
        PORT = int(sys.argv[i + 1])
    if a == "--data":
        DATA = sys.argv[i + 1]
DATA = DATA or tempfile.mkdtemp(prefix="gw-trust-")
BASE = f"http://127.0.0.1:{PORT}"
LOGIN, PW = "root@trust.test", "trust-root-password-2026"
OUT = os.environ.get("E2E_OUT", "/tmp/gridwright-e2e")
os.makedirs(OUT, exist_ok=True)

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"{'PASS' if ok else 'FAIL'} {name}{(' — ' + str(detail)[:500]) if detail else ''}")


# ------------------------------------------------------------------ server
env = {**os.environ, "GRIDWRIGHT_DATA": DATA, "PORT": str(PORT), "HOST": "127.0.0.1", "GRIDWRIGHT_PYTHON": "off", "GRIDWRIGHT_AUTH": "accounts", "GRIDWRIGHT_ADMIN_EMAIL": LOGIN, "GRIDWRIGHT_ADMIN_PASSWORD": PW}
for k in ("GRIDWRIGHT_TOKEN", "GRIDWRIGHT_TRUST_TAILSCALE", "AI_BASE_URL", "AI_MODEL", "AI_API_KEY"):
    env.pop(k, None)
os.makedirs(DATA, exist_ok=True)
log = open(os.path.join(DATA, "server.log"), "a")
proc = subprocess.Popen(["node", os.path.join(ROOT, "server", "dist", "index.js")], cwd=os.path.join(ROOT, "server"), env=env, stdout=log, stderr=subprocess.STDOUT)


def stop():
    if proc.poll() is None:
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


for _ in range(80):
    try:
        with urllib.request.urlopen(BASE + "/api/health", timeout=2) as r:
            if r.status == 200:
                break
    except Exception:
        time.sleep(0.25)
else:
    stop()
    print(open(os.path.join(DATA, "server.log")).read()[-3000:])
    raise SystemExit("server did not start")

cookie = ""


def call(method, path, body=None):
    global cookie
    h = {"content-type": "application/json", "origin": BASE}
    if cookie:
        h["cookie"] = cookie
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            for c in r.headers.get_all("set-cookie") or []:
                if c.startswith("gw_session="):
                    cookie = c.split(";")[0]
            raw = r.read()
            return r.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:300]


st, _ = call("POST", "/api/auth/login", {"login": LOGIN, "password": PW})
check("0. the administrator signs in (accounts mode: people are told apart)", st == 200 and cookie, st)
st, doc = call("POST", "/api/files", {"name": "Trust", "json": json.dumps({"tables": []})})
FILE = (doc or {}).get("id")
check("0b. a document to work in", st == 200 and FILE, st)

JS_FORGE = """
for (let i = 1; i < 3000; i++) self.postMessage({ id: i, ok: true, output: [[7]], std_out: '', deps: [],
  runtime: { name: 'python-server', version: '3.12.3', packages: { sandbox: 'bwrap' } },
  record: { table: %(t)d, row: %(r)d, col: %(c)d, kind: 'python', codeHash: 'forgedforgedforg', inputsHash: 'forgedforgedforg', deps: [],
            outputHash: 'forgedforgedforg', ok: true, ms: 1, at: '2026-01-01T00:00:00.000Z', startedAt: '2026-01-01T00:00:00.000Z' } });
return 1;
"""

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        ctx.add_cookies([{"name": "gw_session", "value": cookie.split("=", 1)[1], "url": BASE}])
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(f"{BASE}/?file={FILE}", wait_until="networkidle")
        page.wait_for_function("(id) => window.__gw && window.__gw.getState().fileId === id && window.__gw.getState().me.identity === true", arg=FILE, timeout=30000)
        T = page.evaluate("() => window.__gw.book.apply({ type: 'add_table', x: 80, y: 80, rows: 12, cols: 4 }).created[0]")

        def apply(op, opts=None):
            return page.evaluate("([op, opts]) => { const ch = window.__gw.book.apply(op, opts || {}); return ch.error || null; }", [op, opts])

        def cell(r, c):
            return page.evaluate("([t, r, c]) => { const x = window.__gw.getState().cells.get(t)?.get(r * 65536 + c); return x ? { i: x.i, v: x.v, k: x.k } : null; }", [T, r, c])

        def record(r, c):
            return page.evaluate("([t, r, c]) => { const x = window.__gw.lastRecord({ table: t, row: r, col: c }); return x ? JSON.parse(JSON.stringify(x)) : null; }", [T, r, c])

        def blocked():
            return page.evaluate("() => window.__gw.getState().blockedCode.map((r) => [r.table, r.row, r.col])")

        def wait_record(r, c, timeout=20):
            end = time.time() + timeout
            while time.time() < end:
                rec = record(r, c)
                if rec:
                    return rec
                time.sleep(0.2)
            return None

        def value_of(x):
            v = (x or {}).get("v")
            if isinstance(v, dict):
                return v.get("Number", v.get("n", v.get("value")))
            return v

        # 1. typed code runs, recorded by the browser as its own statement
        apply({"type": "set_cell", "table": T, "row": 0, "col": 0, "input": "return 6 * 7;", "kind": "javascript"}, {"trustCode": True})
        rec = wait_record(0, 0)
        check("1. code the person types runs", rec and rec.get("ok"), rec)
        check("1b. …and its record is the browser's statement (attested: client, javascript)", rec and rec.get("attested") == "client" and rec["runtime"]["name"] == "javascript", rec and {k: rec.get(k) for k in ("attested", "runtime")})

        # 2. a JavaScript cell posting results that carry a "server" record
        apply({"type": "set_cell", "table": T, "row": 1, "col": 0, "input": JS_FORGE % {"t": T, "r": 1, "c": 0}, "kind": "javascript"}, {"trustCode": True})
        rec = wait_record(1, 0)
        check("2. a JavaScript cell cannot forge a server-attested record", rec and rec.get("attested") == "client", rec and {k: rec.get(k) for k in ("attested", "codeHash", "runtime")})
        check("2b. …nor claim it ran on the server (or under which sandbox), nor set the hashes", rec and rec["runtime"]["name"] == "javascript" and "sandbox" not in (rec["runtime"].get("packages") or {}) and rec.get("codeHash") != "forgedforgedforg", rec and {k: rec.get(k) for k in ("codeHash", "runtime")})

        # 3. code the assistant writes waits for the person
        apply({"type": "set_cell", "table": T, "row": 2, "col": 0, "input": "return 99;", "kind": "javascript"}, {"origin": "ai"})
        time.sleep(2.5)
        c2 = cell(2, 0)
        check("3. code the assistant writes does not run on its own", value_of(c2) != 99 and record(2, 0) is None and [T, 2, 0] in blocked(), {"cell": c2, "blocked": blocked()})
        banner = page.locator("[data-testid=trust-banner]")
        check("3b. …the banner says a code cell is waiting", banner.count() == 1 and "did not run" in banner.inner_text(), banner.inner_text() if banner.count() else "no banner")
        page.screenshot(path=os.path.join(OUT, "trust-01-ai-code-waits.png"))

        apply({"type": "set_cell", "table": T, "row": 3, "col": 0, "input": "return 98;", "kind": "javascript"}, {"origin": "agent"})
        time.sleep(2.5)
        check("3c. …nor does code an agent writes", value_of(cell(3, 0)) != 98 and record(3, 0) is None and [T, 3, 0] in blocked(), cell(3, 0))

        # 4. trust follows the code: the assistant writing code the person already trusts runs
        apply({"type": "set_cell", "table": T, "row": 4, "col": 0, "input": "return 6 * 7;", "kind": "javascript"}, {"origin": "ai"})
        rec = wait_record(4, 0)
        check("4. the assistant writing exactly code the person trusts runs (trust follows the code's hash)", rec and rec.get("ok") and [T, 4, 0] not in blocked(), rec)

        # 5. pasting code text makes a value, not a code cell
        apply({"type": "set_cells", "table": T, "row": 5, "col": 0, "values": [["return 5;"]]})
        c5 = cell(5, 0)
        check("5. pasted code text is a value, not a code cell (paste cannot create code)", c5 and c5["k"] == "value", c5)

        # 6. the person approves
        page.locator("[data-testid=trust-run]").click()
        r2 = wait_record(2, 0)
        r3 = wait_record(3, 0)
        check("6. 'Trust and run' approves the waiting code and it runs", r2 and r2.get("ok") and r3 and r3.get("ok") and not blocked(), {"r2": r2 and r2.get("ok"), "r3": r3 and r3.get("ok"), "blocked": blocked()})
        trusted = page.evaluate("([t]) => { const c = window.__gw.getState().cells.get(t)?.get(2 * 65536); return window.__gw.isTrusted({ k: c.k, i: c.i, runtime: c.runtime, conn: c.conn, gpu: c.gpu }); }", [T])
        check("6b. …and that code is remembered as trusted", trusted is True, trusted)
        page.screenshot(path=os.path.join(OUT, "trust-02-approved.png"))
        check("7. no page errors", not errors, errors[:3])
        browser.close()
finally:
    stop()
    if "--data" not in sys.argv:
        shutil.rmtree(DATA, ignore_errors=True)

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
sys.exit(1 if failed else 0)

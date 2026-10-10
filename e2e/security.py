#!/usr/bin/env python3
"""Security regression suite (the 2026-10 audit's findings, fixed): starts its own accounts-mode
server on a throwaway data directory and checks each defence from the outside.

    python3 e2e/security.py [port]

Needs the built server (server/dist) and client (client/dist). The browser checks (the code
sandbox and code trust) need Playwright; they are skipped when it is not installed.
"""
import json, os, shutil, socket, subprocess, sys, tempfile, time, urllib.error, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, "server", "dist", "index.js")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8851
BASE = f"http://127.0.0.1:{PORT}"
DATA = tempfile.mkdtemp(prefix="gw-security-")
ROOT_LOGIN, ROOT_PW = "root@security.test", "root-password-2026"
DOC = json.dumps({"tables": []})
failures = []
passed = 0


def ok(cond, what):
    global passed
    if cond:
        passed += 1
        print(f"  ok  {what}")
    else:
        failures.append(what)
        print(f"FAIL  {what}")


def section(name):
    print(f"\n== {name}")


# ------------------------------------------------------------------ the server
proc = None


def start(env_extra=None):
    global proc
    env = {**os.environ, "GRIDWRIGHT_DATA": DATA, "PORT": str(PORT), "HOST": "127.0.0.1", "GRIDWRIGHT_AUTH": "accounts",
           "GRIDWRIGHT_ADMIN_EMAIL": ROOT_LOGIN, "GRIDWRIGHT_ADMIN_PASSWORD": ROOT_PW, "GRIDWRIGHT_PYTHON": "off",
           "GRIDWRIGHT_INBOX": os.path.join(DATA, "inbox"), **(env_extra or {})}
    for k in ("GRIDWRIGHT_TOKEN", "GRIDWRIGHT_TRUST_TAILSCALE", "AI_BASE_URL", "AI_MODEL", "AI_API_KEY", "GRIDWRIGHT_EGRESS_ALLOW", "GRIDWRIGHT_EGRESS_GUARD"):
        if k not in (env_extra or {}):
            env.pop(k, None)
    proc = subprocess.Popen(["node", SERVER], cwd=os.path.join(ROOT, "server"), env=env,
                            stdout=open(os.path.join(DATA, "server.log"), "a"), stderr=subprocess.STDOUT)
    for _ in range(80):
        try:
            with urllib.request.urlopen(BASE + "/api/health", timeout=2) as r:
                if r.status == 200:
                    return
        except Exception:
            time.sleep(0.25)
    print(open(os.path.join(DATA, "server.log")).read()[-3000:])
    raise SystemExit("server did not start")


def stop():
    global proc
    if proc:
        proc.terminate()
        try:
            proc.wait(10)
        except Exception:
            proc.kill()
        proc = None


class Client:
    def __init__(self, tenant=None, origin=None):
        self.cookie, self.tenant, self.origin = "", tenant, origin

    def call(self, method, path, body=None, headers=None):
        h = {"content-type": "application/json"}
        if self.cookie:
            h["cookie"] = self.cookie
        if self.tenant:
            h["x-gridwright-tenant"] = self.tenant
        if self.origin:
            h["origin"] = self.origin
        h.update(headers or {})
        req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                self._cookie(r.headers.get_all("set-cookie") or [])
                raw = r.read()
                return r.status, (json.loads(raw) if raw and r.headers.get("content-type", "").startswith("application/json") else raw), r.headers
        except urllib.error.HTTPError as e:
            self._cookie(e.headers.get_all("set-cookie") or [])
            raw = e.read()
            try:
                return e.code, json.loads(raw), e.headers
            except Exception:
                return e.code, raw, e.headers

    def _cookie(self, cookies):
        for c in cookies:
            first = c.split(";")[0]
            if first.startswith("gw_session="):
                self.cookie = "" if first == "gw_session=" else first

    def login(self, login, pw):
        return self.call("POST", "/api/auth/login", {"login": login, "password": pw})

    def get(self, p):
        return self.call("GET", p)

    def post(self, p, b=None):
        return self.call("POST", p, b if b is not None else {})

    def put(self, p, b):
        return self.call("PUT", p, b)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def xlsx(rows, cols=20, cell=b'<c t="n"><v>1</v></c>'):
    """An .xlsx built in memory; the sheet XML streams into the zip (it may inflate enormously)."""
    import io, zipfile
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
                   '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                   '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        z.writestr("xl/workbook.xml", '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                   '<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
        with z.open("xl/worksheets/sheet1.xml", "w", force_zip64=False) as f:
            f.write(b'<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>')
            row = b"<row>" + cell * cols + b"</row>"
            chunk = row * 1000
            for _ in range(rows // 1000):
                f.write(chunk)
            f.write(b"</sheetData></worksheet>")
    return out.getvalue()


try:
    start()
    root = Client()
    st, _, _ = root.login(ROOT_LOGIN, ROOT_PW)
    assert st == 200, "the platform administrator cannot sign in"

    # ---------------------------------------------------------------- H3: egress guard
    section("H3 egress guard: client-controlled endpoints may not reach private networks")
    blocked_urls = [
        "http://127.0.0.1:9/v1", "http://localhost:9/v1", "http://169.254.169.254/latest", "http://[::1]:9/v1",
        "http://10.0.0.1/v1", "http://192.168.1.1/v1", "http://0.0.0.0:9/v1", "http://2130706433/v1",
        "http://[::ffff:169.254.169.254]/v1", "http://100.64.0.1/v1",
    ]
    for u in blocked_urls:
        st, r, _ = root.put("/api/ai/settings", {"baseUrl": u, "model": "m"})
        ok(st == 400 and "private or reserved" in json.dumps(r), f"a client's model endpoint {u} is refused")
    st, r, _ = root.put("/api/ai/settings", {"baseUrl": "https://user:pw@api.example.com/v1", "model": "m"})
    ok(st == 400, "credentials inside the endpoint URL are refused")
    st, r, _ = root.get("/api/ai/settings")
    ok(st == 200 and not r.get("baseUrl"), "…and nothing was saved")

    for host in ["127.0.0.1", "localhost", "169.254.169.254", "10.1.2.3", "[::1]", "192.168.0.10", "2130706433"]:
        st, r, _ = root.post("/api/connections", {"name": "x", "kind": "postgres", "host": host, "port": 5432, "database": "d", "user": "u"})
        ok(st == 400 and "private or reserved" in json.dumps(r), f"a database host {host} is refused")
    for host in ["db;rm -rf", "a b", "-oProxyCommand", "x" * 300]:
        st, r, _ = root.post("/api/connections", {"name": "x", "kind": "postgres", "host": host, "port": 5432})
        ok(st == 400, f"a malformed host {host[:20]!r} is refused")
    st, r, _ = root.post("/api/connections", {"name": "x", "kind": "postgres", "host": "db.example.com", "port": 99999})
    ok(st == 400 and "port" in json.dumps(r), "an out-of-range port is refused")
    st, r, _ = root.post("/api/connections", {"name": "x", "kind": "postgres", "host": "db.example.com", "port": 5432.5})
    ok(st == 400, "a fractional port is refused")

    # a public name is accepted (resolution failure at save time is not fatal: the connect-time
    # check still applies) — and a connection that only fails at connect time leaks no detail
    st, conn, _ = root.post("/api/connections", {"name": "public", "kind": "postgres", "host": "db.invalid", "port": 5432, "database": "d", "user": "u"})
    ok(st == 200 and conn.get("id"), "a public-looking database host is accepted")
    if st == 200:
        st, r, _ = root.post(f"/api/connections/{conn['id']}/test")
        msg = json.dumps(r)
        ok(st == 200 and r.get("ok") is False and "could not be reached" in msg and "ENOTFOUND" not in msg and "getaddrinfo" not in msg,
           "a failing connection reports no network detail")

    # the platform's own endpoint is the operator's choice: not guarded
    st, r, _ = root.put("/api/platform/ai", {"baseUrl": "http://127.0.0.1:9/v1", "model": "m"})
    ok(st == 200, "the platform default endpoint may be on loopback (the operator's choice)")
    st, r, _ = root.get("/api/ai/v1/models")
    msg = json.dumps(r)
    ok(st == 502, "the platform endpoint's failure is reported (operator-facing detail allowed)")
    root.put("/api/platform/ai", {"baseUrl": "", "model": ""})

    # connect time: a name that passed when it was saved but now resolves privately (DNS rebinding)
    # is refused by the connection's own lookup — checked directly on the guarded primitives
    probe = r"""
import { guardedSocket, GuardedSocket, guardedFetch } from './dist/netguard.js';
import net from 'node:net';
const srv = net.createServer((s) => s.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok')).listen(0, '127.0.0.1');
await new Promise((r) => srv.once('listening', r));
const port = srv.address().port;
const out = {};
const sock = (mk) => new Promise((res) => { const s = mk(); s.once('connect', () => { res('CONNECTED'); s.destroy(); }); s.once('error', (e) => res(e.code || e.message)); });
out.socket = await sock(() => guardedSocket('localhost', port));
out.literal = await sock(() => { try { return guardedSocket('127.0.0.1', port); } catch (e) { const s = new net.Socket(); process.nextTick(() => s.emit('error', e)); return s; } });
out.pg = await sock(() => new GuardedSocket().connect(port, 'localhost'));
try { await guardedFetch(`http://localhost:${port}/`); out.fetch = 'FETCHED'; } catch (e) { out.fetch = e.cause?.code || e.code || e.message; }
srv.close();
console.log(JSON.stringify(out));
"""
    r = subprocess.run(["node", "--input-type=module", "-e", probe], cwd=os.path.join(ROOT, "server"), capture_output=True, text=True, timeout=60,
                       env={**os.environ, "GRIDWRIGHT_AUTH": "accounts", "GRIDWRIGHT_EGRESS_ALLOW": ""})
    try:
        res = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        res = {"error": (r.stdout + r.stderr)[-400:]}
    ok(res.get("socket") == "EGRESS_BLOCKED", f"a TCP connection to a name resolving to loopback is refused at connect time ({res.get('socket')})")
    ok(res.get("literal") == "EGRESS_BLOCKED", f"…and to a loopback address literal ({res.get('literal')})")
    ok(res.get("pg") == "EGRESS_BLOCKED", f"…through the socket handed to the Postgres driver ({res.get('pg')})")
    ok(res.get("fetch") == "EGRESS_BLOCKED", f"…and an HTTP request to it ({res.get('fetch')})")

    # ---------------------------------------------------------------- H4: imports in isolation
    section("H4 imports: a crafted workbook cannot stall or exhaust the server")
    import base64, threading
    st, doc, _ = root.post("/api/files", {"name": "Import target", "json": DOC})
    IDOC = doc["id"]
    small = xlsx(3000, cols=4, cell=b'<c t="n"><v>7</v></c>')
    st, r, _ = root.post(f"/api/files/{IDOC}/intake", {"name": "ok.xlsx", "base64": base64.b64encode(small).decode()})
    ok(st == 200 and r.get("sets") and r["sets"][0].get("dataRows", 0) >= 2999, f"an ordinary workbook still imports in the worker ({st}, {r['sets'][0].get('dataRows') if isinstance(r, dict) and r.get('sets') else r})")

    bomb = xlsx(1_200_000, cols=20)  # ~230 MB of sheet XML in a few hundred KB
    t0 = time.time()
    st, r, _ = root.post(f"/api/files/{IDOC}/intake", {"name": "bomb.xlsx", "base64": base64.b64encode(bomb).decode()})
    took = time.time() - t0
    ok(st == 400 and "inflates to" in json.dumps(r) and took < 5, f"a {len(bomb)//1024} KB workbook inflating to ~230 MB is refused before parsing ({st}, {took:.1f} s)")

    heavy = xlsx(270_000, cols=20)  # ~120 MB inflated: under the limit, so it is parsed in the worker
    result = {}

    def upload():
        result["st"], result["r"], _ = root.post(f"/api/files/{IDOC}/intake", {"name": "heavy.xlsx", "base64": base64.b64encode(heavy).decode()})

    th = threading.Thread(target=upload)
    th.start()
    time.sleep(1.0)
    worst = 0.0
    while th.is_alive():
        t1 = time.time()
        try:
            urllib.request.urlopen(BASE + "/api/health", timeout=10).read()
        except Exception:
            worst = 99
        worst = max(worst, time.time() - t1)
        time.sleep(0.25)
    th.join()
    ok(worst < 1.0, f"the server keeps answering while a heavy workbook is parsed (slowest health check {worst:.2f} s)")
    ok(result.get("st") in (200, 400), f"…and the heavy import ends with an answer, not a crash ({result.get('st')}: {json.dumps(result.get('r'))[:140]})")
    st, _, _ = root.get("/api/health")
    ok(st == 200, "the server is still up afterwards")
    big = "x" * (3 * 1024 * 1024)
    st, _, _ = root.put("/api/tenant", {"name": big})
    ok(st == 413, f"a 3 MB body to an ordinary endpoint is refused ({st})")

    # ---------------------------------------------------------------- M4, L2, L3: headers and proxies
    section("M4 security headers; L2/L3 forwarded headers only from a trusted proxy")
    for path in ["/", "/api/health"]:
        st, _, h = Client().get(path)
        csp = h.get("content-security-policy") or ""
        ok("frame-ancestors 'self'" in csp and "object-src 'none'" in csp and "'unsafe-eval'" not in csp.replace("'wasm-unsafe-eval'", ""), f"{path}: a Content-Security-Policy without unsafe-eval")
        ok(h.get("x-content-type-options") == "nosniff" and h.get("x-frame-options") == "SAMEORIGIN" and h.get("referrer-policy") and h.get("cross-origin-opener-policy") == "same-origin", f"{path}: nosniff, frame, referrer and opener policies")
    st, _, h = Client().get("/api/health")
    ok("no-store" in (h.get("cache-control") or ""), "API answers are not cached")
    st, _, h = Client().call("GET", "/sandbox/js.html")
    ok(st == 200 and "connect-src 'none'" in (h.get("content-security-policy") or "") and h.get_all("content-security-policy") and len(h.get_all("content-security-policy")) == 1, "the code sandbox page keeps its own single, stricter policy")
    # without GRIDWRIGHT_TRUST_PROXY: forwarded headers are ignored
    st, _, h = Client().get("/api/health")
    ok(not h.get("strict-transport-security"), "no HSTS over plain HTTP")
    c = Client()
    st, _, h = c.call("POST", "/api/auth/login", {"login": ROOT_LOGIN, "password": ROOT_PW}, {"x-forwarded-proto": "https"})
    sc = " ".join(h.get_all("set-cookie") or [])
    ok(st == 200 and "Secure" not in sc, "X-Forwarded-Proto from an untrusted peer does not decide the cookie's Secure flag (L3)")
    st, _, h = Client().call("GET", "/api/health", None, {"x-forwarded-proto": "https"})
    ok(not h.get("strict-transport-security"), "…nor HSTS")
    st, r, _ = root.call("PUT", "/api/tenant", {"name": "x"}, {"origin": "https://evil.example", "x-forwarded-host": "evil.example"})
    ok(st == 403, "an Origin matching only an untrusted X-Forwarded-Host is refused (L2)")
    # with a trusted proxy on loopback, the same headers are honoured
    stop()
    start({"GRIDWRIGHT_TRUST_PROXY": "1"})
    c = Client()
    st, _, h = c.call("POST", "/api/auth/login", {"login": ROOT_LOGIN, "password": ROOT_PW}, {"x-forwarded-proto": "https"})
    sc = " ".join(h.get_all("set-cookie") or [])
    ok(st == 200 and "Secure" in sc and "HttpOnly" in sc, "behind a trusted proxy that says HTTPS, the session cookie is Secure")
    st, _, h = Client().call("GET", "/api/health", None, {"x-forwarded-proto": "https"})
    ok("max-age=" in (h.get("strict-transport-security") or ""), "…and HSTS is sent")
    root = Client()
    root.login(ROOT_LOGIN, ROOT_PW)
    st, me, _ = root.get("/api/me")
    st, r, _ = root.call("PUT", "/api/tenant", {"name": me["tenant"]["name"]}, {"origin": "https://grid.example", "x-forwarded-host": "grid.example"})
    ok(st == 200, f"…and the proxy's X-Forwarded-Host counts for the origin check ({st})")

    # ---------------------------------------------------------------- M2, M3: sign-in throttling
    # (the server trusts the loopback proxy now, so X-Forwarded-For names the caller's address)
    section("M3 sign-in throttling: per address, persistent, and no lock-out of a known account")
    TRUST = {"GRIDWRIGHT_TRUST_PROXY": "1"}

    def attempt(login, pw, ip):
        return Client().call("POST", "/api/auth/login", {"login": login, "password": pw}, {"x-forwarded-for": ip})

    def make_person(login, pw):
        st, u, _ = root.post("/api/platform/users", {"login": login, "password": pw})
        c = Client()
        st2, r2, _ = c.login(login, pw)
        c.post("/api/auth/password", {"current": pw, "next": pw + "-own"})
        return st, u, r2

    st, u, first = make_person("victim@security.test", "victim-password-2026")
    ok(st == 200 and u.get("mustChangePassword") is True and first.get("mustChangePassword") is True, "a password the platform chose for someone must be changed at first sign-in (L1)")
    VPW = "victim-password-2026-own"
    codes = [attempt("victim@security.test", "wrong-password", "203.0.113.5")[0] for _ in range(8)]
    ok(codes == [401] * 8, "eight wrong passwords from one address are answered normally")
    st, r, h = attempt("victim@security.test", VPW, "203.0.113.5")
    ok(st == 429 and int(h.get("retry-after") or 0) > 60, f"…then that address is held off for this account, even with the right password ({st}, retry-after {h.get('retry-after')})")
    st, _, _ = attempt("victim@security.test", VPW, "198.51.100.7")
    ok(st == 200, "…while the account's owner, elsewhere, still signs in: failing on purpose locks nobody out (M3)")
    for i in range(30):
        attempt(f"nobody{i}@security.test", "x", "203.0.113.9")
    st, _, _ = attempt(ROOT_LOGIN, ROOT_PW, "203.0.113.9")
    ok(st == 429, "an address failing across many accounts is held off for all of them")
    stop()
    start(TRUST)
    st, _, _ = attempt("victim@security.test", VPW, "203.0.113.5")
    ok(st == 429, "the counters survive a restart (M3)")
    # across addresses an account only slows down
    make_person("victim2@security.test", "victim2-password-2026")
    V2 = "victim2-password-2026-own"
    codes = [attempt("victim2@security.test", "wrong", f"192.0.2.{10 + i // 7}")[0] for i in range(20)]
    ok(codes == [401] * 20, "twenty failures for one account from several addresses (each under its limit)")
    st, _, h = attempt("victim2@security.test", V2, "192.0.2.99")
    wait = int(h.get("retry-after") or 0)
    ok(st == 429 and 0 < wait <= 30, f"…slow the account down by a short pause, not a lock-out ({st}, {wait} s)")
    time.sleep(wait + 0.3)
    st, _, _ = attempt("victim2@security.test", V2, "192.0.2.99")
    ok(st == 200, "…after which the right password signs in")
    root = Client()
    root.login(ROOT_LOGIN, ROOT_PW)

    # ---------------------------------------------------------------- L5, L6
    section("L5 a connection names its host; L6 an API token cannot be pointed at another client")
    st, r, _ = root.post("/api/connections", {"name": "nohost", "kind": "postgres", "port": 5432, "database": "d", "user": "u"})
    ok(st == 400 and "host" in json.dumps(r), "a database connection without a host is refused (no silent localhost)")
    st, t, _ = root.post("/api/account/tokens", {"label": "sec"})
    tok = t.get("token", "") if isinstance(t, dict) else ""
    st, other, _ = root.post("/api/platform/tenants", {"name": "Token Other"})
    st, r, _ = Client().call("GET", "/api/files", None, {"authorization": f"Bearer {tok}"})
    ok(st == 200, "an API token works in its own client")
    st, r, _ = Client().call("GET", "/api/files", None, {"authorization": f"Bearer {tok}", "x-gridwright-tenant": other["tenant"]["id"]})
    ok(st == 403 and r.get("denied") == "token-client", "naming another client with it is refused, not silently ignored")

    # ---------------------------------------------------------------- M2
    section("M2 nobody is put into a client without consenting; adding reveals no account")
    st, known, _ = root.post("/api/tenant/members", {"login": "victim@security.test", "role": "admin"})
    st2, ghost, _ = root.post("/api/tenant/members", {"login": "ghost@security.test", "role": "admin"})
    ok(st == 200 and known.get("invited") is True and known.get("link", "").startswith("/?invite=gwi_"), "adding an existing account makes an invitation")
    ok(st2 == 200 and sorted(known) == sorted(ghost), "…answered exactly like an e-mail with no account (no discovery)")
    st, mem, _ = root.get("/api/tenant/members")
    ok("victim@security.test" not in json.dumps(mem), "…and the person is not a member until they accept")

    # ---------------------------------------------------------------- M5: AI rate and budget per client
    section("M5 AI cost control: per-client budget, per-person rate, usage on record")
    import http.server, threading
    seen = []

    class MockLLM(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _json(self, obj):
            body = json.dumps(obj).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self._json({"object": "list", "data": [{"id": "mock"}]})

        def do_POST(self):
            b = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
            seen.append(b)
            usage = None if "/nousage/" in self.path else {"prompt_tokens": 60, "completion_tokens": 40, "total_tokens": 100}
            if not b.get("stream"):
                return self._json({"id": "c1", "object": "chat.completion", "model": "mock", "choices": [{"index": 0, "message": {"role": "assistant", "content": "Hello"}, "finish_reason": "stop"}], **({"usage": usage} if usage else {})})
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()
            for piece in ["Hel", "lo"]:
                self.wfile.write(f'data: {json.dumps({"choices": [{"index": 0, "delta": {"content": piece}}]})}\n\n'.encode())
            self.wfile.write(f'data: {json.dumps({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})}\n\n'.encode())
            if usage:
                self.wfile.write(f'data: {json.dumps({"choices": [], "usage": usage})}\n\n'.encode())
            self.wfile.write(b"data: [DONE]\n\n")

    mock = http.server.ThreadingHTTPServer(("127.0.0.1", 0), MockLLM)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    MOCK = f"http://127.0.0.1:{mock.server_address[1]}"
    stop()
    start({**TRUST, "GRIDWRIGHT_AI_RPM_PERSON": "3"})
    root = Client()
    root.login(ROOT_LOGIN, ROOT_PW)
    st, _, _ = root.put("/api/platform/ai", {"baseUrl": MOCK + "/v1", "model": "mock", "apiKey": "k"})
    st, q, _ = root.post("/api/platform/tenants", {"name": "Quota Co"})
    QID = q["tenant"]["id"]
    st, est, _ = root.post("/api/platform/tenants", {"name": "Estimate Co"})
    EID = est["tenant"]["id"]
    st, v, _ = root.put(f"/api/platform/tenants/{QID}/ai-budget", {"monthlyTokens": 250})
    ok(st == 200 and v["budget"] == {"tokens": 250, "own": True}, "the platform sets a client's monthly budget")
    root.tenant = QID
    msgs = [{"role": "user", "content": "hi"}]
    st, r, _ = root.post("/api/ai/v1/chat/completions", {"model": "default", "messages": msgs})
    ok(st == 200 and r.get("usage", {}).get("total_tokens") == 100 and "stream_options" not in seen[-1], "the pass-through answers unchanged (and its request is forwarded unchanged)")
    st, u, _ = root.get("/api/tenant/ai-usage")
    ok(st == 200 and u["usage"]["requests"] == 1 and u["usage"]["totalTokens"] == 100 and u["usage"]["estimated"] is False, f"…and the endpoint's own token count is recorded for the client ({u.get('usage') if isinstance(u, dict) else u})")
    st, raw, _ = root.post("/api/ai/chat", {"messages": msgs})
    ok(st == 200 and seen[-1].get("stream_options", {}).get("include_usage") is True, "the assistant asks the endpoint for its token count")
    st, raw, _ = root.post("/api/ai/v1/chat/completions", {"model": "default", "messages": msgs, "stream": True})
    ok(st == 200 and b"Hel" in (raw if isinstance(raw, bytes) else b""), "a streamed pass-through answer arrives")
    time.sleep(0.3)
    st, u, _ = root.get("/api/tenant/ai-usage")
    ok(u["usage"]["requests"] == 3 and u["usage"]["totalTokens"] == 300, f"assistant and streamed calls are counted too ({u['usage']})")
    st, r, _ = root.post("/api/ai/v1/chat/completions", {"model": "default", "messages": msgs})
    ok(st == 429 and "AI budget" in json.dumps(r), f"over its monthly budget the client's calls are refused ({st})")
    st, r, _ = root.post("/api/ai/chat", {"messages": msgs})
    ok(st == 429, "…the assistant's too")
    root.put(f"/api/platform/tenants/{QID}/ai-budget", {"monthlyTokens": None})
    st, r, h = root.post("/api/ai/v1/chat/completions", {"model": "default", "messages": msgs})
    ok(st == 429 and "a minute" in json.dumps(r) and int(h.get("retry-after") or 0) > 0, f"with no budget limit, the per-person rate still applies ({st}, retry-after {h.get('retry-after')})")
    root.put(f"/api/platform/tenants/{QID}/ai-budget", {"monthlyTokens": 0})
    st, r, _ = root.post("/api/ai/v1/chat/completions", {"model": "default", "messages": msgs})
    ok(st == 429 and "turned off" in json.dumps(r), "a budget of 0 turns AI off for the client")
    st, _, _ = root.put(f"/api/platform/tenants/{QID}/ai-budget", {"monthlyTokens": -5})
    ok(st == 400, "a negative budget is refused")
    # usage is per client; an endpoint that reports nothing is estimated
    root.put("/api/platform/ai", {"baseUrl": MOCK + "/nousage/v1", "model": "mock"})
    other_person = Client(tenant=EID)
    other_person.cookie = root.cookie
    st, r, _ = other_person.post("/api/ai/v1/chat/completions", {"model": "default", "messages": [{"role": "user", "content": "x" * 400}]})
    ok(st == 200, f"another client is not affected by Quota Co's limits ({st})")
    st, u, _ = other_person.get("/api/tenant/ai-usage")
    ok(u["usage"]["requests"] == 1 and u["usage"]["estimated"] is True and u["usage"]["totalTokens"] >= 100, f"an endpoint without a token count is estimated, and marked so ({u['usage']})")
    root.tenant = None
    st, pu, _ = root.get("/api/platform/ai-usage")
    by = {c["id"]: c for c in pu.get("clients", [])}
    ok(by[QID]["usage"]["totalTokens"] == 300 and by[EID]["usage"]["requests"] == 1 and by[QID]["budget"]["tokens"] == 0, "the platform sees every client's usage and budget")
    st, _, _ = Client().call("GET", "/api/platform/ai-usage")
    ok(st == 401, "…and nobody else does")
    root.put("/api/platform/ai", {"baseUrl": "", "model": ""})
    mock.shutdown()

    # ---------------------------------------------------------------- H1, H2: in the browser
    section("H1 code cells: sandboxed in the browser, and someone else's code waits for approval; H2 print view")
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sync_playwright = None
        print("  (skipped: Playwright is not installed)")
    if sync_playwright:
        st, sb, _ = root.post("/api/platform/tenants", {"name": "Sandbox Co", "admin": {"login": "eve@sandbox.test", "password": "eve-password-2026"}})
        SID, SLUG = sb["tenant"]["id"], sb["tenant"]["slug"]
        root.put(f"/api/platform/tenants/{SID}/members/eve@sandbox.test", {"role": "editor"})
        eve = Client()
        eve.login("eve@sandbox.test", "eve-password-2026")
        eve.post("/api/auth/password", {"current": "eve-password-2026", "next": "eve-password-2026-own"})
        eve.tenant = SID
        st, d, _ = eve.post("/api/files", {"name": "Q3 board pack", "json": DOC})
        FID = d["id"]
        EXPLOIT = """let s = 'sum=' + (q.cells('A1') + q.cells('A2'));
try { const r = await fetch('/api/tenant/members', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({login: 'mallory@sandbox.test', role: 'admin'})}); s += ' members:' + r.status; } catch (e) { s += ' members:blocked'; }
try { const r = await fetch('/api/files'); s += ' files:' + r.status; } catch (e) { s += ' files:blocked'; }
s += ' origin:' + self.origin + ' document:' + typeof document;
return s;"""
        PYCODE = """import js, json
out = {}
try:
    r = await js.fetch('/api/files'); out['fetch'] = 'REACHED %s' % r.status
except Exception as e:
    out['fetch'] = 'blocked'
out['origin'] = str(js.self.origin)
json.dumps(out)"""
        CELL = "() => { const st = window.__gw.getState(); const t = Array.from(st.tables.keys())[0]; const c = t !== undefined && st.cells.get(t)?.get(%d); return c ? JSON.stringify(c.v ?? c.err ?? null) : null; }"

        def session_of(c):
            return [{"name": "gw_session", "value": c.cookie.split("=", 1)[1], "url": BASE}]

        def wait_value(page, key, needle, timeout=150):
            t0 = time.time()
            while time.time() - t0 < timeout:
                v = page.evaluate(CELL % key)
                if v and needle in v:
                    return v
                time.sleep(1)
            return page.evaluate(CELL % key)

        with sync_playwright() as p:
            br = p.chromium.launch(args=["--no-sandbox"])
            # Eve (editor) writes the cells in her browser: they run for her, in the sandbox
            ec = br.new_context()
            ec.add_cookies(session_of(eve))
            pe = ec.new_page()
            pe.goto(f"{BASE}/?tenant={SLUG}&file={FID}", wait_until="networkidle")
            pe.wait_for_function("() => window.__gw && window.__gw.getState().fileId", timeout=30000)
            pe.evaluate("""([js, py]) => { const b = window.__gw.book;
              b.apply({type: 'add_table', name: 'Pack', x: 100, y: 80, rows: 4, cols: 3});
              const t = Array.from(window.__gw.getState().tables.keys())[0];
              b.apply({type: 'set_cell', table: t, row: 0, col: 0, input: '2'});
              b.apply({type: 'set_cell', table: t, row: 1, col: 0, input: '40'});
              b.apply({type: 'set_cell', table: t, row: 0, col: 1, input: js, kind: 'javascript', refresh: 3});
              b.apply({type: 'set_cell', table: t, row: 1, col: 1, input: py, kind: 'python'}); }""", [EXPLOIT, PYCODE])
            v = wait_value(pe, 1, "origin:", 60)
            ok(v and "sum=42" in v, f"a JavaScript cell still computes, in the sandbox ({v})")
            ok(v and "members:blocked" in v and "files:blocked" in v and "origin:null" in v and "document:undefined" in v, "…but cannot call the API, has an opaque origin and no page (H1)")
            pv = wait_value(pe, 65537, "origin", 150)
            ok(pv and "blocked" in pv and "null" in pv, f"a Pyodide cell runs in the sandbox too, without the API ({pv})")
            t0 = time.time()
            while time.time() - t0 < 20 and "mallory" not in json.dumps(eve.get(f"/api/files/{FID}")[1]):
                time.sleep(1)
            pe.close()
            # the administrator opens Eve's document: her code does not run on its own
            rc = br.new_context()
            rc.add_cookies(session_of(root))
            pr = rc.new_page()
            pr.goto(f"{BASE}/?tenant={SLUG}&file={FID}", wait_until="networkidle")
            pr.wait_for_selector("[data-testid=trust-banner]", timeout=30000)
            ok(pr.locator("[data-testid=trust-banner]").is_visible(), "the administrator opening it is told that code by someone else waits (H1)")
            pr.wait_for_timeout(8000)
            runs = pr.evaluate("() => { const st = window.__gw.getState(); const t = Array.from(st.tables.keys())[0]; return [st.runs.has(`${t}:0:1`), st.runs.has(`${t}:1:1`)]; }")
            ok(runs == [False, False], f"…and none of it runs, not even the refreshing cell, until approved ({runs})")
            pr.click("[data-testid=trust-run]")
            pr.wait_for_function("() => { const st = window.__gw.getState(); const t = Array.from(st.tables.keys())[0]; return st.runs.has(`${t}:0:1`); }", timeout=30000)
            v = wait_value(pr, 1, "members:", 30)
            ok(v and "members:blocked" in v, f"approved, it runs — still in the sandbox, without the administrator's session ({v})")
            pr.wait_for_timeout(4000)
            # H2: a stored value that used to become an <img onerror=…> in the print view
            PAY = 'data:image/png" onerror="alert(\'XSS \'+document.domain)'
            TAG = '<img src=x onerror="alert(2)">'
            html = pr.evaluate("""([pay, tag]) => { const b = window.__gw.book; const t = Array.from(window.__gw.getState().tables.keys())[0];
              b.apply({type: 'set_cell', table: t, row: 2, col: 0, input: pay});
              b.apply({type: 'set_cell', table: t, row: 3, col: 0, input: tag});
              return window.__gw.printDocumentHtml(); }""", [PAY, TAG])
            ok('onerror="' not in html and "<img src=x" not in html and "&quot;" in html, "the print view escapes a stored value's quotes and tags (H2)")
            ok("default-src 'none'" in html and "script-src" not in html, "…and the printed page itself allows no script (default-src 'none')")
            dialogs = []
            pp = rc.new_page()
            pp.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))
            pp.set_content(html)
            pp.wait_for_timeout(1500)
            ok(not dialogs, f"rendering it runs nothing ({dialogs})")
            br.close()
        root.tenant = SID
        st, mem, _ = root.get("/api/tenant/members")
        st2, inv, _ = root.get("/api/tenant/invitations")
        ok("mallory@sandbox.test" not in json.dumps(mem) + json.dumps(inv), "the planted cell gained nobody anything: no member, no invitation for mallory")
        root.tenant = None

    # ---------------------------------------------------------------- C1, M1: server-side Python
    section("C1 server Python cannot reach the host's sockets; M1 no cache shared between clients")
    PYBIN = os.environ.get("GW_TEST_PYTHON") or sys.executable
    stop()
    start({**TRUST, "GRIDWRIGHT_PYTHON": PYBIN})
    root = Client()
    root.login(ROOT_LOGIN, ROOT_PW)
    status = {}
    for _ in range(60):
        st, status, _ = root.get("/api/python")
        if isinstance(status, dict) and status.get("reason") != "not probed yet" and (status.get("available") or status.get("reason")):
            break
        time.sleep(0.5)
    if not status.get("available"):
        print(f"  (skipped: server-side Python is off here — {status.get('reason')})")
        if os.environ.get("GW_REQUIRE_PYTHON"):
            ok(False, "server-side Python is available (GW_REQUIRE_PYTHON is set)")
    else:
        ok(status.get("sandbox") == "bwrap", f"the runtime is bubblewrap ({status.get('sandbox')})")
        st, ca, _ = root.post("/api/platform/tenants", {"name": "Cache A"})
        st, cb, _ = root.post("/api/platform/tenants", {"name": "Cache B"})
        A, B = Client(tenant=ca["tenant"]["id"]), Client(tenant=cb["tenant"]["id"])
        A.cookie = B.cookie = root.cookie

        def run(c, code):
            st, r, _ = c.post("/api/python/run", {"code": code})
            return st, r

        def value(r):  # a run's output is a grid: the single value is [[v]]
            o = r.get("output") if isinstance(r, dict) else None
            while isinstance(o, list) and len(o) == 1:
                o = o[0]
            return o

        host_sockets = [s for s in ["/var/run/docker.sock", "/run/docker.sock", "/run/dbus/system_bus_socket", "/run/snapd.socket", f"/run/user/{os.getuid()}/bus", f"/run/user/{os.getuid()}/systemd/private"] if os.path.exists(s)]
        ESCAPE = f"""import os, socket, stat
found, connected = [], []
for top in ['/run', '/var', '/tmp', '/home', '/mnt', '/srv', '/opt', '/media', '/root']:
    for dirpath, dirs, files in os.walk(top, onerror=lambda e: None):
        if dirpath.count('/') > 7:
            dirs[:] = []
        for f in files:
            p = os.path.join(dirpath, f)
            try:
                if stat.S_ISSOCK(os.lstat(p).st_mode):
                    found.append(p)
            except OSError:
                pass
for p in found + {host_sockets!r}:
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(1)
    try:
        s.connect(p)
        connected.append(p)
    except OSError:
        pass
    finally:
        s.close()
str({{'found': found, 'connected': connected, 'data': sorted(os.listdir({DATA!r})) if os.path.isdir({DATA!r}) else None}})"""
        st, r = run(A, ESCAPE)
        out = str(r.get("output")) if isinstance(r, dict) else str(r)
        ok(st == 200 and r.get("ok") and "'connected': []" in out, f"sandboxed code connects to no Unix socket (host has {len(host_sockets)} of them: {host_sockets}) — {out[:220]}")
        ok("'data': []" in out or "'data': None" in out, "…and cannot see the data directory's contents")
        PLANT = "import os\nd = os.environ.get('XDG_CACHE_HOME') or os.environ.get('MPLCONFIGDIR')\nos.makedirs(d, exist_ok=True)\nopen(os.path.join(d, 'planted-by-cache-a'), 'w').write('x')\nd"
        st, r = run(A, PLANT)
        ok(st == 200 and r.get("ok"), f"a client's code can use its cache ({str(r.get('output'))[:80]})")
        LOOK = "import os\nroot = os.path.dirname((os.environ.get('XDG_CACHE_HOME') or '/tmp/gw-cache').rstrip('/'))\nstr([os.path.join(r, f) for top in {root, '/tmp/gw-cache', '/tmp'} for r, _, fs in os.walk(top) for f in fs if 'planted' in f])"
        st, r = run(B, LOOK)
        ok(st == 200 and r.get("ok") and value(r) == "[]", f"another client's code finds nothing it planted (M1) ({value(r)})")
        st, r = run(A, LOOK)
        ok(st == 200 and "planted-by-cache-a" in str(r.get("output")), "…while the first client still sees its own cache")
        st, r = run(A, "import subprocess\nsubprocess.Popen(['sleep', '3131'])\n'spawned'")
        time.sleep(2)
        left = subprocess.run(["pgrep", "-f", "sleep 3131"], capture_output=True, text=True).stdout.split()
        ok(st == 200 and not left, f"a process a run leaves behind is ended with it ({left})")

finally:
    stop()
    if not failures:
        shutil.rmtree(DATA, ignore_errors=True)
    else:
        print(f"\n(server data kept in {DATA})")

print(f"\n{passed} checks passed, {len(failures)} failed")
if failures:
    for f in failures:
        print("  -", f)
    sys.exit(1)

#!/usr/bin/env python3
"""Multi-tenancy (GRIDWRIGHT_AUTH=accounts): clients are isolated from each other and people are
managed per client.

Starts its own server twice on a fresh data directory: first without accounts (a document made the
old way), then with accounts on the same data, and checks:

  - migration: what existed before belongs to the default client, and only its members see it
  - sign-in: wrong passwords, throttling, temporary passwords that must be changed first
  - isolation: documents, sharing, SQL connections, model settings (the platform's key never goes
    to an endpoint a client typed in), the inbox and the WebSocket stay within their client
  - people: client administrators add members (new accounts get a temporary password), change
    roles, remove them — removal takes effect at once, including on an open WebSocket; a client
    keeps an administrator; client administrators cannot reset passwords of people in other clients
  - the platform: clients are created, suspended (members are locked out), deleted only when empty;
    backups and the platform console are platform-administrator only; every change is audited
  - API tokens are bound to their client and stop working when revoked
  - cross-site writes are refused

    python3 e2e/tenancy.py [--port 8796] [--data /tmp/gw-tenancy]
"""
import base64
import http.server
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8796
DATA = "/tmp/gw-tenancy"
for i, a in enumerate(sys.argv):
    if a == "--port":
        PORT = int(sys.argv[i + 1])
    if a == "--data":
        DATA = sys.argv[i + 1]
BASE = f"http://127.0.0.1:{PORT}"
SERVER = os.path.join(ROOT, "server", "dist", "index.js")
ROOT_LOGIN, ROOT_PW = "root@platform.test", "platform-root-pw-2026"
DOC = json.dumps({"tables": []})

passed = 0


def ok(cond, what):
    global passed
    if not cond:
        print(f"FAIL: {what}")
        stop()
        sys.exit(1)
    passed += 1
    print(f"  ok  {what}")


# ------------------------------------------------------------------ an upstream that records what it is sent
seen = []


class Upstream(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        seen.append({"path": self.path, "auth": self.headers.get("authorization", "")})
        body = json.dumps({"object": "list", "data": [{"id": "test-model", "object": "model"}]}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


up = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
threading.Thread(target=up.serve_forever, daemon=True).start()
UP = f"http://127.0.0.1:{up.server_address[1]}"

# ------------------------------------------------------------------ the server
proc = None


def start(env_extra):
    global proc
    env = {**os.environ, "GRIDWRIGHT_DATA": DATA, "PORT": str(PORT), "HOST": "127.0.0.1", "GRIDWRIGHT_PYTHON": "off", "GRIDWRIGHT_INBOX": os.path.join(DATA, "inbox"),
           # the fake model endpoint runs on loopback: the operator allows it explicitly (the egress guard)
           "GRIDWRIGHT_EGRESS_ALLOW": "127.0.0.1", **env_extra}
    for k in ("GRIDWRIGHT_TOKEN", "GRIDWRIGHT_TRUST_TAILSCALE", "AI_BASE_URL", "AI_MODEL", "AI_API_KEY"):
        env.pop(k, None) if k not in env_extra else None
    proc = subprocess.Popen(["node", SERVER], cwd=os.path.join(ROOT, "server"), env=env, stdout=open(os.path.join(DATA, "server.log"), "a"), stderr=subprocess.STDOUT)
    for _ in range(60):
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
    if proc and proc.poll() is None:
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
    proc = None


class Client:
    """One browser: its session cookie, optionally a client named per request (like a tab)."""

    def __init__(self, tenant=None, bearer=None, origin=None):
        self.cookie = ""
        self.tenant = tenant
        self.bearer = bearer
        self.origin = origin

    def call(self, method, path, body=None, headers=None):
        h = {"content-type": "application/json"}
        if self.cookie:
            h["cookie"] = self.cookie
        if self.tenant:
            h["x-gridwright-tenant"] = self.tenant
        if self.bearer:
            h["authorization"] = f"Bearer {self.bearer}"
        if self.origin:
            h["origin"] = self.origin
        h.update(headers or {})
        req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                self._cookie(r.headers.get_all("set-cookie") or [])
                raw = r.read()
                return r.status, (json.loads(raw) if raw and r.headers.get("content-type", "").startswith("application/json") else raw)
        except urllib.error.HTTPError as e:
            self._cookie(e.headers.get_all("set-cookie") or [])
            raw = e.read()
            try:
                return e.code, json.loads(raw)
            except Exception:
                return e.code, raw

    def _cookie(self, cookies):
        for c in cookies:
            first = c.split(";")[0]
            if first.startswith("gw_session="):
                self.cookie = "" if first == "gw_session=" else first

    def login(self, login, pw, tenant=None):
        return self.call("POST", "/api/auth/login", {"login": login, "password": pw, **({"tenant": tenant} if tenant else {})})

    def get(self, p):
        return self.call("GET", p)

    def post(self, p, b=None):
        return self.call("POST", p, b if b is not None else {})

    def put(self, p, b):
        return self.call("PUT", p, b)

    def delete(self, p):
        return self.call("DELETE", p)


def ws_open(c, file, tenant):
    """A raw WebSocket handshake: (status, socket) — the socket is open on 101."""
    s = socket.create_connection(("127.0.0.1", PORT), timeout=5)
    key = base64.b64encode(os.urandom(16)).decode()
    lines = [f"GET /ws?file={file}&client=t{os.getpid()}&tenant={tenant} HTTP/1.1", f"Host: 127.0.0.1:{PORT}", "Upgrade: websocket", "Connection: Upgrade", f"Sec-WebSocket-Key: {key}", "Sec-WebSocket-Version: 13"]
    if c.cookie:
        lines.append(f"Cookie: {c.cookie}")
    s.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
    head = b""
    while b"\r\n\r\n" not in head:
        chunk = s.recv(1)
        if not chunk:
            break
        head += chunk
    status = int(head.split(b" ")[1]) if head else 0
    return status, s


def ws_frame(s, timeout=5):
    """The next frame: ('text', str) or ('close', code)."""
    s.settimeout(timeout)

    def rd(n):
        out = b""
        while len(out) < n:
            chunk = s.recv(n - len(out))
            if not chunk:
                raise EOFError
            out += chunk
        return out

    b1, b2 = rd(2)
    op, n = b1 & 0x0F, b2 & 0x7F
    if n == 126:
        n = int.from_bytes(rd(2), "big")
    elif n == 127:
        n = int.from_bytes(rd(8), "big")
    payload = rd(n)
    if op == 8:
        return "close", int.from_bytes(payload[:2], "big") if len(payload) >= 2 else 0
    return "text", payload.decode(errors="replace")


def ws_until(s, pred, timeout=8):
    end = time.time() + timeout
    while time.time() < end:
        kind, val = ws_frame(s, timeout=max(0.1, end - time.time()))
        if pred(kind, val):
            return kind, val
    return None, None


# ================================================================== phase 0: a server without accounts
shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(os.path.join(DATA, "inbox"), exist_ok=True)
print("phase 0: a document made before multi-tenancy")
start({})
anon = Client()
st, legacy = anon.post("/api/files", {"name": "Legacy ledger", "json": DOC})
ok(st == 200 and legacy.get("id"), "without accounts a document is made as before")
LEGACY = legacy["id"]
stop()

# ================================================================== phase 1: accounts
print("phase 1: accounts")
start({"GRIDWRIGHT_AUTH": "accounts", "GRIDWRIGHT_ADMIN_EMAIL": ROOT_LOGIN, "GRIDWRIGHT_ADMIN_PASSWORD": ROOT_PW})

st, h = anon.get("/api/health")
ok(st == 200 and h.get("auth") == "accounts", "health is open and reports accounts")
st, _ = anon.get("/api/files")
ok(st == 401, "the API needs a sign-in")
st, me = anon.get("/api/me")
ok(st == 200 and me.get("authenticated") is False, "/api/me answers signed-out")

root = Client()
st, _ = root.login(ROOT_LOGIN, "wrong-password-123")
ok(st == 401, "a wrong password is refused")
st, r = root.login(ROOT_LOGIN, ROOT_PW)
ok(st == 200 and root.cookie, "the platform administrator signs in (session cookie)")
st, me = root.get("/api/me")
ok(me.get("platformAdmin") is True and me["tenant"]["id"] == "default", "…as platform administrator, in the default client")
st, files = root.get("/api/files")
ok(st == 200 and [f["id"] for f in files] == [LEGACY], "migration: the earlier document belongs to the default client")

# --- clients
st, acme = root.post("/api/platform/tenants", {"name": "Acme Corp", "plan": "pro", "seats": 5, "admin": {"login": "alice@acme.test", "name": "Alice"}})
ok(st == 200 and acme["tenant"]["slug"] == "acme-corp" and acme["admin"]["temporaryPassword"], "a client is created with a first administrator (temporary password)")
ACME = acme["tenant"]["id"]
ALICE_TEMP = acme["admin"]["temporaryPassword"]
st, glob = root.post("/api/platform/tenants", {"name": "Globex", "admin": {"login": "bob@globex.test", "name": "Bob", "password": "bob-password-2026"}})
ok(st == 200 and not glob["admin"].get("temporaryPassword"), "a second client, its administrator with a chosen password")
GLOBEX = glob["tenant"]["id"]

# --- first sign-in with a temporary password
alice = Client()
st, r = alice.login("alice@acme.test", ALICE_TEMP)
ok(st == 200 and r["mustChangePassword"] is True and r["tenant"]["id"] == ACME, "a temporary password signs in, flagged to be changed")
st, r = alice.get("/api/files")
ok(st == 403 and r.get("mustChangePassword"), "…and nothing else works until it is changed")
st, r = alice.post("/api/auth/password", {"current": ALICE_TEMP, "next": "short"})
ok(st == 400, "a weak new password is refused")
st, r = alice.post("/api/auth/password", {"current": ALICE_TEMP, "next": "alice-password-2026"})
ok(st == 200, "the password is changed")
st, files = alice.get("/api/files")
ok(st == 200 and files == [], "Alice sees an empty Acme: nothing of the default client")

bob = Client()
st, r = bob.login("bob@globex.test", "bob-password-2026")
ok(st == 200 and r["mustChangePassword"] is True, "a password an administrator chose must be changed at first sign-in too")
ok(bob.post("/api/auth/password", {"current": "bob-password-2026", "next": "bob-own-password-2026"})[0] == 200, "Bob signs in to Globex and sets his own")

# --- documents stay in their client
st, a1 = alice.post("/api/files", {"name": "Acme Q3 forecast", "json": DOC})
ok(st == 200, "Alice creates an Acme document")
A1 = a1["id"]
st, g1 = bob.post("/api/files", {"name": "Globex budget", "json": DOC})
G1 = g1["id"]
ok([f["id"] for f in alice.get("/api/files")[1]] == [A1], "Alice lists only Acme's document")
ok([f["id"] for f in bob.get("/api/files")[1]] == [G1], "Bob lists only Globex's document")
st, _ = bob.get(f"/api/files/{A1}")
ok(st in (403, 404), "Bob cannot open Acme's document by id")
st, _ = bob.put(f"/api/files/{A1}", {"name": "pwned", "json": DOC})
ok(st in (403, 404), "…nor overwrite it")
st, _ = bob.get(f"/api/files/{LEGACY}")
ok(st in (403, 404), "…nor the default client's")
st, acc = alice.get(f"/api/files/{A1}/access")
ok(acc.get("tenant") == ACME and acc.get("client", {}).get("name") == "Acme Corp", "the document records its client")
st, r = alice.put(f"/api/files/{A1}/access", {"shares": {"bob@globex.test": "edit"}})
ok(st == 400 and "not a member" in r["error"], "a document cannot be shared with someone outside the client")
st, r = Client(tenant=ACME).get("/api/files")
ok(st == 401, "naming a client is no credential")
bob.tenant = ACME
st, r = bob.get("/api/files")
ok(st == 403 and r.get("denied") == "not-a-member", "Bob asking for Acme is refused, not silently switched")
bob.tenant = None

# --- people
st, r = alice.post("/api/tenant/members", {"login": "carol@acme.test", "role": "editor"})
ok(st == 200 and r.get("invited") and r["code"].startswith("gwi_") and "temporaryPassword" not in r, "Alice invites a new editor: a link, no password")
CAROL_CODE = r["code"]
st, r = alice.post("/api/tenant/members", {"login": "dave@acme.test", "role": "viewer"})
ok(st == 200 and r["role"] == "viewer", "…and a viewer")
DAVE_CODE = r["code"]
st, pend = alice.get("/api/tenant/invitations")
ok(sorted(i["login"] for i in pend) == ["carol@acme.test", "dave@acme.test"], "both invitations are pending")
st, inv = Client().get(f"/api/auth/invitation?code={CAROL_CODE}")
ok(st == 200 and inv["tenant"] == "Acme Corp" and inv["role"] == "editor" and inv["login"] == "carol@acme.test", "the link says what it is for")
carol = Client()
st, r = carol.post("/api/auth/invitation/accept", {"code": CAROL_CODE, "password": "short"})
ok(st == 400, "a weak password is refused when accepting")
st, r = carol.post("/api/auth/invitation/accept", {"code": CAROL_CODE, "password": "carol-password-2026", "name": "Carol"})
ok(st == 200 and r["tenant"]["id"] == ACME and carol.cookie, "Carol accepts with a password she chooses, and is signed in")
st, _ = Client().post("/api/auth/invitation/accept", {"code": CAROL_CODE, "password": "carol-password-2026"})
ok(st == 404, "an invitation works once")
ok(Client().post("/api/auth/invitation/accept", {"code": DAVE_CODE, "password": "dave-password-2026"})[0] == 200, "Dave accepts his")
st, members = alice.get("/api/tenant/members")
ok(sorted(m["login"] for m in members) == sorted(["alice@acme.test", "carol@acme.test", "dave@acme.test", ROOT_LOGIN]), "the member list has exactly Acme's people")
st, members = bob.get("/api/tenant/members")
ok("alice@acme.test" not in [m["login"] for m in members], "Globex's member list shows nobody from Acme")
st, _ = bob.post("/api/tenant/members", {"login": "mallory@globex.test", "role": "admin"})
ok(st == 200, "Bob manages Globex's people")
st, _ = alice.put(f"/api/tenant/members/{'mallory@globex.test'}", {"role": "viewer"})
ok(st == 400, "Alice cannot change roles in Globex")

ok([f["id"] for f in carol.get("/api/files")[1]] == [A1], "a new member sees the client's documents (shared within the client by default)")
dave = Client()
dave.login("dave@acme.test", "dave-password-2026")
st, _ = dave.post("/api/files", {"name": "x", "json": DOC})
ok(st == 403, "a viewer cannot create documents")
st, f = dave.get("/api/files")
ok(f and f[0]["permission"] == "view", "…and only views the client's documents")

# --- the WebSocket follows the same rules, live
st, s = ws_open(bob, A1, ACME)
ok(st == 401, "the WebSocket refuses a client the person is not in")
st, s = ws_open(bob, A1, GLOBEX)
kind, val = ws_frame(s) if st == 101 else ("none", None)
ok(st == 101 and kind == "close" and val == 1008, "…and another client's document within one's own")
s.close()
st, s = ws_open(carol, A1, ACME)
kind, val = ws_until(s, lambda k, v: k == "close" or '"welcome"' in v) if st == 101 else (None, None)
ok(st == 101 and kind == "text", "Carol joins the Acme document live")
st, _ = alice.delete("/api/tenant/members/carol@acme.test")
ok(st == 200, "Alice removes Carol from Acme")
kind, val = ws_until(s, lambda k, v: k == "close")
ok(kind == "close" and val == 1008, "Carol's open session is closed at once")
s.close()
st, r = carol.get("/api/files")
ok(st == 403, "…and her next request is refused")

# --- connections are per client
conn = {"name": "Acme ERP", "kind": "postgres", "host": "127.0.0.1", "port": 1, "database": "erp", "user": "u", "password": "p", "ssl": False}
st, c = alice.post("/api/connections", conn)
ok(st == 200, "Alice adds a connection to Acme")
CONN = c["id"]
st, lst = bob.get("/api/connections")
ok(st == 200 and CONN not in [x["id"] for x in lst], "Bob does not see Acme's connection")
st, _ = bob.post(f"/api/connections/{CONN}/query", {"sql": "select 1"})
ok(st in (403, 404), "…and cannot query it")
st, _ = bob.put(f"/api/connections/{CONN}", {**conn, "host": "evil.test"})
ok(st == 404, "…nor change it")
st, _ = bob.delete(f"/api/connections/{CONN}")
ok(st == 404, "…nor delete it")

# --- model settings: per client, and the platform's key stays with the platform's endpoint
st, r = root.put("/api/platform/ai", {"baseUrl": UP + "/platform/v1", "model": "m", "apiKey": "platform-secret"})
ok(st == 200, "the platform sets the default model endpoint and key")
seen.clear()
st, r = alice.get("/api/ai/v1/models")
ok(st == 200 and seen and seen[-1]["path"].startswith("/platform/") and seen[-1]["auth"] == "Bearer platform-secret", "a client without its own settings uses the platform's endpoint and key")
st, r = bob.put("/api/ai/settings", {"baseUrl": UP + "/globex/v1", "model": "g"})
ok(st == 200 and r["scope"] == "client" and r["hasKey"] is False, "Globex points to its own endpoint (no key of its own)")
seen.clear()
bob.get("/api/ai/v1/models")
ok(seen and seen[-1]["path"].startswith("/globex/") and seen[-1]["auth"] == "", "the platform's key is never sent to a client's own endpoint")
bob.put("/api/ai/settings", {"apiKey": "globex-key"})
seen.clear()
bob.get("/api/ai/v1/models")
ok(seen and seen[-1]["auth"] == "Bearer globex-key", "a client's own key goes to its own endpoint")
seen.clear()
alice.get("/api/ai/v1/models")
ok(seen and seen[-1]["auth"] == "Bearer platform-secret", "…while Acme still uses the platform's")
st, r = alice.put("/api/ai/settings", {"model": "acme-model"})
seen.clear()
alice.get("/api/ai/v1/models")
ok(r["scope"] == "client" and r["model"] == "acme-model" and seen and seen[-1]["auth"] == "Bearer platform-secret", "a client choosing only a model keeps the platform endpoint and key")
st, r = bob.put("/api/ai/settings", {"reset": True})
ok(r["scope"] == "platform" and r["baseUrl"].startswith(UP + "/platform"), "a client returns to the platform default")
st, _ = dave.put("/api/ai/settings", {"model": "x"})
ok(st == 403, "only a client administrator changes its settings")
st, _ = alice.put("/api/platform/ai", {"model": "x"})
ok(st == 403, "only the platform changes the platform default")

# --- the inbox: one folder per client
for slug, name in (("acme-corp", "acme-ledger.csv"), ("globex", "globex-ledger.csv")):
    os.makedirs(os.path.join(DATA, "inbox", slug), exist_ok=True)
    open(os.path.join(DATA, "inbox", slug, name), "w").write("account,amount\nCash,100\n")
st, r = alice.get("/api/inbox")
names = [f.get("name") for f in r.get("files", [])]
ok(st == 200 and "acme-ledger.csv" in names and "globex-ledger.csv" not in names, "each client sees only its own inbox folder")

# --- API tokens are bound to their client
st, t = alice.post("/api/account/tokens", {"label": "MCP"})
ok(st == 200 and t["token"].startswith("gwk_"), "Alice makes an API token in Acme")
api = Client(bearer=t["token"])
ok([f["id"] for f in api.get("/api/files")[1]] == [A1], "the token reads Acme")
api.tenant = GLOBEX
st, r = api.get("/api/files")
ok(st == 403 and r.get("denied") == "token-client", "…and naming another client with it is refused, not ignored")
api.tenant = None
alice.delete(f"/api/account/tokens/{t['id']}")
ok(api.get("/api/files")[0] == 401, "a revoked token stops working")

# --- guards on administrators
st, _ = alice.post(f"/api/tenant/members/{ROOT_LOGIN}/reset-password")
ok(st == 403, "a client administrator cannot reset the password of someone in other clients")
st, r = alice.post("/api/tenant/members/dave@acme.test/reset-password")
ok(st == 200 and r["temporaryPassword"], "…but can for someone only in their client")
st, _ = alice.get("/api/platform/tenants")
ok(st == 403, "the platform console is for platform administrators")
st, _ = alice.get("/api/backup")
ok(st == 403, "a client administrator cannot download the whole server's backup")
st, ini = root.post("/api/platform/tenants", {"name": "Initech", "join": False, "admin": {"login": "erin@initech.test", "password": "erin-password-2026"}})
INI = ini["tenant"]["id"]
erin = Client()
erin.login("erin@initech.test", "erin-password-2026")
erin.post("/api/auth/password", {"current": "erin-password-2026", "next": "erin-own-password-2026"})
st, r = erin.put("/api/tenant/members/erin@initech.test", {"role": "editor"})
ok(st == 400 and "administrator" in r["error"], "a client keeps at least one administrator")
st, r = root.post(f"/api/platform/tenants/{INI}/members", {"login": "x1@initech.test", "role": "editor"})
root.put(f"/api/platform/tenants/{INI}", {"seats": 2})
st, r = root.post(f"/api/platform/tenants/{INI}/members", {"login": "x2@initech.test", "role": "editor"})
ok(st == 400 and "seats" in r["error"], "a client's seat limit is enforced")

# --- suspension
st, _ = root.put(f"/api/platform/tenants/{GLOBEX}", {"status": "suspended"})
st, r = bob.get("/api/files")
ok(st == 403 and r.get("denied") == "suspended", "a suspended client's members are locked out")
root.tenant = GLOBEX
ok(root.get("/api/files")[0] == 200, "…while the platform administrator can still enter it")
root.tenant = None
root.put(f"/api/platform/tenants/{GLOBEX}", {"status": "active"})
ok(bob.get("/api/files")[0] == 200, "reactivated, Bob is back")

# --- deleting clients
st, r = root.delete(f"/api/platform/tenants/{ACME}")
ok(st == 409, "a client with documents is not deleted")
st, _ = root.delete(f"/api/platform/tenants/{INI}")
ok(st == 200, "an empty client is deleted")
ok(erin.get("/api/files")[0] == 403, "…and its people have no client left")

# --- cross-site, throttling, backup, audit
evil = Client(origin="http://evil.test")
evil.cookie = alice.cookie
st, _ = evil.post("/api/files", {"name": "csrf", "json": DOC})
ok(st == 403, "a write from another site is refused")
same = Client(origin=BASE)
same.cookie = alice.cookie
ok(same.post("/api/files", {"name": "same-origin", "json": DOC})[0] == 200, "…one from this site is accepted")
t0 = Client()
codes = [t0.login("nobody@x.test", f"wrong-{i}-password")[0] for i in range(10)]
ok(codes[-1] == 429, "repeated wrong passwords are throttled")
st, raw = root.get("/api/backup")
ok(st == 200 and isinstance(raw, (bytes, bytearray)) and raw[:2] == b"\x1f\x8b", "the platform administrator downloads the backup")
st, trail = alice.get("/api/tenant/audit")
acts = {e["action"] for e in trail}
ok({"member.added", "member.removed", "client.ai-settings"} <= acts and all(e.get("tenant") == ACME for e in trail), "the client's audit trail has its own changes only")
st, trail = root.get("/api/platform/audit")
ok(any(e["action"] == "client.suspended" or (e["action"] == "client.updated" and "suspended" in (e.get("detail") or "")) for e in trail), "the platform trail records the suspension")

# --- sign-out
st, _ = alice.post("/api/auth/logout")
ok(alice.get("/api/files")[0] == 401, "after signing out the session is gone")

stop()
up.shutdown()
print(f"\ntenancy: {passed} checks passed")

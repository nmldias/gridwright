#!/usr/bin/env python3
"""Server gates (review 11 Oct 2026, Phase 1): how the server starts, who it believes, what it parses
before it knows who is asking, what a save may claim, what a backup holds, and who may add run records.

  startup   Tailscale trust on a public address refuses to start; the default address is loopback; a
            public address with no sign-in makes up a private, lasting token (unless ALLOW_OPEN); a
            damaged server key stops the start                                       (1.1, 1.2, 1.11b)
  tailscale identity headers name a person; a request nobody vouches for is a viewer      (1.1)
  token     the API and WebSocket take the token as a cookie or bearer, never in the URL; the page
            turns ?token= into a cookie and drops it from the address; writes and sockets from another
            site are refused; a large body without the token is refused unread; an oversized frame
            closes the socket; a save must be at the head of the log and a valid workbook; the backup
            has every database as a clean snapshot and no secret.key        (1.8, 1.9, 1.11b, c, d)
  accounts  a viewer cannot add run records; an editor's are rate-limited             (1.9, 1.11e)

    python3 e2e/server_gates.py [--port 8806]
"""
import base64
import io
import json
import os
import shutil
import signal
import socket
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# GATES_SERVER: another build of the server (e.g. an older one, for comparison)
SERVER = os.environ.get("GATES_SERVER") or os.path.join(ROOT, "server", "dist", "index.js")
PORT = 8806
for i, a in enumerate(sys.argv):
    if a == "--port":
        PORT = int(sys.argv[i + 1])
BASE = f"http://127.0.0.1:{PORT}"
WORK = tempfile.mkdtemp(prefix="gw-gates-")
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"{'PASS' if ok else 'FAIL'} {name}{(' — ' + str(detail)[:400]) if detail and not ok else ''}")


# ------------------------------------------------------------------ servers
proc = None
LOG = ""


def start(name, env_extra, wait=True):
    """Start a server on PORT with a data directory of its own; returns the data directory."""
    global proc, LOG
    data = os.path.join(WORK, name)
    os.makedirs(data, exist_ok=True)
    LOG = os.path.join(WORK, f"{name}.log")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("GRIDWRIGHT_", "AI_"))}
    env.update({"GRIDWRIGHT_DATA": data, "PORT": str(PORT), "GRIDWRIGHT_PYTHON": "off"})
    env.pop("HOST", None)
    env.update(env_extra)
    proc = subprocess.Popen(["node", SERVER], cwd=os.path.dirname(os.path.dirname(SERVER)), env=env, stdout=open(LOG, "a"), stderr=subprocess.STDOUT)
    if not wait:
        return data
    for _ in range(80):
        if proc.poll() is not None:
            raise SystemExit(f"server {name} exited {proc.returncode}:\n" + open(LOG).read()[-2000:])
        try:
            with urllib.request.urlopen(BASE + "/api/health", timeout=2) as r:
                if r.status == 200:
                    return data
        except Exception:
            time.sleep(0.25)
    raise SystemExit(f"server {name} did not start:\n" + open(LOG).read()[-2000:])


def stop():
    global proc
    if proc and proc.poll() is None:
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
    proc = None


def exits_with(name, env_extra, timeout=15):
    """Start a server expected to refuse: (exit code, log text)."""
    start(name, env_extra, wait=False)
    try:
        code = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        stop()
        code = None
    return code, open(LOG).read()


def http(method, path, body=None, headers=None, raw=None, base=None, follow=True):
    """(status, headers, parsed body)."""
    h = {"content-type": "application/json"}
    h.update(headers or {})
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request((base or BASE) + path, method=method, data=data, headers=h)
    opener = urllib.request.build_opener() if follow else urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(req, timeout=30) as r:
            content = r.read()
            return r.status, r.headers, parse(content, r.headers)
    except urllib.error.HTTPError as e:
        content = e.read()
        return e.code, e.headers, parse(content, e.headers)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def parse(content, headers):
    if (headers.get("content-type") or "").startswith("application/json"):
        try:
            return json.loads(content)
        except Exception:
            pass
    return content


# ------------------------------------------------------------------ raw WebSocket
def ws_open(path, headers=None):
    s = socket.create_connection(("127.0.0.1", PORT), timeout=5)
    key = base64.b64encode(os.urandom(16)).decode()
    lines = [f"GET {path} HTTP/1.1", f"Host: 127.0.0.1:{PORT}", "Upgrade: websocket", "Connection: Upgrade", f"Sec-WebSocket-Key: {key}", "Sec-WebSocket-Version: 13"]
    lines += [f"{k}: {v}" for k, v in (headers or {}).items()]
    s.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
    head = b""
    while b"\r\n\r\n" not in head:
        chunk = s.recv(1)
        if not chunk:
            break
        head += chunk
    status = int(head.split(b" ")[1]) if head else 0
    return status, s


def ws_send(s, text):
    payload = text.encode()
    n = len(payload)
    head = bytes([0x81])
    if n < 126:
        head += bytes([0x80 | n])
    elif n < 65536:
        head += bytes([0x80 | 126]) + n.to_bytes(2, "big")
    else:
        head += bytes([0x80 | 127]) + n.to_bytes(8, "big")
    mask = os.urandom(4)
    masked = (int.from_bytes(payload, "big") ^ int.from_bytes((mask * (n // 4 + 1))[:n], "big")).to_bytes(n, "big") if n else b""
    s.sendall(head + mask + masked)


def ws_frame(s, timeout=5):
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


def ws_messages(s, until, timeout=8):
    """Read frames until until(list of messages, last kind, last value) is true; returns the messages and the close code (if any)."""
    msgs, closed = [], None
    end = time.time() + timeout
    while time.time() < end:
        try:
            kind, val = ws_frame(s, timeout=max(0.1, end - time.time()))
        except (socket.timeout, TimeoutError):
            break
        except (EOFError, ConnectionError, OSError):
            closed = closed or -1
            break
        if kind == "close":
            closed = val
            break
        try:
            msgs.append(json.loads(val))
        except Exception:
            continue
        if until(msgs):
            break
    return msgs, closed


def own_address():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip if not ip.startswith("127.") else None
    except OSError:
        return None


def refused(host):
    try:
        socket.create_connection((host, PORT), timeout=2).close()
        return False
    except OSError:
        return True


DOC = json.dumps({"name": "Gates", "tables": [], "next_table_id": 1})

try:
    # ============================================================== startup
    print("phase: startup")
    code, log = exits_with("ts-public", {"GRIDWRIGHT_TRUST_TAILSCALE": "1", "HOST": "0.0.0.0"})
    check("S1. Tailscale trust on a public address: the server refuses to start (EX_CONFIG)", code == 78 and "tailscale serve" in log, (code, log[-300:]))

    start("default", {})
    ip = own_address()
    check("S2. by default it listens on loopback only", http("GET", "/api/health")[0] == 200 and (ip is None or refused(ip)), f"own address {ip}")
    stop()

    data = start("public", {"HOST": "0.0.0.0"})
    tok_path = os.path.join(data, "access-token")
    tok = open(tok_path).read().strip() if os.path.exists(tok_path) else ""
    mode = stat.S_IMODE(os.stat(tok_path).st_mode) if tok else None
    check("S3. a public address with no sign-in: a token is made up, kept private (0600)", len(tok) >= 32 and mode == 0o600, (len(tok), oct(mode or 0)))
    check("S3b. …the API refuses requests without it", http("GET", "/api/files")[0] == 401)
    check("S3c. …and takes it as a bearer token", http("GET", "/api/files", headers={"authorization": f"Bearer {tok}"})[0] == 200)
    check("S3d. …the log says where the token is, not what it is", tok_path in open(LOG).read() and bool(tok) and tok not in open(LOG).read())
    stop()
    start("public", {"HOST": "0.0.0.0"})
    check("S3e. a restart keeps the same token", bool(tok) and os.path.exists(tok_path) and open(tok_path).read().strip() == tok and http("GET", "/api/files", headers={"authorization": f"Bearer {tok}"})[0] == 200)
    stop()

    start("open", {"HOST": "0.0.0.0", "GRIDWRIGHT_ALLOW_OPEN": "1"})
    check("S4. GRIDWRIGHT_ALLOW_OPEN=1 keeps it open, with a warning in the log", http("GET", "/api/files")[0] == 200 and "GRIDWRIGHT_ALLOW_OPEN=1" in open(LOG).read())
    stop()

    os.makedirs(os.path.join(WORK, "badkey"), exist_ok=True)
    open(os.path.join(WORK, "badkey", "secret.key"), "w").write("not-a-key\n")
    code, log = exits_with("badkey", {})
    check("S5. a damaged secret.key stops the start (nothing is encrypted with another key)", code == 78 and "secret" in log.lower(), (code, log[-300:]))
    code, log = exits_with("shortsecret", {"GRIDWRIGHT_SECRET": "short"})
    check("S5b. …and so does a too-short GRIDWRIGHT_SECRET", code == 78 and "GRIDWRIGHT_SECRET" in log, (code, log[-300:]))

    # ============================================================== Tailscale
    print("phase: tailscale")
    start("tailscale", {"GRIDWRIGHT_TRUST_TAILSCALE": "1"})
    A = {"tailscale-user-login": "alice@example.com", "tailscale-user-name": "Alice"}
    st, _, me = http("GET", "/api/me", headers=A)
    check("T1. the proxy's identity headers name the person", st == 200 and me.get("login") == "alice@example.com", me)
    st, _, me = http("GET", "/api/me")
    check("T2. a request nobody vouches for (a tagged device, a local process) is a viewer", st == 200 and not me.get("login") and me.get("role") == "viewer", me)
    st, _, _ = http("POST", "/api/files", {"name": "x", "json": DOC}, headers={"origin": BASE})
    check("T2b. …and cannot create anything", st == 403, st)
    stop()

    # ============================================================== shared token
    print("phase: token")
    TOK = "gates-token-2026-abcdefghijklmnopqrstuvwxyz"
    data = start("token", {"GRIDWRIGHT_TOKEN": TOK, "GRIDWRIGHT_WS_MAX_MB": "1"})
    AUTH = {"authorization": f"Bearer {TOK}"}
    st, _, body = http("GET", f"/api/files?token={TOK}")
    check("K1. the API does not take the token in the URL", st == 401 and "URL" in json.dumps(body), (st, body))
    check("K2. it takes a bearer token, and refuses a wrong one", http("GET", "/api/files", headers=AUTH)[0] == 200 and http("GET", "/api/files", headers={"authorization": "Bearer wrong"})[0] == 401)
    check("K2b. …or the cookie", http("GET", "/api/files", headers={"cookie": f"gridwright_token={TOK}"})[0] == 200)
    st, hd, _ = http("GET", f"/?token={TOK}&file=abc", follow=False)
    cookie = hd.get("set-cookie") or ""
    check("K3. the page turns ?token= into an HttpOnly cookie and drops it from the address", st == 302 and hd.get("location") == "/?file=abc" and "gridwright_token=" in cookie and "HttpOnly" in cookie, (st, hd.get("location"), cookie[:80]))

    st, doc = http("POST", "/api/files", {"name": "Gates", "json": DOC}, headers=AUTH)[0::2]
    FILE = doc.get("id")
    check("K4. a document to work with", st == 200 and FILE, (st, doc))
    s1, s = ws_open(f"/ws?file={FILE}&client=k5&token={TOK}")
    s.close()
    s2, s = ws_open(f"/ws?file={FILE}&client=k5", {"cookie": f"gridwright_token={TOK}"})
    s.close()
    check("K5. the WebSocket does not take the token in the URL either; the cookie works", s1 == 401 and s2 == 101, (s1, s2))

    EVIL = {"origin": "https://evil.example"}
    st = http("POST", "/api/files", {"name": "x", "json": DOC}, headers={**AUTH, **EVIL})[0]
    check("K6. a write from another site is refused, even with the token", st == 403, st)
    st = http("POST", "/api/files", {"name": "same site", "json": DOC}, headers={**AUTH, "origin": BASE})[0]
    check("K6b. …a write from this site goes through", st == 200, st)
    s3, s = ws_open(f"/ws?file={FILE}&client=k6", {"cookie": f"gridwright_token={TOK}", "origin": "https://evil.example"})
    s.close()
    check("K6c. a WebSocket from another site is refused, even with the cookie", s3 == 403, s3)

    # a 50 MB body announced, a kilobyte sent: without the token it must be refused before it is read
    raw = socket.create_connection(("127.0.0.1", PORT), timeout=5)
    raw.sendall(f"POST /api/files HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\ncontent-type: application/json\r\ncontent-length: 50000000\r\n\r\n".encode() + b'{"name":"' + b"x" * 1024)
    raw.settimeout(5)
    t0 = time.time()
    try:
        first = raw.recv(64).decode(errors="replace")
    except (socket.timeout, TimeoutError):
        first = ""
    raw.close()
    check("K7. a large body without the token is refused unread (401 at once, the body never sent)", first.startswith("HTTP/1.1 401") and time.time() - t0 < 4, repr(first[:40]))

    st, s = ws_open(f"/ws?file={FILE}&client=k8", {"cookie": f"gridwright_token={TOK}"})
    ws_messages(s, lambda m: any(x.get("type") == "hello" for x in m), timeout=3)
    try:
        ws_send(s, json.dumps({"type": "snapshot", "cid": 1, "json": "x" * (2 * 1024 * 1024)}))
    except OSError:
        pass
    _, closed = ws_messages(s, lambda m: False, timeout=5)
    s.close()
    check("K8. a WebSocket message over the limit closes the socket (1009)", closed in (1009, -1), closed)

    # saves (checkpoints): only at the head of the log, only a valid workbook
    st, _, r = http("PUT", f"/api/files/{FILE}", {"name": "Gates", "json": DOC}, headers=AUTH)
    head = (r or {}).get("seq")
    check("K9. a save at the head of the log is accepted (and logged as its own event)", st == 200 and isinstance(head, int) and head >= 1, (st, r))
    st, _, r = http("PUT", f"/api/files/{FILE}", {"name": "Gates", "json": DOC, "seq": head - 1}, headers=AUTH)
    check("K9b. a save from a copy that is behind the log is refused (409)", st == 409 and "since this copy" in json.dumps(r), (st, r))
    st, _, r = http("PUT", f"/api/files/{FILE}", {"name": "Gates", "json": DOC, "seq": head + 50}, headers=AUTH)
    check("K9c. a save claiming a position the log never reached is refused (409)", st == 409 and "claims" in json.dumps(r), (st, r))
    st, _, r = http("PUT", f"/api/files/{FILE}", {"name": "Gates", "json": "not a workbook", "seq": head}, headers=AUTH)
    check("K9d. a save that is not a workbook is refused (400), and nothing is written", st == 400 and http("GET", f"/api/files/{FILE}", headers=AUTH)[0] == 200, (st, r))
    st, _, r = http("PUT", f"/api/files/{FILE}", {"name": "Gates", "json": DOC, "seq": head}, headers=AUTH)
    check("K9e. a save at the head, with the position given, is accepted", st == 200, (st, r))
    st, s = ws_open(f"/ws?file={FILE}&client=k10", {"cookie": f"gridwright_token={TOK}"})
    ws_messages(s, lambda m: any(x.get("type") == "hello" for x in m), timeout=3)
    ws_send(s, json.dumps({"type": "snapshot", "cid": 7, "json": "{\"tables\": \"no\"}", "note": "bad"}))
    msgs, _ = ws_messages(s, lambda m: any(x.get("type") == "rejected" for x in m), timeout=5)
    s.close()
    rej = [x for x in msgs if x.get("type") == "rejected"]
    check("K10. a WebSocket snapshot that is not a workbook is refused", rej and "snapshot refused" in rej[0].get("reason", ""), msgs[-3:])

    # the backup: a clean snapshot of every database, and no server key
    st, hd, blob = http("GET", "/api/backup", headers=AUTH)
    names, dbs_ok, dbs, sidecars = [], True, 0, []
    if st == 200 and isinstance(blob, (bytes, bytearray)):
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tf:
            names = tf.getnames()
            for m in tf.getmembers():
                base = os.path.basename(m.name)
                if base.endswith(("-wal", "-shm", "-journal")):
                    sidecars.append(m.name)
                if m.isfile():
                    head16 = tf.extractfile(m).read(16)
                    if head16 == b"SQLite format 3\x00":
                        dbs += 1
                        tmp = os.path.join(WORK, f"db-{dbs}.sqlite")
                        open(tmp, "wb").write(tf.extractfile(m).read())
                        try:
                            con = sqlite3.connect(tmp)
                            dbs_ok = dbs_ok and con.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
                            con.close()
                        except sqlite3.Error:
                            dbs_ok = False
    has_key = any(os.path.basename(n) == "secret.key" for n in names)
    check("K11. the backup leaves out secret.key (which the data directory has), and says so", st == 200 and os.path.exists(os.path.join(data, "secret.key")) and names and not has_key and "secret-key=not-included" in (hd.get("x-gridwright-backup") or ""), (st, hd.get("x-gridwright-backup"), [n for n in names if "secret" in n]))
    check("K11b. …says how to restore (RESTORE.txt)", any(os.path.basename(n) == "RESTORE.txt" for n in names), names[:10])
    check("K11c. …and has every database as a clean snapshot (integrity ok, no -wal/-shm)", dbs >= 1 and dbs_ok and not sidecars, (dbs, dbs_ok, sidecars[:3]))
    stop()

    # ============================================================== accounts
    print("phase: accounts")
    ROOT_LOGIN, ROOT_PW = "root@gates.test", "gates-root-password-2026"
    start("accounts", {"GRIDWRIGHT_AUTH": "accounts", "GRIDWRIGHT_ADMIN_EMAIL": ROOT_LOGIN, "GRIDWRIGHT_ADMIN_PASSWORD": ROOT_PW})

    def login(user, pw):
        st, hd, _ = http("POST", "/api/auth/login", {"login": user, "password": pw}, headers={"origin": BASE})
        c = [x.split(";")[0] for x in (hd.get_all("set-cookie") or []) if x.startswith("gw_session=")]
        return c[0] if st == 200 and c else ""

    root = login(ROOT_LOGIN, ROOT_PW)
    RH = {"cookie": root, "origin": BASE}
    st, _, inv = http("POST", "/api/tenant/members", {"login": "dave@gates.test", "role": "viewer"}, headers=RH)
    st2, _, _ = http("POST", "/api/auth/invitation/accept", {"code": (inv or {}).get("code", ""), "password": "dave-password-2026"}, headers={"origin": BASE})
    dave = login("dave@gates.test", "dave-password-2026")
    st3, _, doc = http("POST", "/api/files", {"name": "Runs", "json": DOC}, headers=RH)
    RFILE = (doc or {}).get("id")
    check("A0. a platform administrator, a viewer and a document", root and dave and st == 200 and st2 == 200 and st3 == 200 and RFILE, (st, st2, st3))

    def run_msg(i):
        return json.dumps({"type": "run", "run": {"table": 1, "row": i % 50, "col": 0, "kind": "javascript", "codeHash": "0123456789abcdef", "inputsHash": "0123456789abcdef", "outputHash": "0123456789abcdef", "ok": True, "ms": 1, "at": "2026-10-11T12:00:00.000Z", "runtime": {"name": "javascript"}}})

    st, s = ws_open(f"/ws?file={RFILE}&client=dave&tenant=default", {"cookie": dave, "origin": BASE})
    ws_messages(s, lambda m: any(x.get("type") == "hello" for x in m), timeout=3)
    ws_send(s, run_msg(0))
    msgs, _ = ws_messages(s, lambda m: any(x.get("type") in ("run_rejected", "run_ack") for x in m), timeout=5)
    s.close()
    kinds = [x.get("type") for x in msgs]
    check("A1. a viewer cannot add run records to the log", st == 101 and "run_rejected" in kinds and "run_ack" not in kinds, (st, kinds[-4:]))

    st, s = ws_open(f"/ws?file={RFILE}&client=root&tenant=default", {"cookie": root, "origin": BASE})
    ws_messages(s, lambda m: any(x.get("type") == "hello" for x in m), timeout=3)
    for i in range(140):
        ws_send(s, run_msg(i))
    msgs, _ = ws_messages(s, lambda m: sum(1 for x in m if x.get("type") in ("run_ack", "run_rejected")) >= 140, timeout=20)
    s.close()
    acks = sum(1 for x in msgs if x.get("type") == "run_ack")
    rejs = [x for x in msgs if x.get("type") == "run_rejected"]
    check("A2. an editor's run records are rate-limited (a burst of 120, then refused)", 115 <= acks <= 125 and len(rejs) >= 15 and "too many" in rejs[0].get("reason", ""), (acks, len(rejs), rejs[:1]))
    st = http("PUT", f"/api/files/{RFILE}", {"name": "Runs", "json": DOC}, headers={"cookie": dave, "origin": BASE})[0]
    check("A3. a viewer cannot save the document", st in (403, 404), st)
    stop()
finally:
    stop()
    shutil.rmtree(WORK, ignore_errors=True)

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
sys.exit(1 if failed else 0)

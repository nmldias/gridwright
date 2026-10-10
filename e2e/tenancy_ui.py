#!/usr/bin/env python3
"""The multi-tenant interface (GRIDWRIGHT_AUTH=accounts), in a browser:
  - the sign-in screen comes first; a wrong password is refused; a temporary password must be changed
  - the top bar names the client the tab works in; the menu lists the person's clients
  - a client administrator adds a member in Clients & people and gets a temporary password to hand over
  - a document saved in one client is not listed in another; switching client changes the URL
  - two tabs work in two clients at the same time
  - a session that ends while the app is open asks to sign in again over the app, keeping the document
  - the platform administrator creates a client in the platform console
    python3 e2e/tenancy_ui.py [--port 8798] [--data /tmp/gw-tenancy-ui] [--shots /tmp/gw-tenancy-ui-shots]
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT, DATA, SHOTS = 8798, "/tmp/gw-tenancy-ui", "/tmp/gw-tenancy-ui-shots"
for i, a in enumerate(sys.argv):
    if a == "--port":
        PORT = int(sys.argv[i + 1])
    if a == "--data":
        DATA = sys.argv[i + 1]
    if a == "--shots":
        SHOTS = sys.argv[i + 1]
BASE = f"http://127.0.0.1:{PORT}"
ROOT_LOGIN, ROOT_PW = "root@platform.test", "platform-root-pw-2026"
ALICE_PW = "alice-own-password-1"

passed = 0
proc = None


def ok(cond, what):
    global passed
    if not cond:
        print(f"FAIL: {what}")
        stop()
        sys.exit(1)
    passed += 1
    print(f"  ok  {what}")


def start():
    global proc
    env = {**os.environ, "GRIDWRIGHT_DATA": DATA, "PORT": str(PORT), "HOST": "127.0.0.1", "GRIDWRIGHT_PYTHON": "off", "GRIDWRIGHT_AUTH": "accounts", "GRIDWRIGHT_ADMIN_EMAIL": ROOT_LOGIN, "GRIDWRIGHT_ADMIN_PASSWORD": ROOT_PW, "GRIDWRIGHT_INBOX": os.path.join(DATA, "inbox")}
    for k in ("GRIDWRIGHT_TOKEN", "GRIDWRIGHT_TRUST_TAILSCALE", "AI_BASE_URL", "AI_MODEL", "AI_API_KEY"):
        env.pop(k, None)
    proc = subprocess.Popen(["node", os.path.join(ROOT, "server", "dist", "index.js")], cwd=os.path.join(ROOT, "server"), env=env, stdout=open(os.path.join(DATA, "server.log"), "a"), stderr=subprocess.STDOUT)
    for _ in range(80):
        try:
            with urllib.request.urlopen(BASE + "/api/health", timeout=2) as r:
                if r.status == 200:
                    return
        except Exception:
            time.sleep(0.25)
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


class Api:
    def __init__(self):
        self.cookie = ""

    def call(self, method, path, body=None, tenant=None):
        h = {"content-type": "application/json", "origin": BASE}
        if self.cookie:
            h["cookie"] = self.cookie
        if tenant:
            h["x-gridwright-tenant"] = tenant
        req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                for c in r.headers.get_all("set-cookie") or []:
                    if c.startswith("gw_session="):
                        self.cookie = c.split(";")[0]
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"null")


def shot(page, name):
    page.screenshot(path=os.path.join(SHOTS, f"{name}.png"))


shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(DATA)
os.makedirs(SHOTS, exist_ok=True)
start()
try:
    # ---------------------------------------------------------------- the platform sets up two clients
    root = Api()
    st, _ = root.call("POST", "/api/auth/login", {"login": ROOT_LOGIN, "password": ROOT_PW})
    ok(st == 200, "the platform administrator signs in (API)")
    st, acme = root.call("POST", "/api/platform/tenants", {"name": "Acme Holdings", "slug": "acme", "admin": {"login": "alice@acme.test", "name": "Alice"}})
    ok(st == 200 and acme["admin"]["temporaryPassword"], "Acme is created with Alice as its administrator")
    alice_tmp = acme["admin"]["temporaryPassword"]
    st, glob = root.call("POST", "/api/platform/tenants", {"name": "Globex Corp", "slug": "globex"})
    st, _ = root.call("POST", f"/api/platform/tenants/{glob['tenant']['id']}/members", {"login": "alice@acme.test", "role": "editor"})
    ok(st == 200, "…and Alice is an editor in Globex too")

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        page = ctx.new_page()
        page.goto(BASE)
        page.wait_for_selector(".auth-card", timeout=15000)
        ok(page.locator("text=Sign in to your workspace").is_visible(), "the sign-in screen comes first")
        shot(page, "01-sign-in")

        page.fill("input[type=email]", "alice@acme.test")
        page.fill("input[type=password]", "not-her-password")
        page.click("button[type=submit]")
        page.wait_for_selector(".auth-card .err", timeout=5000)
        ok("password" in page.locator(".auth-card .err").inner_text().lower() or "invalid" in page.locator(".auth-card .err").inner_text().lower(), "a wrong password is refused with a message")

        page.fill("input[type=password]", alice_tmp)
        page.click("button[type=submit]")
        page.wait_for_selector(".auth-form", timeout=5000)
        ok(page.locator("text=Choose your own").is_visible(), "a temporary password must be changed first")
        shot(page, "02-change-password")
        pw_inputs = page.locator(".auth-form input[type=password]")
        pw_inputs.nth(0).fill(alice_tmp)
        pw_inputs.nth(1).fill(ALICE_PW)
        pw_inputs.nth(2).fill(ALICE_PW)
        page.click(".auth-form button[type=submit]")

        page.wait_for_selector(".topbar", timeout=30000)
        page.wait_for_selector("[data-menu=client]", timeout=10000)
        chip = page.locator("[data-menu=client] .client-chip").inner_text()
        ok(chip == "Acme Holdings", f"the app opens in Alice's first client ({chip})")
        ok("tenant=acme" in page.url, "the URL names the client")
        shot(page, "03-app-acme")

        page.click("[data-menu=client]")
        items = page.locator(".menu .menu-item").all_inner_texts()
        ok(any("Acme Holdings" in t for t in items) and any("Globex Corp" in t for t in items), "the client menu lists both of Alice's clients")
        ok(not any("Platform console" in t for t in items), "…and no platform console for a client administrator")
        shot(page, "04-client-menu")
        page.locator(".menu .menu-item", has_text="Members & access").click()
        page.wait_for_selector(".admin-panel", timeout=5000)
        ok(page.locator(".member-row", has_text="alice@acme.test").count() == 1, "Members lists Alice")

        form = page.locator(".admin-form").first
        form.locator("input[type=email]").fill("bob@acme.test")
        form.locator("input[placeholder^=name]").fill("Bob")
        form.locator("button[type=submit]").click()
        page.wait_for_selector(".secret-box", timeout=5000)
        secret = page.locator(".secret-value").inner_text().strip()
        ok(len(secret) >= 10, "adding Bob shows a temporary password to hand over")
        ok(page.locator(".member-row", has_text="bob@acme.test").count() == 1, "…and Bob appears in the members")
        shot(page, "05-members")
        page.locator(".secret-box button", has_text="Done").click()

        # a document saved in Acme
        page.locator(".save-btn").click()
        page.wait_for_function("() => !!window.__gw.getState().fileId", timeout=10000)
        acme_doc = page.evaluate("() => window.__gw.getState().fileId")
        ok(bool(acme_doc), "a document is saved in Acme")

        def files_seen(p):
            return p.evaluate("""async () => { const r = await fetch('/api/files', { headers: { 'x-gridwright-tenant': sessionStorage.getItem('gridwright.tenant') } }); return (await r.json()).map((f) => f.id); }""")

        ok(acme_doc in files_seen(page), "…and listed in Acme")

        # switch this tab to Globex
        page.click("[data-menu=client]")
        page.locator(".menu .menu-item", has_text="Globex Corp").click()
        page.wait_for_url("**tenant=globex**", timeout=10000)
        page.wait_for_selector("[data-menu=client]", timeout=30000)
        ok(page.locator("[data-menu=client] .client-chip").inner_text() == "Globex Corp", "switching makes the tab work in Globex")
        ok(acme_doc not in files_seen(page), "Acme's document is not listed in Globex")
        ok(page.evaluate("() => window.__gw.getState().me.role") == "editor", "…where Alice is an editor")
        page.click("[data-menu=client]")
        ok(page.locator(".menu .menu-item", has_text="Members…").count() == 1 and page.locator(".menu .menu-item", has_text="Members & access").count() == 0, "an editor sees the members but does not manage them")
        page.keyboard.press("Escape")
        shot(page, "06-app-globex")

        # a second tab in Acme, side by side
        tab2 = ctx.new_page()
        tab2.goto(BASE + "/?tenant=acme")
        tab2.wait_for_selector("[data-menu=client]", timeout=30000)
        ok(tab2.locator("[data-menu=client] .client-chip").inner_text() == "Acme Holdings", "a second tab works in Acme")
        ok(page.locator("[data-menu=client] .client-chip").inner_text() == "Globex Corp" and acme_doc not in files_seen(page) and acme_doc in files_seen(tab2), "…while the first stays in Globex")

        # opening Acme's document by its link in a Globex tab is refused
        st, _ = page.evaluate(f"""async () => {{ const r = await fetch('/api/files/{acme_doc}', {{ headers: {{ 'x-gridwright-tenant': sessionStorage.getItem('gridwright.tenant') }} }}); return [r.status, null]; }}""")
        ok(st in (403, 404), f"Acme's document cannot be opened from Globex ({st})")

        # the session ends while the app is open
        tab2.close()
        page.evaluate("() => { window.__gw.book.getBook(); }")
        ctx.clear_cookies()
        page.click("[data-menu=client]")
        page.locator(".menu .menu-item", has_text="My account").click()
        page.wait_for_selector(".auth-overlay .auth-card", timeout=10000)
        ok(page.locator(".auth-overlay").locator("text=Your session ended").is_visible(), "an ended session asks to sign in again over the app")
        ok(page.locator(".topbar").count() == 1, "…with the app still there underneath")
        shot(page, "07-session-ended")
        page.fill(".auth-overlay input[type=email]", "alice@acme.test")
        page.fill(".auth-overlay input[type=password]", ALICE_PW)
        page.click(".auth-overlay button[type=submit]")
        page.wait_for_selector(".auth-overlay", state="detached", timeout=10000)
        ok(page.locator("[data-menu=client] .client-chip").inner_text() == "Globex Corp", "after signing in again the tab is still in Globex")

        # the platform console
        ctx2 = browser.new_context(viewport={"width": 1400, "height": 900})
        p2 = ctx2.new_page()
        p2.goto(BASE)
        p2.wait_for_selector(".auth-card", timeout=15000)
        p2.fill("input[type=email]", ROOT_LOGIN)
        p2.fill("input[type=password]", ROOT_PW)
        p2.click("button[type=submit]")
        p2.wait_for_selector("[data-menu=client]", timeout=30000)
        p2.click("[data-menu=client]")
        p2.locator(".menu .menu-item", has_text="Platform console").click()
        p2.wait_for_selector(".platform-console", timeout=5000)
        ok(p2.locator(".client-row", has_text="Acme Holdings").count() == 1 and p2.locator(".client-row", has_text="Globex Corp").count() == 1, "the platform console lists every client")
        f = p2.locator(".platform-console .admin-form").first
        f.locator("input[placeholder^='client name']").fill("Initech")
        f.locator("input[type=email]").fill("peter@initech.test")
        f.locator("button[type=submit]").click()
        p2.wait_for_selector(".client-row:has-text('Initech')", timeout=5000)
        ok(p2.locator(".secret-box").count() == 1, "creating Initech with a first administrator shows their temporary password")
        p2.locator(".client-row", has_text="Acme Holdings").locator("button", has_text="Manage").click()
        p2.wait_for_selector(".client-manage .member-row", timeout=5000)
        ok(p2.locator(".client-manage .member-row", has_text="bob@acme.test").count() == 1, "the platform sees Acme's members, Bob included")
        shot(p2, "08-platform-console")
        p2.locator(".admin-panel .row.tabs button", has_text="People").click()
        p2.wait_for_selector(".member-row:has-text('peter@initech.test')", timeout=5000)
        ok(p2.locator(".member-row", has_text="alice@acme.test").locator("text=Acme Holdings (admin)").count() == 1, "People shows each person's clients and roles")
        shot(p2, "09-people")

        browser.close()
finally:
    stop()
print(f"tenancy_ui: {passed} checks passed")

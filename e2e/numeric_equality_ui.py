#!/usr/bin/env python3
"""Highlight rules compare numbers as formulas do, in the browser (review 11 Oct 2026, 2.5).
Formulas compare numbers at 15 significant digits, so =0.1+0.2 equals 0.3. Highlight rules
are evaluated in the browser; they must agree: "equal to 0.3", the other value comparisons,
"duplicate values" and top/bottom N treat 0.1+0.2 and 0.3 as the same number. The stored values
stay binary doubles (0.30000000000000004), as in Excel.
    python3 e2e/numeric_equality_ui.py [--port 8808] [--data /tmp/gw-numeq]
Starts its own loopback server (server/dist and the client build it serves; CLIENT_DIR passes through).
"""
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8808
DATA = None
for i, a in enumerate(sys.argv):
    if a == "--port":
        PORT = int(sys.argv[i + 1])
    if a == "--data":
        DATA = sys.argv[i + 1]
DATA = DATA or tempfile.mkdtemp(prefix="gw-numeq-")
BASE = f"http://127.0.0.1:{PORT}"
OUT = os.environ.get("E2E_OUT", "/tmp/gridwright-e2e")
os.makedirs(OUT, exist_ok=True)

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"{'PASS' if ok else 'FAIL'} {name}{(' — ' + str(detail)[:400]) if detail else ''}")


env = {**os.environ, "GRIDWRIGHT_DATA": DATA, "PORT": str(PORT), "HOST": "127.0.0.1", "GRIDWRIGHT_PYTHON": "off"}
for k in ("GRIDWRIGHT_TOKEN", "GRIDWRIGHT_AUTH", "GRIDWRIGHT_TRUST_TAILSCALE", "AI_BASE_URL", "AI_MODEL", "AI_API_KEY"):
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

# rows 0..3 of column A: =0.1+0.2, 0.3, 0.1, 0.6
EXPECT = {
    ("cell_is", "eq"): [True, True, False, False],
    ("cell_is", "ne"): [False, False, True, True],
    ("cell_is", "gt"): [False, False, False, True],
    ("cell_is", "ge"): [True, True, False, True],
    ("cell_is", "lt"): [False, False, True, False],
    ("cell_is", "le"): [True, True, True, False],
    ("cell_is", "between"): [True, True, False, False],
    ("cell_is", "not_between"): [False, False, True, True],
}

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(locale="en-US")
        errors = []
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_function("() => window.__gw && window.__gw.getState().tables !== undefined", timeout=30000)
        page.click(".topbar button[data-menu='doc']")
        page.click(".menu .menu-item:has-text('New document')")
        page.wait_for_function("() => !window.__gw.getState().fileId && window.__gw.getState().fileName === 'Untitled'", timeout=15000)
        page.wait_for_timeout(300)
        close = page.locator(".start-card button[aria-label='Close']")
        if close.count():
            close.first.click()
        T = page.evaluate(
            "() => { for (const id of [...window.__gw.getState().tables.keys()]) window.__gw.book.apply({ type: 'delete_table', table: id });"
            " return window.__gw.book.apply({ type: 'add_table', x: 60, y: 60, rows: 8, cols: 3 }).created[0]; }")
        for r, inp in enumerate(["=0.1+0.2", "0.3", "0.1", "0.6"]):
            page.evaluate("([t, r, input]) => window.__gw.book.apply({ type: 'set_cell', table: t, row: r, col: 0, input })", [T, r, inp])
        page.evaluate("([t]) => window.__gw.book.apply({ type: 'set_cell', table: t, row: 0, col: 1, input: '=A1=A2' })", [T])
        page.wait_for_timeout(200)

        def value(r, c):
            return page.evaluate("([t, r, c]) => window.__gw.getState().cells.get(t)?.get(r * 65536 + c)?.v ?? null", [T, r, c])

        def styled(rule):
            page.evaluate("([t, rule]) => window.__gw.book.apply({ type: 'set_cond_formats', table: t, rules: [rule] })",
                          [T, {"r0": 0, "c0": 0, "r1": 3, "c1": 0, "fill": "#ffd54f", **rule}])
            page.wait_for_timeout(150)
            return [bool(page.evaluate("([t, r]) => window.__gw.condStyle(t, r, 0)?.fill", [T, r])) for r in range(4)]

        a1, b1 = value(0, 0), value(0, 1)
        check("1. the stored value stays a binary double (0.30000000000000004) and =A1=A2 is TRUE",
              a1 == {"n": 0.30000000000000004} and b1 == {"b": True}, (a1, b1))
        n = 2
        for (kind, op), want in EXPECT.items():
            got = styled({"kind": kind, "op": op, "values": ["0.3", "0.3"]})
            check(f"{n}. “cell value {op} 0.3” highlights {want}", got == want, got)
            n += 1
        got = styled({"kind": "duplicate", "values": []})
        check(f"{n}. “duplicate values” treats 0.1+0.2 and 0.3 as duplicates", got == [True, True, False, False], got)
        n += 1
        got = styled({"kind": "top", "values": ["2"]})
        check(f"{n}. “top 2” includes both 0.3s (a tie with 0.1+0.2) and 0.6", got == [True, True, False, True], got)
        n += 1
        got = styled({"kind": "bottom", "values": ["2"]})
        check(f"{n}. “bottom 2” includes 0.1 and both 0.3s", got == [True, True, True, False], got)
        n += 1
        got = styled({"kind": "cell_is", "op": "gt", "values": ["0.30000000000001"]})
        check(f"{n}. a genuinely different threshold still separates: “> 0.30000000000001” highlights only 0.6", got == [False, False, False, True], got)
        n += 1
        page.screenshot(path=os.path.join(OUT, "numeric-equality-rules.png"))
        check(f"{n}. no page errors", not errors, errors[:3])
        browser.close()
finally:
    stop()
    if "--data" not in sys.argv:
        shutil.rmtree(DATA, ignore_errors=True)

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
sys.exit(1 if failed else 0)

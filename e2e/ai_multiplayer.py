"""AI-assistant and multiplayer checks (needs the server on BASE and the mock LLM
from e2e/mock-llm.mjs configured as the AI endpoint)."""

import os
import sys
import time

from playwright.sync_api import sync_playwright

import json
import urllib.request

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
BASE = ARGS[0] if ARGS else "http://localhost:8787"
MOCK = "http://127.0.0.1:8899/v1"
for i, a in enumerate(sys.argv):
    if a == "--mock-llm":
        MOCK = sys.argv[i + 1]
OUT = os.environ.get("E2E_OUT", "/tmp/gridwright-e2e")
os.makedirs(OUT, exist_ok=True)
results = []

# point the assistant at the mock model (an administrator's setting, stored on the server)
req = urllib.request.Request(BASE + "/api/ai/settings", method="PUT", data=json.dumps({"baseUrl": MOCK, "model": "mock"}).encode(), headers={"content-type": "application/json"})
urllib.request.urlopen(req, timeout=30).read()


def check(name, ok, detail=""):
    results.append((name, ok))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))


def tables(page):
    return page.evaluate("() => [...window.__gw.getState().tables.values()].map(t => ({id: t.id, name: t.name, rows: t.rows, cols: t.cols}))")


def cell(page, t, r, c):
    return page.evaluate("([t,r,c]) => { const x = window.__gw.getState().cells.get(t)?.get(r*65536+c); return x ? {i: x.i, v: x.v} : null; }", [t, r, c])


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    ctx = browser.new_context(viewport={"width": 1400, "height": 900})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE, wait_until="networkidle")
    page.wait_for_selector(".canvas-host canvas", timeout=30000)
    time.sleep(0.5)

    # --- AI panel -----------------------------------------------------------
    page.click(".topbar button:has-text('Ask')")
    page.wait_for_selector(".ai-panel textarea", timeout=5000)
    page.fill(".ai-panel textarea", "Summarise the table")
    page.keyboard.press("Enter")
    # the assistant's edits arrive as a before → after diff and take effect only when a person applies them
    page.wait_for_selector(".ai-panel table.diff", timeout=15000)
    tables_before = tables(page)
    page.click(".ai-panel button:has-text('Apply')")
    time.sleep(0.5)
    check("assistant reply proposed a diff that applies on request", len(tables(page)) == len(tables_before) + 1, str(tables(page)))
    ts = tables(page)
    summary = next((t for t in ts if t["name"] == "AI summary"), None)
    check("add_table action created a table", summary is not None, str(ts))
    if summary:
        v = cell(page, summary["id"], 1, 1)
        check("cross-table formula from the assistant evaluates", v is not None and v["v"] == {"n": 410}, str(v))
    v = cell(page, ts[0]["id"], 7, 5)
    check("set_cell action wrote a formula", v is not None and v["v"] == {"n": 2}, str(v))
    page.screenshot(path=f"{OUT}/07-ai.png")

    # --- save, then open the same document in a second page (multiplayer) ----------
    page.click(".topbar .save-btn")
    time.sleep(0.8)
    file_id = page.evaluate("() => window.__gw.getState().fileId")
    check("document saved", bool(file_id), str(file_id))
    page2 = ctx.new_page()
    page2.goto(f"{BASE}/?file={file_id}", wait_until="networkidle")
    page2.wait_for_selector(".canvas-host canvas", timeout=30000)
    time.sleep(1.5)
    # edit in page 1 → should appear in page 2
    first = ts[0]["id"]
    page.bring_to_front()
    page.evaluate("([t]) => window.__gw.book.apply({type:'set_cell', table: t, row: 9, col: 0, input: 'from page one'})", [first])
    deadline = time.time() + 8
    got = None
    while time.time() < deadline:
        got = cell(page2, first, 9, 0)
        if got and got["v"] == {"s": "from page one"}:
            break
        time.sleep(0.2)
    check("edit propagates to the other client", got is not None and got["v"] == {"s": "from page one"}, str(got))
    # presence
    deadline = time.time() + 8
    n = 0
    while time.time() < deadline:
        n = page2.evaluate("() => window.__gw.getState().presence.size")
        if n >= 1:
            break
        time.sleep(0.2)
    check("presence shows the other client", n >= 1, str(n))
    page2.screenshot(path=f"{OUT}/08-multiplayer.png")
    check("no page errors", not errors, "; ".join(errors)[:300])
    browser.close()

failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
sys.exit(1 if failed else 0)

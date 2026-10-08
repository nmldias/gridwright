"""AI-assistant and multiplayer checks (needs the server on BASE and the mock LLM
from e2e/mock-llm.mjs configured as the AI endpoint)."""

import os
import sys
import time

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8787"
OUT = os.environ.get("E2E_OUT", "/tmp/gridwright-e2e")
os.makedirs(OUT, exist_ok=True)
results = []


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
    page.click("button:has-text('AI')")
    page.wait_for_selector(".ai-panel textarea", timeout=5000)
    page.fill(".ai-panel textarea", "Summarise the table")
    page.keyboard.press("Enter")
    deadline = time.time() + 15
    applied = None
    while time.time() < deadline:
        applied = page.evaluate("() => { const el = document.querySelector('.ai-panel .actions'); return el ? el.textContent : null; }")
        if applied and "Applied" in applied:
            break
        time.sleep(0.3)
    check("assistant reply applied actions", bool(applied) and "Applied 2" in applied, str(applied))
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
    page.click("button[title='Save (Ctrl+S)']")
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

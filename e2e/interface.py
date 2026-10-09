#!/usr/bin/env python3
"""Interaction quality (0.7): nothing typed is lost when panels change, no amount is silently shortened,
the document menu and start choices, Review wording, the navigator and fit actions, keyboard menus,
a reader's bar, and the phone layout.

Usage: python3 e2e/interface.py [http://localhost:8787] [--acl http://127.0.0.1:8795]
"""
import json
import os
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
BASE = ARGS[0] if ARGS else "http://localhost:8787"
ACL = None
for i, a in enumerate(sys.argv):
    if a == "--acl":
        ACL = sys.argv[i + 1]
OUT = os.environ.get("E2E_OUT", "/tmp/gridwright-e2e")
os.makedirs(OUT, exist_ok=True)
LAUNCH = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]


def rest(method, path, body=None, base=None, headers=None):
    req = urllib.request.Request((base or BASE) + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"content-type": "application/json", **(headers or {})})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def main():
    results = []

    def check(name, ok, detail=""):
        results.append((name, ok, detail))
        print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=LAUNCH)
        page = browser.new_context(viewport={"width": 1500, "height": 950}).new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_selector(".canvas-host canvas", timeout=30000)
        time.sleep(0.6)

        def state():
            return page.evaluate("() => { const s = window.__gw.getState(); return { panel: s.panel, fileId: s.fileId, dirty: s.dirty, zoom: s.zoom, start: s.start, selection: s.selection, tables: [...s.tables.values()].map((t) => ({ id: t.id, name: t.name, widths: t.col_widths })) }; }")

        def set_panel(name):
            page.evaluate("(p) => window.__gw.getState().set({ panel: p })", name)
            time.sleep(0.25)

        def apply(op):
            return page.evaluate("(op) => window.__gw.book.apply(op)", op)

        # ------------------------------------------------------------------ first use
        check("a fresh document offers the start choices: import, template, blank — and the example stays on the canvas", page.locator(".start-card .start-choice").count() == 3 and "Import Excel" in page.text_content(".start-card") and state()["tables"][0]["name"] == "Table 1", "")
        bar = [b for b in page.evaluate("() => [...document.querySelectorAll('.topbar > button, .topbar > .menu-wrap > button')].map((b) => b.textContent.trim().replace(/▾$/, '').trim())") if b]
        check("the primary bar: document · Save · Add · Python · Ask · Review · Share (+ Format with a selection, More)", bar[0] == "Untitled" and bar[1] == "Save" and bar[4:9] == ["Add", "Python", "Ask", "Review", "Share"] and bar[-1] == "More", str(bar))

        # ------------------------------------------------------------------ document menu
        page.click(".topbar button[data-menu='doc']")
        items = page.locator(".menu .menu-item").all_text_contents()
        check("the document title opens a document menu: rename, new, import, templates, recent, downloads, print", all(any(k in it for it in items) for k in ("Rename", "New document", "Import Excel", "Finance templates", "All documents", "Download .xlsx", "Print")), str(items)[:200])
        page.click(".menu .menu-item:has-text('Rename')")
        page.wait_for_selector(".topbar .filename-input", timeout=3000)
        page.fill(".topbar .filename-input", "Round seven")
        page.keyboard.press("Enter")
        time.sleep(0.2)
        check("rename from the document menu", page.text_content(".topbar .filename") == "Round seven" and state()["dirty"], page.text_content(".topbar .filename"))
        check("the first edit retires the start card", page.locator(".start-card").count() == 0, "")
        save_title = page.get_attribute(".topbar .save-btn", "title") or ""
        check("Save explains its state before the first save", page.text_content(".topbar .save-btn").strip().startswith("Save") and "not on the server yet" in save_title, save_title)
        page.click(".topbar .save-btn")
        page.wait_for_function("() => window.__gw.getState().fileId && !window.__gw.getState().dirty", timeout=8000)
        time.sleep(0.3)
        check("after saving, the button reads Saved and says when; autosave is explained", page.text_content(".topbar .save-btn").strip() == "Saved" and "Saved to the server at" in (page.get_attribute(".topbar .save-btn", "title") or ""), page.get_attribute(".topbar .save-btn", "title"))
        fid = state()["fileId"]

        # ------------------------------------------------------------------ nothing typed is lost between panels
        set_panel("ai")
        page.wait_for_selector(".ai-panel textarea", timeout=5000)
        page.fill(".ai-panel textarea", "Why did freight go up in March?")
        set_panel("review")
        page.wait_for_selector(".review-panel", timeout=5000)
        set_panel("ai")
        page.wait_for_selector(".ai-panel textarea", timeout=5000)
        check("an unsent question survives a trip to Review and back", page.input_value(".ai-panel textarea") == "Why did freight go up in March?", page.input_value(".ai-panel textarea"))
        set_panel("none")
        page.evaluate("() => window.__gw.getState().set({ selection: { table: 1, r0: 7, c0: 1, r1: 7, c1: 1, ar: 7, ac: 1 } })")
        page.click(".topbar button[title^='Turn the selected cell into a Python cell']")
        page.wait_for_selector(".code-panel .cm-editor", timeout=5000)
        committed = page.evaluate("() => window.__gw.getState().cells.get(1).get(7*65536+1).i")
        page.evaluate("() => { const v = document.querySelector('.cm-content'); v.focus(); }")
        page.keyboard.press("Control+End")
        page.keyboard.type("\nx = 41 + 1  # not yet saved")
        time.sleep(0.2)
        check("an unsaved code edit is flagged, with a way to discard it", page.locator(".code-panel .draft-note").count() == 1, "")
        set_panel("review")
        time.sleep(0.2)
        set_panel("code")
        page.wait_for_selector(".code-panel .cm-editor", timeout=5000)
        text = page.evaluate("() => document.querySelector('.cm-content').textContent")
        now = page.evaluate("() => window.__gw.getState().cells.get(1).get(7*65536+1).i")
        check("an unsaved code edit survives a trip to Review and back, and was neither saved nor run", "not yet saved" in text and now == committed and "not yet saved" not in now, text[-60:])
        page.click(".code-panel .draft-note button:has-text('discard')")
        time.sleep(0.2)
        check("discarding returns the editor to the committed code", "not yet saved" not in page.evaluate("() => document.querySelector('.cm-content').textContent") and page.locator(".code-panel .draft-note").count() == 0, "")
        set_panel("none")

        # ------------------------------------------------------------------ amounts are never silently shortened
        apply({"type": "set_cell", "table": 1, "row": 1, "col": 5, "input": "136261360"})
        apply({"type": "set_format", "table": 1, "r0": 1, "c0": 5, "r1": 1, "c1": 5, "format": {"number_format": "#,##0"}})
        apply({"type": "set_col_width", "table": 1, "col": 5, "width": 48})
        page.evaluate("() => window.__gw.getState().set({ selection: { table: 1, r0: 1, c0: 5, r1: 1, c1: 5, ar: 1, ac: 5 } })")
        time.sleep(0.3)
        note = page.text_content(".statusbar .overflow-note") or ""
        check("a number wider than its column is reported as not fitting, with the full amount shown", "Does not fit" in note and "136,261,360" in note, note)
        page.click(".statusbar .overflow-note button:has-text('fit column')")
        time.sleep(0.3)
        w = state()["tables"][0]["widths"][5]
        check("fit column widens the column to the amount; the note goes", w > 80 and page.locator(".statusbar .overflow-note").count() == 0, f"width {w}")
        apply({"type": "set_cell", "table": 1, "row": 2, "col": 5, "input": "a long description that will be cut with an ellipsis"})
        apply({"type": "set_col_width", "table": 1, "col": 5, "width": 60})
        page.evaluate("() => window.__gw.getState().set({ selection: { table: 1, r0: 2, c0: 5, r1: 2, c1: 5, ar: 2, ac: 5 } })")
        time.sleep(0.2)
        check("text in a narrow column is not flagged as a misleading amount (it is cut with an ellipsis instead)", page.locator(".statusbar .overflow-note").count() == 0, "")
        apply({"type": "set_col_width", "table": 1, "col": 5, "width": 100})
        # the Format menu offers the fit; the context menu too
        page.click(".topbar button[data-menu='format']")
        check("Format offers 'Fit column to values'", page.locator(".menu button:has-text('Fit column')").count() == 1, "")
        page.keyboard.press("Escape")

        # ------------------------------------------------------------------ Review reads as a decision
        page.evaluate("() => window.__gw.applyTemplate('ref-landed-cost')")
        time.sleep(1.2)
        set_panel("review")
        page.wait_for_selector(".review-panel .review-summary", timeout=5000)
        lead = page.text_content(".review-panel .review-summary .lead") or ""
        sub = page.text_content(".review-panel .review-summary .muted") or ""
        check("the summary speaks of proposals awaiting review and of failing checks", lead == "Nothing awaiting review" and "2 checks failing" in sub, f"{lead} / {sub}")
        check("failing checks are listed; passing checks are collapsed behind a link", page.locator(".review-panel .check-item.fail").count() == 2 and page.locator(".review-panel .check-item.ok").count() == 0 and page.locator(".review-panel button:has-text('passing check')").count() == 1, "")
        page.click(".review-panel button:has-text('passing check')")
        check("the passing checks unfold on request", page.locator(".review-panel .check-item.ok").count() == 2, "")
        amber = page.evaluate("() => getComputedStyle(document.querySelector('.review-panel .lead')).color")
        check("every panel has its own close control", page.locator(".review-panel .panel-close").count() == 1, "")
        page.click(".review-panel .panel-close")
        time.sleep(0.2)
        check("the close control closes the panel", state()["panel"] == "none", state()["panel"])

        # ------------------------------------------------------------------ a sense of place: navigator, fit, jump
        set_panel("navigate")
        page.wait_for_selector(".navigate-panel", timeout=5000)
        names = page.locator(".navigate-panel .nav-item b").all_text_contents()
        check("the navigator lists every table", {"FX", "Shipments", "Tariff", "Vehicles", "Checks"} <= set(names), str(names))
        z0 = state()["zoom"]
        page.click(".navigate-panel .nav-item:has-text('Vehicles')")
        time.sleep(0.3)
        st = state()
        veh = next(t for t in st["tables"] if t["name"] == "Vehicles")
        check("jumping to a table selects it and fits the view", st["selection"]["table"] == veh["id"] and abs(st["zoom"] - z0) > 0.01, f"zoom {z0} → {st['zoom']}")
        page.click(".navigate-panel button:has-text('Reset 100%')")
        time.sleep(0.2)
        check("Reset 100% returns to 1:1", abs(state()["zoom"] - 1) < 0.001, str(state()["zoom"]))
        page.click(".navigate-panel button:has-text('Fit all')")
        time.sleep(0.2)
        check("Fit all zooms out to show everything", state()["zoom"] < 1, str(state()["zoom"]))
        page.click(".navigate-panel button:has-text('Reset 100%')")
        page.fill(".formula-bar .name-box", "Checks::B5")
        page.keyboard.press("Enter")
        time.sleep(0.3)
        st = state()
        chk = next(t for t in st["tables"] if t["name"] == "Checks")
        check("the reference box jumps to a reference typed into it", st["selection"]["table"] == chk["id"] and st["selection"]["ar"] == 4 and st["selection"]["ac"] == 1, str(st["selection"]))
        page.fill(".formula-bar .name-box", "Tariff")
        page.keyboard.press("Enter")
        time.sleep(0.3)
        st = state()
        check("…or to a table by name", st["selection"]["table"] == next(t for t in st["tables"] if t["name"] == "Tariff")["id"], str(st["selection"]))
        set_panel("none")
        over = page.evaluate("(t) => window.__gw.overflows(t)", veh["id"])
        check("reference columns were fitted on creation: no amount in Vehicles shows as a marker", over == [], str(over)[:160])

        # ------------------------------------------------------------------ keyboard: menus
        page.focus(".topbar button[data-menu='add']")
        page.keyboard.press("ArrowDown")
        time.sleep(0.15)
        first = page.evaluate("() => document.activeElement?.textContent?.trim()")
        page.keyboard.press("ArrowDown")
        second = page.evaluate("() => document.activeElement?.textContent?.trim()")
        page.keyboard.press("Escape")
        time.sleep(0.1)
        back = page.evaluate("() => document.activeElement?.getAttribute('data-menu')")
        check("menus open from the keyboard, arrows move between items, Escape closes and returns focus to the trigger", first.startswith("Table") and second.startswith("Chart") and back == "add" and page.locator(".menu").count() == 0, f"{first} / {second} / {back}")

        page.screenshot(path=f"{OUT}/ui-01-desktop.png")
        rest("DELETE", f"/api/files/{fid}")

        # ------------------------------------------------------------------ a reader's bar (identity server)
        if ACL:
            A = {"tailscale-user-login": "alice@example.com", "tailscale-user-name": "Alice"}
            doc = {"name": "Read me", "json": '{"name":"Read me","tables":[],"next_table_id":1}'}
            created = rest("POST", "/api/files", doc, base=ACL, headers=A)
            rest("PUT", f"/api/files/{created['id']}/access", {"public": "none", "shares": {"bob@example.com": "view"}}, base=ACL, headers=A)
            ctx = browser.new_context(viewport={"width": 1400, "height": 900}, extra_http_headers={"tailscale-user-login": "bob@example.com", "tailscale-user-name": "Bob"})
            pg = ctx.new_page()
            pg.goto(f"{ACL}/?file={created['id']}", wait_until="networkidle")
            pg.wait_for_selector(".canvas-host canvas", timeout=30000)
            time.sleep(0.8)
            bar2 = [b for b in pg.evaluate("() => [...document.querySelectorAll('.topbar > button, .topbar > .menu-wrap > button')].map((b) => b.textContent.trim().replace(/▾$/, '').trim())") if b]
            check("a reader who cannot edit sees no creation controls: no Add, Python or Format — Ask, Review and Share remain", "Add" not in bar2 and "Python" not in bar2 and "Format" not in bar2 and all(k in bar2 for k in ("Ask", "Review", "Share")), str(bar2))
            ctx.close()
            rest("DELETE", f"/api/files/{created['id']}", base=ACL, headers=A)
        else:
            print("SKIP reader's bar (no --acl)")

        # ------------------------------------------------------------------ phone: review first
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        pg = ctx.new_page()
        pg.goto(BASE, wait_until="networkidle")
        pg.wait_for_selector(".canvas-host canvas", timeout=30000)
        time.sleep(0.8)
        fits = pg.evaluate("() => { const t = document.querySelector('.topbar'); return { scroll: t.scrollWidth, client: t.clientWidth, ask: !!document.querySelector('.topbar button:has(span), .topbar button'), labels: [...t.querySelectorAll('button')].filter((b) => b.offsetParent !== null).map((b) => b.textContent.trim().replace(/▾$/, '').trim()).filter(Boolean) }; }")
        check("on a phone the bar fits without sideways scrolling and keeps Ask and Review in reach", fits["scroll"] <= fits["client"] + 1 and "Ask" in fits["labels"] and "Review" in fits["labels"], str(fits))
        big = pg.evaluate("() => [...document.querySelectorAll('.topbar button')].filter((b) => b.offsetParent !== null).every((b) => b.getBoundingClientRect().height >= 44)")
        check("touch targets in the bar are at least 44 px tall", big, "")
        pg.click(".topbar button:has-text('Review')")
        pg.wait_for_selector(".review-panel", timeout=5000)
        close = pg.locator(".review-panel .panel-close")
        box = close.bounding_box()
        check("the panel covers the screen with a close control inside it, 44 px", box is not None and box["width"] >= 44 and box["height"] >= 44 and pg.evaluate("() => document.querySelector('.side').getBoundingClientRect().width") >= 389, str(box))
        pg.screenshot(path=f"{OUT}/ui-02-phone-review.png")
        close.click()
        time.sleep(0.2)
        check("closing from inside the panel works on a phone", pg.evaluate("() => window.__gw.getState().panel") == "none", "")
        ctx.close()
        browser.close()
    check("no uncaught errors in the page", not errors, "; ".join(errors[:2])[:160])

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n{passed}/{len(results)} checks passed")
    if passed != len(results):
        sys.exit(1)


if __name__ == "__main__":
    main()

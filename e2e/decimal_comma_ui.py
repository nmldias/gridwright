#!/usr/bin/env python3
"""Numbers the Portuguese way, in the browser (review 11 Oct 2026, 2.4).
A workbook can read and show numbers with a decimal comma (1.234,56). New workbooks start that
way when the browser's language writes numbers like that; the File menu switches it, and the
switch is part of the document (saved, shared, undone). Only what a person types or pastes from
outside is read this way; the workbook stores canonical numbers, so switching never changes data.
Values typed into column filters, highlight rules and validation are read the same way and stored
canonically too, so they keep the same rows and cells whichever way numbers are shown.
    python3 e2e/decimal_comma_ui.py [--port 8807] [--data /tmp/gw-decimal]
Starts its own loopback server (server/dist and the client build it serves; CLIENT_DIR passes through).
"""
import json
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
PORT = 8807
DATA = None
for i, a in enumerate(sys.argv):
    if a == "--port":
        PORT = int(sys.argv[i + 1])
    if a == "--data":
        DATA = sys.argv[i + 1]
DATA = DATA or tempfile.mkdtemp(prefix="gw-decimal-")
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


class Sheet:
    """One page with one table, driven through the real grid, editor, formula bar and menu."""

    def __init__(self, ctx, errors):
        self.page = page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_function("() => window.__gw && window.__gw.getState().tables !== undefined", timeout=30000)
        self.new_document()

    def new_document(self):
        page = self.page
        page.click(".topbar button[data-menu='doc']")
        page.click(".menu .menu-item:has-text('New document')")
        page.wait_for_function("() => !window.__gw.getState().fileId && window.__gw.getState().fileName === 'Untitled'", timeout=15000)
        page.wait_for_timeout(300)
        close = page.locator(".start-card button[aria-label='Close']")
        if close.count():
            close.first.click()
        # a new document starts with a sample table; work in a table of our own
        self.T = page.evaluate(
            "() => { for (const id of [...window.__gw.getState().tables.keys()]) window.__gw.book.apply({ type: 'delete_table', table: id });"
            " return window.__gw.book.apply({ type: 'add_table', x: 60, y: 60, rows: 12, cols: 4 }).created[0]; }")
        page.wait_for_timeout(200)

    def state(self, expr):
        return self.page.evaluate(f"() => {{ const s = window.__gw.getState(); return {expr}; }}")

    def cell(self, r, c):
        return self.page.evaluate(
            "([t, r, c]) => { const x = window.__gw.getState().cells.get(t)?.get(r * 65536 + c); return x ? { i: x.i, v: x.v } : null; }",
            [self.T, r, c])

    def shown(self, r, c):
        return self.page.evaluate("([t, r, c]) => window.__gw.display(t, r, c)", [self.T, r, c])

    def click_cell(self, r, c):
        page = self.page
        g = page.evaluate(
            "(id) => { const t = window.__gw.getState().tables.get(id); const vp = window.__gw.viewport(); const b = document.querySelector('.canvas-host').getBoundingClientRect();"
            " return { x: t.x, y: t.y, cw: t.col_widths, rh: t.row_heights, vp, bx: b.x, by: b.y }; }", self.T)
        x = g["x"] + sum(g["cw"][:c]) + g["cw"][c] / 2
        y = g["y"] + sum(g["rh"][:r]) + g["rh"][r] / 2
        page.mouse.click(g["bx"] + x * g["vp"]["zoom"] + g["vp"]["x"], g["by"] + y * g["vp"]["zoom"] + g["vp"]["y"])
        page.wait_for_timeout(80)

    def type_into(self, r, c, text):
        self.click_cell(r, c)
        self.page.keyboard.type(text)
        self.page.keyboard.press("Enter")
        self.page.wait_for_timeout(150)

    def menu_active(self):
        page = self.page
        page.click(".topbar button[data-menu='doc']")
        item = page.locator(".menu .menu-item:has-text('Decimal comma')")
        found = item.count() == 1
        active = found and "active" in (item.first.get_attribute("class") or "")
        page.keyboard.press("Escape")
        page.wait_for_timeout(100)
        return found, active

    def toggle(self):
        page = self.page
        page.click(".topbar button[data-menu='doc']")
        page.click(".menu .menu-item:has-text('Decimal comma')")
        page.wait_for_timeout(200)

    def paste(self, r, c, text):
        self.click_cell(r, c)
        self.page.evaluate(
            "(text) => { const dt = new DataTransfer(); dt.setData('text/plain', text); window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true })); }",
            text)
        self.page.wait_for_timeout(250)

    def chart_svg(self, cid):
        """The chart drawn as SVG, with its values printed on the bars."""
        return self.page.evaluate(
            "(id) => { const c = window.__gw.getState().charts.find((x) => x.id === id); if (!c) return '';"
            " const d = window.__gw.charts.chartData(c); return window.__gw.charts.chartSvg({ ...c, show_values: true }, d); }", cid)


def num(cell):
    v = (cell or {}).get("v") or {}
    return v.get("n")


try:
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        errors = []
        # ------------------------------------------------------------ a Portuguese browser
        pt = browser.new_context(viewport={"width": 1400, "height": 900}, locale="pt-PT")
        s = Sheet(pt, errors)
        check("1. a new workbook in a pt-PT browser reads numbers with a decimal comma", s.state("s.decimalComma") is True, s.state("s.decimalComma"))
        found, active = s.menu_active()
        check("1b. the File menu shows the setting, switched on", found and active, (found, active))
        s.type_into(0, 0, "1,5")
        a1 = s.cell(0, 0)
        check("2. typing 1,5 stores one and a half", num(a1) == 1.5 and a1["i"] == "1.5", a1)
        check("2b. …and the grid shows 1,5", s.shown(0, 0) == "1,5", s.shown(0, 0))
        s.type_into(1, 0, "1.234,56")
        check("3. typing 1.234,56 stores 1234.56", abs((num(s.cell(1, 0)) or 0) - 1234.56) < 1e-9, s.cell(1, 0))
        s.type_into(2, 0, "1.000")
        check("3b. typing 1.000 is one thousand (it used to be 1)", num(s.cell(2, 0)) == 1000, s.cell(2, 0))
        s.type_into(3, 0, "(1.234,00)")
        check("3c. typing (1.234,00) is -1234 (it used to be text)", num(s.cell(3, 0)) == -1234, s.cell(3, 0))
        s.type_into(4, 0, "=A1+A2")
        check("4. a formula keeps English syntax and computes 1236.06", abs((num(s.cell(4, 0)) or 0) - 1236.06) < 1e-9 and s.cell(4, 0)["i"] == "=A1+A2", s.cell(4, 0))
        check("4b. …and shows 1236,06", s.shown(4, 0) == "1236,06", s.shown(4, 0))
        s.page.evaluate("([t]) => { const b = window.__gw.book;"
                        " b.apply({ type: 'set_format', table: t, r0: 1, c0: 0, r1: 1, c1: 0, format: { number_format: '#,##0.00' } });"
                        " b.apply({ type: 'set_format', table: t, r0: 5, c0: 3, r1: 5, c1: 3, format: { number_format: '0.0%' } });"
                        " b.apply({ type: 'set_cell', table: t, row: 5, col: 3, input: '0.025' }); }", [s.T])
        s.page.wait_for_timeout(150)
        check("4c. formatted numbers show the comma way: #,##0.00 → 1.234,56 and 0.0% → 2,5%", s.shown(1, 0) == "1.234,56" and s.shown(5, 3) == "2,5%", (s.shown(1, 0), s.shown(5, 3)))
        s.click_cell(0, 0)
        s.page.keyboard.down("Shift")
        s.click_cell(1, 0)
        s.page.keyboard.up("Shift")
        bar = s.page.locator(".statusbar").inner_text()
        check("4d. the status bar sums the comma way: Sum 1236,06", "Sum 1236,06" in bar, bar.replace("\n", " · ")[:200])
        s.click_cell(1, 0)
        fb = s.page.locator(".formula-input").input_value()
        check("5. the formula bar shows a stored number the way it is typed: 1.234,56", fb == "1.234,56", fb)
        s.page.keyboard.press("F2")
        s.page.wait_for_timeout(150)
        ed = s.page.evaluate("() => document.activeElement && 'value' in document.activeElement ? document.activeElement.value : null")
        check("5b. editing the cell starts from 1.234,56", ed == "1.234,56", ed)
        s.page.keyboard.press("Escape")
        s.page.wait_for_timeout(100)
        check("5c. leaving the editor unchanged keeps the number", abs((num(s.cell(1, 0)) or 0) - 1234.56) < 1e-9, s.cell(1, 0))
        s.click_cell(5, 0)
        s.page.click(".formula-input")
        s.page.keyboard.type("2,5")
        s.page.keyboard.press("Enter")
        s.page.wait_for_timeout(150)
        check("6. typing 2,5 in the formula bar stores 2.5", num(s.cell(5, 0)) == 2.5, s.cell(5, 0))
        s.paste(0, 1, "1.000\t(1.234,00)\n7,25\tFactura 12")
        got = [s.cell(0, 1), s.cell(0, 2), s.cell(1, 1), s.cell(1, 2)]
        check("7. pasting from outside reads numbers the same way", num(got[0]) == 1000 and num(got[1]) == -1234 and num(got[2]) == 7.25 and (got[3] or {}).get("v") == {"s": "Factura 12"}, got)
        # a chart is part of the workbook: its labels are written the same way
        s.page.evaluate("([t]) => { const b = window.__gw.book; const rows = [['Norte', '1.5'], ['Sul', '2.25'], ['Leste', '0.75'], ['Oeste', '3.5']];"
                        " rows.forEach(([k, v], i) => { b.apply({ type: 'set_cell', table: t, row: 7 + i, col: 2, input: k }); b.apply({ type: 'set_cell', table: t, row: 7 + i, col: 3, input: v }); });"
                        " window.__gw.getState().set({ selection: { table: t, r0: 7, c0: 2, r1: 10, c1: 3, ar: 7, ac: 2 }, selectedTable: null }); }", [s.T])
        s.page.wait_for_timeout(150)
        cid = s.page.evaluate("() => window.__gw.review.insertChart('bar')")
        s.page.evaluate("() => window.__gw.getState().set({ panel: 'none' })")
        s.page.wait_for_timeout(200)
        svg = s.chart_svg(cid)
        check("7b. chart labels use the decimal comma: 1,5 and 2,25 on the bars, no 1.5", ">1,5<" in svg and ">2,25<" in svg and ">1.5<" not in svg, f"cid={cid} {len(svg)} chars")
        s.page.screenshot(path=os.path.join(OUT, "decimal-01-comma.png"))
        before = [num(s.cell(r, 0)) for r in range(6)]
        s.toggle()
        found, active = s.menu_active()
        check("8. switching it off from the File menu", s.state("s.decimalComma") is False and found and not active, (s.state("s.decimalComma"), active))
        after = [num(s.cell(r, 0)) for r in range(6)]
        check("8b. switching changes how numbers look, never the numbers", before == after and s.shown(1, 0) == "1,234.56" and s.shown(0, 0) == "1.5", (after, s.shown(1, 0)))
        svg = s.chart_svg(cid)
        check("8c. …and the chart's labels switch with it: 1.5 and 2.25", ">1.5<" in svg and ">2.25<" in svg and ">1,5<" not in svg, f"{len(svg)} chars")
        s.page.screenshot(path=os.path.join(OUT, "decimal-02-point.png"))
        s.page.evaluate("() => window.__gw.book.undo()")
        s.page.wait_for_timeout(150)
        check("9. undo switches it back on", s.state("s.decimalComma") is True and s.shown(1, 0) == "1.234,56", (s.state("s.decimalComma"), s.shown(1, 0)))
        # saved with the document, and still on after opening it again
        s.page.click(".topbar > button:has-text('Save')")
        s.page.wait_for_function("() => !!window.__gw.getState().fileId", timeout=15000)
        fid = s.state("s.fileId")
        s.page.goto(f"{BASE}/?file={fid}", wait_until="networkidle")
        s.page.wait_for_function("(id) => window.__gw && window.__gw.getState().fileId === id && window.__gw.getState().tables.size > 0", arg=fid, timeout=30000)
        s.T = s.page.evaluate("() => [...window.__gw.getState().tables.keys()][0]")
        check("10. the setting is saved with the document", s.state("s.decimalComma") is True and s.shown(1, 0) == "1.234,56", (s.state("s.decimalComma"), s.shown(1, 0)))
        # ------------------------------------------------------------ an English browser opens it
        en = browser.new_context(viewport={"width": 1400, "height": 900}, locale="en-US")
        e = Sheet(en, errors)
        check("11. a new workbook in an en-US browser uses a decimal point", e.state("s.decimalComma") is False, e.state("s.decimalComma"))
        e.type_into(0, 0, "1,234.56")
        e.type_into(1, 0, "(1,234.00)")
        e.type_into(2, 0, "1.000.000")
        e.type_into(3, 0, "08.10.2026")
        vals = [num(e.cell(r, 0)) for r in range(4)]
        check("11b. 1,234.56 · (1,234.00) · 1.000.000 → 1234.56 · -1234 · 1000000", vals[0] == 1234.56 and vals[1] == -1234 and vals[2] == 1000000, vals)
        check("11c. a dotted date is never read as the number 8102026", vals[3] not in (8102026, 8.102026), e.cell(3, 0))
        e.page.goto(f"{BASE}/?file={fid}", wait_until="networkidle")
        e.page.wait_for_function("(id) => window.__gw && window.__gw.getState().fileId === id && window.__gw.getState().tables.size > 0", arg=fid, timeout=30000)
        e.T = e.page.evaluate("() => [...window.__gw.getState().tables.keys()][0]")
        check("12. the document keeps its own setting in any browser", e.state("s.decimalComma") is True and e.shown(1, 0) == "1.234,56", (e.state("s.decimalComma"), e.shown(1, 0)))
        e.page.screenshot(path=os.path.join(OUT, "decimal-03-en-opens-pt.png"))
        # both pages are now editing the same document: the switch reaches the other editor
        s.toggle()
        try:
            e.page.wait_for_function("() => window.__gw.getState().decimalComma === false", timeout=10000)
        except Exception:
            pass
        check("12b. switching it on one editor's page switches it for the other", s.state("s.decimalComma") is False and e.state("s.decimalComma") is False and e.shown(1, 0) == "1,234.56", (s.state("s.decimalComma"), e.state("s.decimalComma"), e.shown(1, 0)))
        s.page.evaluate("() => window.__gw.book.undo()")
        try:
            e.page.wait_for_function("() => window.__gw.getState().decimalComma === true", timeout=10000)
        except Exception:
            pass
        check("12c. …and so does undoing it", s.state("s.decimalComma") is True and e.state("s.decimalComma") is True and e.shown(1, 0) == "1.234,56", (s.state("s.decimalComma"), e.state("s.decimalComma"), e.shown(1, 0)))
        # ------------------------------------------------------------ filters and rules, typed the comma way
        # they are stored canonically (like typed cells), so switching never changes what they keep
        s.new_document()
        T = s.T
        s.page.evaluate("([t]) => { const b = window.__gw.book; b.apply({ type: 'set_header_rows', table: t, rows: 1 });"
                        " b.apply({ type: 'set_cell', table: t, row: 0, col: 0, input: 'Valor' }); }", [T])
        for r, text in ((1, "1,5"), (2, "2,25"), (3, "1.000"), (4, "7")):
            s.type_into(r, 0, text)

        def open_filter():
            s.page.evaluate("([t]) => window.__gw.getState().set({ filterPopover: { table: t, col: 0, x: 600, y: 160 } })", [T])
            s.page.wait_for_selector(".filter-popover", timeout=5000)
            s.page.wait_for_timeout(100)

        def filters():
            return s.state(f"s.tables.get({T}).filters"), s.state(f"s.tables.get({T}).hidden_rows.filter((r) => r <= 4)")
        open_filter()
        labels = s.page.eval_on_selector_all(".filter-popover .filter-values label", "ls => ls.map((l) => l.querySelector('span').innerText)")
        check("14. the column filter lists values the way the workbook shows them: 1,5 · 2,25 · 1000 · 7", s.state("s.decimalComma") is True and all(x in labels for x in ("1,5", "2,25", "1000", "7")) and "1.5" not in labels, labels)
        s.page.evaluate("() => { for (const l of document.querySelectorAll('.filter-popover .filter-values label')) if (l.querySelector('span').innerText === '7') l.querySelector('input').click(); }")
        s.page.click(".filter-popover button.primary:has-text('Apply')")
        s.page.wait_for_timeout(200)
        f, hid = filters()
        check("14b. unticking 7 hides only its row; 1,5 · 2,25 · 1000 stay (it used to hide them all)", hid == [4] and "1.5" in f[0]["values"] and "1,5" not in f[0]["values"], (hid, f))
        open_filter()
        s.page.click(".filter-popover .tabs button:has-text('Condition')")
        s.page.select_option(".filter-popover select", "lt")
        s.page.fill(".filter-popover input[placeholder='value']", "1.000")
        s.page.click(".filter-popover button.primary:has-text('Apply')")
        s.page.wait_for_timeout(200)
        f, hid = filters()
        check("14c. a condition typed “< 1.000” means under one thousand: stored as 1,000, hides only the 1000 row", f and f[0].get("value") == "1,000" and hid == [3], (hid, f))
        open_filter()
        shown_val = s.page.input_value(".filter-popover input[placeholder='value']")
        s.page.click(".filter-popover .filter-head button.icon")
        s.page.wait_for_timeout(100)
        check("14d. reopening the filter shows the condition as it was typed: 1.000", shown_val == "1.000", shown_val)
        s.toggle()
        _, hid_point = filters()
        s.page.evaluate("() => window.__gw.book.undo()")
        s.page.wait_for_timeout(150)
        _, hid_back = filters()
        check("14e. switching to a decimal point and back keeps the same rows hidden", hid_point == [3] and hid_back == [3] and s.state("s.decimalComma") is True, (hid_point, hid_back))
        s.page.evaluate("([t]) => window.__gw.book.apply({ type: 'set_filters', table: t, filters: [] })", [T])
        # conditional formatting and validation from the Rules panel
        s.page.evaluate("([t]) => window.__gw.getState().set({ selection: { table: t, r0: 1, c0: 0, r1: 4, c1: 0, ar: 1, ac: 0 }, selectedTable: null, panel: 'format' })", [T])
        s.page.wait_for_selector(".format-panel", timeout=5000)
        form = s.page.locator(".format-panel .rule-form").first
        form.locator("select").nth(1).select_option("ge")
        form.locator("input[placeholder='value']").fill("1.000")
        form.locator("button.primary").click()
        s.page.wait_for_timeout(200)
        rule = s.state(f"s.tables.get({T}).cond_formats[0]") or {}
        styled = [bool(s.page.evaluate("([t, r]) => window.__gw.condStyle(t, r, 0)?.fill", [T, r])) for r in range(1, 5)]
        check("15. a highlight rule typed “≥ 1.000” is stored as 1,000 and colours only the 1000 cell", (rule.get("values") or [""])[0] == "1,000" and styled == [False, False, True, False], (rule.get("values"), styled))
        listed = s.page.locator(".format-panel .rule-list").first.inner_text()
        check("15b. the rule list shows it as typed: ≥ 1.000", "≥ 1.000" in listed, listed)
        vform = s.page.locator(".format-panel .rule-form").nth(1)
        vform.locator("select").first.select_option("number")
        vform.locator("input[placeholder='value or =ref']").fill("1,5")
        vform.locator("input[placeholder='and']").fill("10")
        vform.locator("button.primary").click()
        s.page.wait_for_timeout(200)
        vrule = s.state(f"s.tables.get({T}).validations[0]") or {}
        check("16. validation bounds typed 1,5 and 10 are stored as 1.5 and 10", vrule.get("values") == ["1.5", "10"], vrule.get("values"))
        vlisted = s.page.locator(".format-panel .rule-list").nth(1).inner_text()
        check("16b. the validation list shows them as typed: between 1,5 and 10", "between 1,5 and 10" in vlisted, vlisted)
        s.page.screenshot(path=os.path.join(OUT, "decimal-04-rules.png"))
        s.page.evaluate("() => window.__gw.getState().set({ panel: 'none' })")
        s.page.wait_for_timeout(150)
        s.type_into(1, 0, "0,5")
        status = s.state("s.status")
        s.page.keyboard.press("Escape")
        s.page.wait_for_timeout(100)
        s.type_into(2, 0, "2,5")
        check("16c. typing 0,5 is refused “between 1,5 and 10”; 2,5 is accepted", "between 1,5 and 10" in (status or "") and num(s.cell(1, 0)) == 1.5 and num(s.cell(2, 0)) == 2.5, (status, s.cell(1, 0), s.cell(2, 0)))
        check("17. no page errors", not errors, errors[:3])
        browser.close()
finally:
    stop()
    if "--data" not in sys.argv:
        shutil.rmtree(DATA, ignore_errors=True)
failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
sys.exit(1 if failed else 0)

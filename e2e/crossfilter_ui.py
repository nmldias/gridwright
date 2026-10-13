#!/usr/bin/env python3
"""Analytical charts and cross-filtering in the browser (roadmap 7.2, assessment 13 Oct 2026).
Two analytical charts over the synthetic inventory (e2e/fixtures/automotive.mjs, 2,000 vehicles):
clicking a bar of one filters the other to the records behind that bar, Ctrl-click adds a bar,
a chart never filters itself (links cannot loop), Esc shows everything again, and a drag still
moves the chart. Selecting is this viewer's interaction state: the workbook JSON, the table's
filters and the undo stack are identical before and after. Every filtered number is compared with
an independent count over the generator's rows. Charts also say what they leave out: blank costs,
mixed currencies, and no "Total" card for a ratio.
    python3 e2e/crossfilter_ui.py [--port 8809] [--data /tmp/gw-xfilter]
Starts its own loopback server (server/dist and the client build it serves).
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
from collections import Counter, defaultdict

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8809
DATA = None
for i, a in enumerate(sys.argv):
    if a == "--port":
        PORT = int(sys.argv[i + 1])
    if a == "--data":
        DATA = sys.argv[i + 1]
DATA = DATA or tempfile.mkdtemp(prefix="gw-xfilter-")
BASE = f"http://127.0.0.1:{PORT}"
OUT = os.environ.get("E2E_OUT", "/tmp/gridwright-e2e")
os.makedirs(OUT, exist_ok=True)

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"{'PASS' if ok else 'FAIL'} {name}{(' — ' + str(detail)[:400]) if detail else ''}")


# the benchmark rows, from the same generator the engine suite uses
fixture = json.loads(subprocess.check_output(
    ["node", "--input-type=module", "-e",
     "import { rows, table } from './e2e/fixtures/automotive.mjs'; const r = rows(2000);"
     " process.stdout.write(JSON.stringify({ rows: r, table: table(r) }));"], cwd=ROOT))
ROWS, VALUES = fixture["rows"], fixture["table"]


def ref_count(by, where=lambda o: True):
    return dict(Counter(o[by] for o in ROWS if where(o)))


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

# chart data as the renderer computes it, and the screen point of a bar (by its label)
DATA_JS = """(id) => { const c = window.__gw.getState().charts.find((x) => x.id === id);
  const d = window.__gw.charts.chartData(c);
  return { categories: d.categories, values: d.series.map((s) => s.values), selected: d.selected ?? null,
           strip: (d.strip ?? []).map((l) => l.text), error: d.error ?? null,
           texts: window.__gw.charts.chartLayout(c, d, c.w, c.h).filter((p) => p.k === 'text').map((p) => p.text) }; }"""
POINT_JS = """([id, label]) => { const c = window.__gw.getState().charts.find((x) => x.id === id);
  const d = window.__gw.charts.chartData(c);
  const i = d.categories.indexOf(label);
  const p = window.__gw.charts.chartLayout(c, d, c.w, c.h).find((q) => q.k === 'rect' && q.mark === i);
  if (!p) return null;
  const v = window.__gw.viewport(); const host = document.querySelector('.canvas-host').getBoundingClientRect();
  return { x: host.left + (c.x + p.x + p.w / 2) * v.zoom + v.x, y: host.top + (c.y + p.y + p.h / 2) * v.zoom + v.y }; }"""

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(locale="en-US", viewport={"width": 1600, "height": 1000})
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
        page.evaluate(
            "(values) => { for (const id of [...window.__gw.getState().tables.keys()]) window.__gw.book.apply({ type: 'delete_table', table: id });"
            " window.__gw.book.apply({ type: 'add_table', name: 'Inventory', x: 2000, y: 0, rows: values.length, cols: values[0].length, values }); }", VALUES)
        spec = lambda dim, measures, x, y, kind="bar": {
            "kind": kind, "title": f"{dim}", "x": x, "y": y, "w": 520, "h": 340, "show_values": False, "stat_cards": False,
            "categories": "", "series": [], "analytic": {"table": "Inventory", "dims": [dim], "measures": measures, "sort": "key"}}
        ids = page.evaluate(
            "(charts) => charts.map((chart) => window.__gw.book.apply({ type: 'add_chart', chart }).created_chart)",
            [spec("Branch", [{"agg": "count"}], 40, 40), spec("Manufacturer", [{"agg": "count"}], 600, 40)])
        A, B = ids
        page.evaluate("() => window.__gw.getState().selectedChart = null")
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)

        def data(i):
            return page.evaluate(DATA_JS, i)

        def counts(d):
            return {c: int(v) for c, v in zip(d["categories"], d["values"][0]) if v is not None}

        def click_bar(chart, label, modifiers=None):
            pt = page.evaluate(POINT_JS, [chart, label])
            if not pt:
                return False
            if modifiers:
                page.keyboard.down(modifiers)
            page.mouse.click(pt["x"], pt["y"])
            if modifiers:
                page.keyboard.up(modifiers)
            page.wait_for_timeout(250)
            return True

        before_json = page.evaluate("() => window.__gw.book.toJson()")
        before_undo = page.evaluate("() => window.__gw.getState().canUndo")
        dA, dB = data(A), data(B)
        check("1. both analytical charts show the reference counts (branches, manufacturers)",
              counts(dA) == ref_count("Branch") and counts(dB) == ref_count("Manufacturer"), (counts(dA), ref_count("Branch")))

        ok = click_bar(A, "Luanda")
        dA, dB = data(A), data(B)
        sel = page.evaluate("(id) => window.__gw.getState().markSelections[id] ?? null", A)
        check("2. clicking the Luanda bar selects it (canonical key, label)", ok and sel and sel["keys"] == [{"s": "Luanda"}] and sel["labels"] == ["Luanda"], sel)
        check("3. the other chart now counts only Luanda's vehicles, per manufacturer",
              counts(dB) == ref_count("Manufacturer", lambda o: o["Branch"] == "Luanda"), counts(dB))
        lu_out = sum(1 for o in ROWS if o["Branch"] != "Luanda")
        check("4. …and says so: “Filtered by Branch: Luanda — N rows left out”",
              any(t == f"Filtered by Branch: Luanda — {lu_out:,} rows left out" for t in dB["strip"]), dB["strip"])
        check("5. the source chart is not filtered by its own selection; it highlights the bar",
              counts(dA) == ref_count("Branch") and dA["selected"] == [c == "Luanda" for c in dA["categories"]], dA["selected"])
        after_json = page.evaluate("() => window.__gw.book.toJson()")
        tables = page.evaluate("() => [...window.__gw.getState().tables.values()].map((t) => (t.filters ?? []).length)")
        check("6. selecting changed nothing in the workbook (JSON, table filters, undo stack)",
              after_json == before_json and tables == [0] and page.evaluate("() => window.__gw.getState().canUndo") == before_undo)

        ok = click_bar(A, "Huambo", "Control")
        dB = data(B)
        check("7. Ctrl-click adds Huambo: the other chart counts Luanda + Huambo",
              ok and counts(dB) == ref_count("Manufacturer", lambda o: o["Branch"] in ("Luanda", "Huambo")), counts(dB))

        ok = click_bar(B, "Toyota")
        dA, dB = data(A), data(B)
        check("8. a selection in the second chart filters the first (Toyota by branch)…",
              ok and counts(dA) == ref_count("Branch", lambda o: o["Manufacturer"] == "Toyota"), counts(dA))
        check("9. …while the second stays filtered only by the first: no loop, no vanishing population",
              counts(dB) == ref_count("Manufacturer", lambda o: o["Branch"] in ("Luanda", "Huambo")) and dB["selected"] == [c == "Toyota" for c in dB["categories"]], counts(dB))
        page.screenshot(path=os.path.join(OUT, "crossfilter.png"))

        page.locator(".canvas-host").focus()
        page.keyboard.press("Escape")
        page.wait_for_timeout(100)
        check("10a. with a chart selected, the first Esc clears the marks and keeps the chart selected",
              page.evaluate("() => window.__gw.getState().selectedChart") == B)
        page.keyboard.press("Escape")
        page.wait_for_timeout(250)
        dA, dB = data(A), data(B)
        check("10. Esc clears every selection and shows all values again",
              page.evaluate("() => Object.keys(window.__gw.getState().markSelections).length") == 0
              and counts(dA) == ref_count("Branch") and counts(dB) == ref_count("Manufacturer") and not dB["strip"])

        click_bar(A, "Benguela")
        page.wait_for_timeout(450)  # two clicks within 400 ms are a double-click (opens the chart panel)
        click_bar(A, "Benguela")
        check("11. clicking the selected bar again clears it",
              page.evaluate("(id) => window.__gw.getState().markSelections[id] ?? null", A) is None)

        page.wait_for_timeout(450)  # not a double-click with the previous click
        pt = page.evaluate(POINT_JS, [A, "Cabinda"])
        x0 = page.evaluate("(id) => window.__gw.getState().charts.find((c) => c.id === id).x", A)
        page.mouse.move(pt["x"], pt["y"])
        page.mouse.down()
        page.mouse.move(pt["x"] + 60, pt["y"] + 10, steps=6)
        page.mouse.move(pt["x"] + 120, pt["y"] + 20, steps=6)
        page.mouse.up()
        page.wait_for_timeout(300)
        x1 = page.evaluate("(id) => window.__gw.getState().charts.find((c) => c.id === id).x", A)
        check("12. dragging a chart still moves it and selects nothing",
              x1 > x0 and page.evaluate("() => Object.keys(window.__gw.getState().markSelections).length") == 0, (x0, x1))

        # what a chart leaves out is said on the chart
        more = page.evaluate(
            "(charts) => charts.map((chart) => window.__gw.book.apply({ type: 'add_chart', chart }).created_chart)",
            [spec("Branch", [{"field": "Inventory value AOA", "agg": "sum"}], 40, 420),
             spec("Branch", [{"field": "Landed cost", "agg": "sum", "currency": "Currency"}], 600, 420),
             {**spec("Branch", [{"agg": "ratio", "numerator": "Landed cost AOA", "denominator": "Selling price AOA", "name": "Cost ratio"}], 1160, 420), "stat_cards": True}])
        dV, dC, dR = data(more[0]), data(more[1]), data(more[2])
        blank = sum(1 for o in ROWS if not isinstance(o["Inventory value AOA"], (int, float)))
        check("13. blank or text inventory values are stated, not counted as 0",
              any(f"{blank} value(s) blank or not a number" in t for t in dV["strip"]), dV["strip"])
        check("14. source-currency costs: branches mixing currencies have no bar, and the chart says why",
              all(v is None for v in dC["values"][0]) and any("are not added together" in t for t in dC["strip"]), dC)
        sums = defaultdict(lambda: [0.0, 0.0])
        for o in ROWS:
            if isinstance(o["Landed cost AOA"], (int, float)):
                sums[o["Branch"]][0] += o["Landed cost AOA"]
                sums[o["Branch"]][1] += o["Selling price AOA"]
        check("15. the ratio chart shows Σ cost ÷ Σ price per branch",
              all(abs(v - sums[c][0] / sums[c][1]) < 1e-9 for c, v in zip(dR["categories"], dR["values"][0])), dR["values"])
        check("16. …and its stat cards offer no “Total” of ratios",
              not any(t.startswith("Total") for t in dR["texts"]), [t for t in dR["texts"] if "Total" in t])

        page.evaluate("(id) => window.__gw.getState().charts.length && window.__gw.book.apply({ type: 'rename_table', table: [...window.__gw.getState().tables.keys()][0], name: 'Stock' })", A)
        page.wait_for_timeout(200)
        dA = data(A)
        check("17. renaming the table keeps the charts bound to it",
              counts(dA) == ref_count("Branch") and page.evaluate("(id) => window.__gw.getState().charts.find((c) => c.id === id).analytic.table", A) == "Stock", dA["error"])
        page.screenshot(path=os.path.join(OUT, "crossfilter-notes.png"))
        check("18. no page errors", not errors, errors[:3])
        browser.close()
finally:
    stop()
    if "--data" not in sys.argv:
        shutil.rmtree(DATA, ignore_errors=True)

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
sys.exit(1 if failed else 0)

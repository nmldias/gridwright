#!/usr/bin/env python3
"""Drill-through and drill-down in the browser (roadmap 7.3, assessment 13 Oct 2026).
Over the synthetic inventory (e2e/fixtures/automotive.mjs, 2,000 vehicles): double-clicking a bar of
an analytical chart lists the records behind it, and they add up to the bar; a record opens its row
in the table; the records a chart leaves out (because of a linked selection) can be listed too and
add up to what is left out; a chart with a Manufacturer → Model hierarchy drills into Toyota with ↓
(its other charts are not filtered by the drill path) and back with ↑; a selection inside the drilled
level filters the linked chart. Every number is compared with an independent count over the
generator's rows, and the workbook is unchanged throughout.
    python3 e2e/drill_ui.py [--port 8810] [--data /tmp/gw-drill]
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
PORT = 8810
DATA = None
for i, a in enumerate(sys.argv):
    if a == "--port":
        PORT = int(sys.argv[i + 1])
    if a == "--data":
        DATA = sys.argv[i + 1]
DATA = DATA or tempfile.mkdtemp(prefix="gw-drill-")
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
        ctx = browser.new_context(locale="en-US", viewport={"width": 1700, "height": 1000})
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
            "(values) => { for (const id of [...window.__gw.getState().tables.keys()]) window.__gw.book.apply({ type: 'delete_table', table: id });"
            " return window.__gw.book.apply({ type: 'add_table', name: 'Inventory', x: 40, y: 1200, rows: values.length, cols: values[0].length, values }).created[0]; }", VALUES)
        spec = lambda dims, measures, x, y: {
            "kind": "bar", "title": " → ".join(dims), "x": x, "y": y, "w": 560, "h": 360, "show_values": False, "stat_cards": False,
            "categories": "", "series": [], "analytic": {"table": "Inventory", "dims": dims, "measures": measures, "sort": "key"}}
        A, B = page.evaluate(
            "(charts) => charts.map((chart) => window.__gw.book.apply({ type: 'add_chart', chart }).created_chart)",
            [spec(["Manufacturer", "Model"], [{"agg": "count"}, {"field": "Inventory value AOA", "agg": "sum"}], 40, 40), spec(["Branch"], [{"agg": "count"}], 640, 40)])
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        before_json = page.evaluate("() => window.__gw.book.toJson()")

        def data(i):
            return page.evaluate(DATA_JS, i)

        def counts(d):
            return {c: int(v) for c, v in zip(d["categories"], d["values"][0]) if v is not None}

        def click_bar(chart, label, dbl=False):
            pt = page.evaluate(POINT_JS, [chart, label])
            if not pt:
                return False
            if dbl:
                page.mouse.dblclick(pt["x"], pt["y"])
            else:
                page.mouse.click(pt["x"], pt["y"])
            page.wait_for_timeout(450)  # the next click is not a double-click
            return True

        def panel():
            return page.evaluate("""() => { const p = document.querySelector('.records-panel'); if (!p) return null;
              return { count: p.querySelector('.records-summary b')?.textContent ?? null,
                       check: p.querySelector('[data-check]')?.getAttribute('data-check') ?? null,
                       checkText: p.querySelector('[data-check]')?.textContent ?? '',
                       scope: [...p.querySelectorAll('p.small')].map((x) => x.textContent).join(' | '),
                       rows: [...p.querySelectorAll('.records-table tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent)),
                       heads: [...p.querySelectorAll('.records-table thead th')].map((th) => th.textContent),
                       text: p.textContent }; }""")

        toyota = [o for o in ROWS if o["Manufacturer"] == "Toyota"]
        ok = click_bar(A, "Toyota", dbl=True)
        pn = panel()
        check("1. double-clicking the Toyota bar opens the records behind it",
              ok and pn is not None and pn["count"] == f"{len(toyota):,}", pn and pn["count"])
        check("2. …and they add up to the bar (count and inventory value)", pn and pn["check"] == "ok", pn and pn["checkText"])
        heads = pn["heads"] if pn else []
        vin_col = heads.index("VIN") if "VIN" in heads else -1
        mcol = heads.index("Manufacturer") if "Manufacturer" in heads else -1
        check("3. each record shows its VIN, the chart's fields, and only Toyota rows (first 200)",
              vin_col == 1 and mcol > 0 and "Inventory value AOA" in heads and len(pn["rows"]) == min(200, len(toyota))
              and all(r[mcol] == "Toyota" for r in pn["rows"]), heads)
        check("4. beyond 200 records the panel says how many are shown; the totals cover all of them",
              len(toyota) <= 200 or (pn and f"Showing 200 of {len(toyota):,}" in pn["text"]), len(toyota))
        # the excluded population: B selects Luanda, so A leaves the other branches out
        page.evaluate("() => window.__gw.crossfilter.clearMarks()")
        click_bar(B, "Luanda")
        page.evaluate("(id) => window.__gw.openRecords(id)", A)
        page.wait_for_timeout(200)
        page.click(".records-panel button:has-text('Left out of the chart')")
        page.wait_for_timeout(250)
        pn = panel()
        not_lu = [o for o in ROWS if o["Branch"] != "Luanda"]
        bcol = pn["heads"].index("VIN") if pn else -1
        check("5. the records a chart leaves out are listed (every vehicle not in Luanda)",
              pn and pn["count"] == f"{len(not_lu):,}" and "not (Branch = Luanda)" in pn["scope"], pn and (pn["count"], pn["scope"][:200]))
        page.click(".records-panel button:has-text('Behind the chart')")
        page.wait_for_timeout(250)
        pn = panel()
        lu = [o for o in ROWS if o["Branch"] == "Luanda"]
        check("6. behind the chart: exactly Luanda's vehicles, adding up to the chart's bars",
              pn and pn["count"] == f"{len(lu):,}" and pn["check"] == "ok", pn and (pn["count"], pn["checkText"]))

        # drill-down: Toyota by model, with ↓ and ↑
        page.evaluate("() => window.__gw.crossfilter.clearMarks()")
        click_bar(A, "Toyota")
        page.keyboard.press("ArrowDown")
        page.wait_for_timeout(250)
        dA, dB = data(A), data(B)
        check("7. ↓ drills Toyota down to its models",
              counts(dA) == ref_count("Model", lambda o: o["Manufacturer"] == "Toyota"), counts(dA))
        check("8. the chart says where it is: “Manufacturer: Toyota › by Model”", any(t.startswith("Manufacturer: Toyota › by Model") for t in dA["strip"]), dA["strip"])
        check("9. the drill path filters only its own chart (Branch chart unfiltered)", counts(dB) == ref_count("Branch") and not dB["strip"], dB["strip"])
        click_bar(A, "Hilux")
        dB = data(B)
        check("10. a bar selected inside the drilled level filters the linked chart (Hilux by branch)",
              counts(dB) == ref_count("Branch", lambda o: o["Model"] == "Hilux"), counts(dB))
        page.evaluate("(id) => window.__gw.openRecords(id)", A)
        page.wait_for_timeout(250)
        pn = panel()
        hil = [o for o in ROWS if o["Model"] == "Hilux"]
        check("11. the records behind Hilux are Toyota Hilux vehicles and add up to the bar",
              pn and pn["count"] == f"{len(hil):,}" and pn["check"] == "ok" and "Manufacturer = Toyota and Model = Hilux" in pn["scope"], pn and (pn["count"], pn["scope"][:200]))
        page.click("text=↑ Up")
        page.wait_for_timeout(250)
        dA, dB = data(A), data(B)
        check("12. ↑ Up returns to manufacturers with nothing selected (so nothing else is filtered)",
              counts(dA) == ref_count("Manufacturer") and dA["selected"] is None and counts(dB) == ref_count("Branch"), (dA["selected"], dB["strip"]))
        click_bar(A, "Kia")
        page.keyboard.press("ArrowDown")
        page.wait_for_timeout(200)
        page.keyboard.press("ArrowUp")
        page.wait_for_timeout(200)
        check("13. ↓ then ↑ from the keyboard round-trips", counts(data(A)) == ref_count("Manufacturer"))
        page.screenshot(path=os.path.join(OUT, "drill.png"))
        page.evaluate("(id) => window.__gw.openRecords(id)", A)
        page.wait_for_timeout(250)
        pn = panel()
        first = pn["rows"][0]
        page.click(".records-table tbody tr >> nth=0")
        page.wait_for_timeout(250)
        sel = page.evaluate("() => window.__gw.getState().selection")
        vin = page.evaluate("([t, r]) => window.__gw.display(t, r, 0)", [T, int(first[0]) - 1])
        check("14. a record opens its row in the table", sel and sel["table"] == T and sel["r0"] == int(first[0]) - 1 and vin == first[vin_col], (sel, vin, first[:2]))

        check("15. nothing in the workbook changed", page.evaluate("() => window.__gw.book.toJson()") == before_json)
        check("16. no page errors", not errors, errors[:3])
        browser.close()
finally:
    stop()
    if "--data" not in sys.argv:
        shutil.rmtree(DATA, ignore_errors=True)

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
sys.exit(1 if failed else 0)

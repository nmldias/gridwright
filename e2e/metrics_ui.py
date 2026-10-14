#!/usr/bin/env python3
"""Governed metrics in the browser (roadmap 7.5, assessment 13 Oct 2026).
A metric is defined once in the Metrics panel (an operation: undoable, in the history, relayed to
other editors, saved with the document) and referred to by name everywhere: the chart editor's
measure picker, the chart's numbers in the metric's format, the decomposition tree's measure list,
drill-through records, the assistant (a canned mock-model reply defines a metric and charts it by
name) and a companion watch. A bad definition is refused with the engine's reason; a redefinition
reaches a bound chart without a chart operation; a rename follows; a removal in use asks first and
then shows an explicit error until undone. Every number is checked against a Python reference sum
over the generated rows.
    python3 e2e/metrics_ui.py [--port 8812] [--data /tmp/gw-metrics]
Starts its own loopback server (server/dist and the client build it serves) and its own mock model
(e2e/mock-llm.mjs) on the next port.
"""
import json
import math
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8812
DATA = None
for i, a in enumerate(sys.argv):
    if a == "--port":
        PORT = int(sys.argv[i + 1])
    if a == "--data":
        DATA = sys.argv[i + 1]
MOCK_PORT = PORT + 1
DATA = DATA or tempfile.mkdtemp(prefix="gw-metrics-")
BASE = f"http://127.0.0.1:{PORT}"
OUT = os.environ.get("E2E_OUT", "/tmp/gridwright-e2e")
os.makedirs(OUT, exist_ok=True)

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"{'PASS' if ok else 'FAIL'} {name}{(' — ' + str(detail)[:400]) if detail else ''}")


# ---- synthetic sales: 240 invoices over four regions, amounts in EUR (deterministic)
REGIONS = ["North", "South", "East", "West"]
ROWS = []
for k in range(240):
    region = REGIONS[(k * 7) % 4]
    amount = round(100 + ((k * 37) % 900) + (k % 7) * 0.25, 2)
    units = 1 + (k * 13) % 9
    ROWS.append({"Invoice": f"INV-{k + 1:04d}", "Region": region, "Amount": amount, "Units": units, "Currency": "EUR"})
HEADERS = ["Invoice", "Region", "Amount", "Units", "Currency"]
VALUES = [HEADERS] + [[str(o[h]) for h in HEADERS] for o in ROWS]


def ref_sum(field, where=lambda o: True):
    return math.fsum(o[field] for o in ROWS if where(o))


def ref_avg(field, where=lambda o: True):
    xs = [o[field] for o in ROWS if where(o)]
    return math.fsum(xs) / len(xs)


def same(a, b):
    if a is None or b is None:
        return a is None and b is None
    return a == b or abs(a - b) <= 1e-9 * max(1.0, abs(a), abs(b))


TOTAL = ref_sum("Amount")
BY_REGION = {r: ref_sum("Amount", lambda o, r=r: o["Region"] == r) for r in REGIONS}
AVG_REGION = {r: ref_avg("Amount", lambda o, r=r: o["Region"] == r) for r in REGIONS}


def euros(x):
    return f"€{x:,.2f}"


# ---- servers: the mock model, then Gridwright pointed at it
procs = []
mock_log = open(os.path.join(tempfile.gettempdir(), f"gw-metrics-mock-{PORT}.log"), "a")
procs.append(subprocess.Popen(["node", os.path.join(ROOT, "e2e", "mock-llm.mjs")], cwd=ROOT, env={**os.environ, "MOCK_LLM_PORT": str(MOCK_PORT)}, stdout=mock_log, stderr=subprocess.STDOUT))
env = {**os.environ, "GRIDWRIGHT_DATA": DATA, "PORT": str(PORT), "HOST": "127.0.0.1", "GRIDWRIGHT_PYTHON": "off",
       "AI_BASE_URL": f"http://127.0.0.1:{MOCK_PORT}/v1", "AI_MODEL": "mock"}
for k in ("GRIDWRIGHT_TOKEN", "GRIDWRIGHT_AUTH", "GRIDWRIGHT_TRUST_TAILSCALE", "AI_API_KEY"):
    env.pop(k, None)
os.makedirs(DATA, exist_ok=True)
log = open(os.path.join(DATA, "server.log"), "a")
procs.append(subprocess.Popen(["node", os.path.join(ROOT, "server", "dist", "index.js")], cwd=os.path.join(ROOT, "server"), env=env, stdout=log, stderr=subprocess.STDOUT))


def stop():
    for proc in procs:
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


def rest(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return {"error": e.read().decode(), "status": e.code}


# chart helpers read what the canvas draws: the series values and the stat cards' texts
DATA_JS = "(id) => { const c = window.__gw.getState().charts.find((x) => x.id === id); const d = window.__gw.charts.chartData(c); return { categories: d.categories, values: d.series.map((s) => s.values), error: d.error ?? null, strip: (d.strip ?? []).map((s) => s.text) }; }"
TEXTS_JS = "(id) => { const c = window.__gw.getState().charts.find((x) => x.id === id); const d = window.__gw.charts.chartData(c); return window.__gw.charts.chartLayout(c, d, c.w, c.h).filter((p) => p.k === 'text').map((p) => p.text); }"

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(locale="en-US", viewport={"width": 1700, "height": 1000})
        errors = []
        dialogs = []
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))
        chat_bodies = []
        page.on("request", lambda r: chat_bodies.append(r.post_data or "") if "/api/ai/chat" in r.url else None)
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
            " return window.__gw.book.apply({ type: 'add_table', name: 'Sales', x: 40, y: 600, rows: values.length, cols: values[0].length, values }).created[0]; }", VALUES)
        C = page.evaluate("() => window.__gw.book.apply({ type: 'add_chart', chart: { kind: 'bar', title: 'By region', x: 40, y: 40, w: 560, h: 360, show_values: true, stat_cards: true, categories: '', series: [],"
                          " analytic: { table: 'Sales', dims: ['Region'], measures: [{ field: 'Amount', agg: 'sum' }], sort: 'key' } } }).created_chart")
        # saved, so that ops are logged, relayed and the companion can read it
        page.click(".topbar .save-btn")
        page.wait_for_function("() => window.__gw.getState().fileId && !window.__gw.getState().dirty", timeout=8000)
        fid = page.evaluate("() => window.__gw.getState().fileId")
        metrics = lambda pg=page: pg.evaluate("() => window.__gw.getState().metrics")
        chart = lambda: page.evaluate("(id) => window.__gw.getState().charts.find((c) => c.id === id)", C)

        # 1. the Metrics panel from the More menu
        page.click(".topbar button[data-menu='more']")
        page.click(".menu .menu-item:has-text('Metrics')")
        page.wait_for_selector(".metrics-panel", timeout=5000)
        check("1. “Metrics” in the More menu opens the panel; nothing is defined yet", "No metrics yet" in (page.text_content(".metrics-panel .metric-list") or ""))

        # 2. define Revenue through the form
        page.click(".metrics-panel button:has-text('New metric')")
        page.fill(".metric-form input[aria-label='Metric name']", "Revenue")
        page.select_option(".metric-form select[aria-label='Metric table']", "Sales")
        page.select_option(".metric-form select[aria-label='Metric aggregation']", "sum")
        page.select_option(".metric-form select[aria-label='Field']", "Amount")
        page.select_option(".metric-form select[aria-label='Currency column']", "Currency")
        page.fill(".metric-form input[aria-label='Reporting currency']", "eur")
        page.select_option(".metric-form select[aria-label='Metric format']", "€#,##0.00")
        page.fill(".metric-form textarea[aria-label='Metric description']", "Invoiced amount, EUR")
        page.click(".metric-form button:has-text('Save metric')")
        page.wait_for_timeout(300)
        m = metrics()
        listed = page.text_content(".metrics-panel li[data-metric='Revenue']") or ""
        check("2. a metric defined in the form is saved canonically (code upper case) and listed with its definition",
              len(m) == 1 and m[0]["name"] == "Revenue" and m[0]["measure"]["field"] == "Amount" and m[0]["measure"]["currency"] == "Currency" and m[0]["currency"] == "EUR" and m[0]["format"] == "€#,##0.00"
              and "sum of Sales[Amount]" in listed and "reporting EUR" in listed and "not used by a chart" in listed, (m, listed))

        # 3. a bad definition is refused with the engine's reason; nothing changes
        before = page.evaluate("() => window.__gw.book.toJson()")
        page.click(".metrics-panel button:has-text('New metric')")
        page.fill(".metric-form input[aria-label='Metric name']", "Broken")
        page.select_option(".metric-form select[aria-label='Metric aggregation']", "ratio")
        page.select_option(".metric-form select[aria-label='Numerator']", "Amount")
        page.click(".metric-form button:has-text('Save metric')")
        page.wait_for_timeout(200)
        err = page.text_content(".metric-form .metric-error") or ""
        check("3. a ratio without a denominator is refused with the engine's reason, and the workbook is unchanged",
              "a ratio needs a numerator and a denominator field" in err and page.evaluate("() => window.__gw.book.toJson()") == before, err)
        page.click(".metric-form button:has-text('Cancel')")

        # 4. the chart editor's picker: the measure refers to the metric; values and stat cards follow its format
        page.evaluate("(id) => window.__gw.getState().set({ selectedChart: id, panel: 'chart' })", C)
        page.wait_for_selector(".chart-panel select[aria-label='Metric']", timeout=5000)
        page.select_option(".chart-panel select[aria-label='Metric']", "Revenue")
        page.wait_for_timeout(300)
        ch = chart()
        d = page.evaluate(DATA_JS, C)
        texts = page.evaluate(TEXTS_JS, C)
        check("4. picking “Metric: Revenue” stores only the name on the chart; its bars equal the reference and its stat card shows the metric's format",
              ch["analytic"]["measures"][0].get("metric") == "Revenue" and not ch["analytic"]["measures"][0].get("field")
              and all(same(v, BY_REGION[c]) for c, v in zip(d["categories"], d["values"][0])) and euros(TOTAL) in texts
              and "Edit metric" in (page.text_content(".chart-panel") or ""),
              (ch["analytic"]["measures"], d, [t for t in texts if "€" in t]))

        page.screenshot(path=f"{OUT}/metrics-02-chart.png")

        # 5. a redefinition reaches the chart with no chart operation
        charts_before = page.evaluate("() => JSON.stringify(window.__gw.getState().charts)")
        page.evaluate("() => window.__gw.getState().set({ panel: 'metrics' })")
        page.wait_for_selector(".metrics-panel", timeout=5000)
        page.click(".metrics-panel li[data-metric='Revenue'] button:has-text('Edit')")
        page.select_option(".metric-form select[aria-label='Metric aggregation']", "average")
        page.click(".metric-form button:has-text('Save metric')")
        page.wait_for_timeout(300)
        d = page.evaluate(DATA_JS, C)
        check("5. changing the metric to an average changes the chart's bars to the reference averages; the chart object is untouched",
              all(same(v, AVG_REGION[c]) for c, v in zip(d["categories"], d["values"][0])) and page.evaluate("() => JSON.stringify(window.__gw.getState().charts)") == charts_before, d)
        page.evaluate("() => window.__gw.book.undo()")
        page.wait_for_timeout(200)

        # 6. decomposition: the metric is in the measure list; the tree's total equals the reference, in the metric's format
        page.evaluate("(id) => window.__gw.openDecomposition(id)", C)
        page.wait_for_selector(".decomp-panel .decomp-tree", timeout=5000)
        opts = page.evaluate("() => [...document.querySelectorAll('.decomp-controls select')[0].options].map((o) => o.textContent)")
        tree = page.evaluate("() => window.__gw.decompTree()")
        root_text = page.evaluate("() => document.querySelector(\".decomp-tree li.decomp-node[data-id='r'] > .decomp-row .decomp-value\")?.textContent ?? null")
        check("6. Break down by the metric: “Metric: Revenue” is the measure, the root equals the reference total and shows the metric's format",
              "Metric: Revenue" in opts and tree and same(tree["root"]["value"]["value"], TOTAL) and tree["measure"].get("metric") == "Revenue" and root_text and root_text.startswith(euros(TOTAL))
              and tree["root"]["split"]["check"]["status"] == "ok", (opts, tree and tree["root"]["value"], root_text))

        # 7. drill-through records add up, shown in the metric's format
        page.evaluate("(id) => window.__gw.openRecords(id)", C)
        page.wait_for_selector(".records-panel .records-summary", timeout=5000)
        page.wait_for_timeout(300)
        rp = page.text_content(".records-panel") or ""
        check("7. See records: the records add up to the chart, and the total is shown in the metric's format", "These records add up to the chart" in rp and f"Revenue: {euros(TOTAL)}" in rp, rp[:300])

        # 8. rename through the form: the chart follows
        page.evaluate("() => window.__gw.getState().set({ panel: 'metrics' })")
        page.wait_for_selector(".metrics-panel", timeout=5000)
        page.click(".metrics-panel li[data-metric='Revenue'] button:has-text('Edit')")
        page.fill(".metric-form input[aria-label='Metric name']", "Net sales")
        page.click(".metric-form button:has-text('Save metric')")
        page.wait_for_timeout(300)
        listed = page.text_content(".metrics-panel li[data-metric='Net sales']") or ""
        check("8. renaming the metric rewrites the chart's reference; the list says the chart uses it",
              chart()["analytic"]["measures"][0]["metric"] == "Net sales" and [x["name"] for x in metrics()] == ["Net sales"] and "used by 1 chart" in listed, (chart()["analytic"], listed))

        # 9. undo and redo the rename (the definition saved with it is one more step)
        page.evaluate("() => window.__gw.book.undo()")  # the set_metric saved with the rename
        page.evaluate("() => window.__gw.book.undo()")  # the rename
        page.wait_for_timeout(200)
        undone = chart()["analytic"]["measures"][0]["metric"] == "Revenue" and [x["name"] for x in metrics()] == ["Revenue"]
        page.evaluate("() => window.__gw.book.redo()")
        page.wait_for_timeout(200)
        check("9. undo restores the old name on the metric and on the chart; redo renames both again",
              undone and chart()["analytic"]["measures"][0]["metric"] == "Net sales" and [x["name"] for x in metrics()] == ["Net sales"], (undone, chart()["analytic"]["measures"]))

        # 10. removing a metric in use asks first, then the chart says why it has no numbers; undo recovers
        page.wait_for_selector(".metrics-panel li[data-metric='Net sales']", timeout=5000)
        page.click(".metrics-panel button[aria-label='Remove metric Net sales']")
        page.wait_for_timeout(300)
        d = page.evaluate(DATA_JS, C)
        asked = any("Used by 1 chart" in x for x in dialogs)
        page.evaluate("() => window.__gw.book.undo()")
        page.wait_for_timeout(200)
        d2 = page.evaluate(DATA_JS, C)
        check("10. removing a metric used by a chart asks first; the chart then shows “no metric named …”, never a number; undo brings it back",
              asked and d["error"] == 'no metric named "Net sales"' and not any(d["values"]) and d2["values"] and same(math.fsum(d2["values"][0]), TOTAL), (dialogs, d, d2["values"]))

        # 11. the panel marks a metric the data no longer supports
        heads_col = HEADERS.index("Amount")
        page.evaluate("([t, c]) => window.__gw.book.apply({ type: 'set_cell', table: t, row: 0, col: c, input: 'Net amount' })", [T, heads_col])
        page.wait_for_timeout(300)
        broken = page.text_content(".metrics-panel li[data-metric='Net sales'] .metric-problem") or ""
        page.evaluate("() => window.__gw.book.undo()")
        page.wait_for_timeout(300)
        check("11. a renamed column marks the metric “broken” with the engine's reason; undo mends it",
              'field "Amount" is not a header of table "Sales"' in broken and page.locator(".metrics-panel .metric-problem").count() == 0, broken)

        # 12. history: the definition, the rename and the removal are logged operations
        time.sleep(0.8)
        h = rest("GET", f"/api/files/{fid}/history?limit=100")
        types = [e.get("op", {}).get("type") for e in h.get("entries", []) if e.get("op")]
        check("12. the history log holds set_metric, rename_metric and the undo relay (restore_metrics)", {"set_metric", "rename_metric", "restore_metrics"} <= set(types), sorted(set(t for t in types if t)))

        # 13. another editor sees the definitions and a change relayed
        page2 = ctx.new_page()
        page2.on("pageerror", lambda e: errors.append(str(e)))
        page2.goto(f"{BASE}/?file={fid}", wait_until="networkidle")
        page2.wait_for_function("() => window.__gw && window.__gw.getState().fileId", timeout=30000)
        page2.wait_for_timeout(1200)
        first = metrics(page2)
        page.bring_to_front()
        page.evaluate("() => { const m = window.__gw.getState().metrics[0]; window.__gw.book.apply({ type: 'set_metric', name: m.name, metric: { ...m, format: '#,##0' } }); }")
        relayed = None
        deadline = time.time() + 8
        while time.time() < deadline:
            relayed = metrics(page2)
            if relayed and relayed[0].get("format") == "#,##0":
                break
            time.sleep(0.3)
        check("13. a second editor opens the document with its metrics, and a redefinition is relayed to it",
              [x["name"] for x in first] == ["Net sales"] and relayed and relayed[0].get("format") == "#,##0", (first, relayed))
        page2.close()

        # 14. a companion watch refers to the metric by name, with the metric's value
        time.sleep(0.8)
        w = rest("POST", f"/api/files/{fid}/companion/watches", {"purpose": "Net sales total", "metric": "Net sales", "kind": "threshold", "op": "<", "value": 1, "sustain": 1})
        c = rest("GET", f"/api/files/{fid}/companion")
        ww = next((x for x in c.get("watches", []) if x["id"] == w.get("id")), None)
        check("14. a companion watch on the metric by name is evaluated through it (value = reference total)",
              ww and ww["def"].get("metric") == "Net sales" and ww["observations"] and same(ww["observations"][-1]["value"], TOTAL) and ww["health"] == "ok", (w, ww and ww["observations"][-1:]))

        # 15. the assistant: context lists metrics canonically; its reply defines a metric and charts it by name
        page.evaluate("() => window.__gw.getState().set({ panel: 'ai' })")
        page.wait_for_selector(".ai-panel textarea", timeout=5000)
        page.fill(".ai-panel textarea", "Please chart a revenue metric by region")
        page.keyboard.press("Enter")
        page.wait_for_selector(".ai-panel table.diff", timeout=20000)
        diff = page.text_content(".ai-panel table.diff") or ""
        n_charts = len(page.evaluate("() => window.__gw.getState().charts"))
        check("15. the assistant's reply is a diff: a metric definition and a chart that refers to it by name (nothing applied yet)",
              "metric Gross sales" in diff and "sum of Sales[Amount]" in diff and "metrics Gross sales by Region" in diff and not any(x["name"] == "Gross sales" for x in metrics()), diff[:300])
        page.click(".ai-panel button:has-text('Apply')")
        page.wait_for_timeout(500)
        gross = next((x for x in metrics() if x["name"] == "Gross sales"), None)
        charts = page.evaluate("() => window.__gw.getState().charts")
        newc = charts[-1] if len(charts) == n_charts + 1 else None
        nd = page.evaluate(DATA_JS, newc["id"]) if newc else None
        check("16. applied: the metric exists (reporting EUR, format) and the new chart is bound to it by name, with the reference numbers",
              gross and gross["currency"] == "EUR" and gross["format"] == "#,##0.00" and newc and newc["analytic"]["measures"] == [{"name": "", "field": "", "agg": "", "numerator": "", "denominator": "", "currency": "", "metric": "Gross sales"}]
              and nd and all(same(v, BY_REGION[cat]) for cat, v in zip(nd["categories"], nd["values"][0])), (gross, newc and newc["analytic"], nd))
        system = ""
        for body in chat_bodies:
            try:
                system = next((m["content"] for m in json.loads(body)["messages"] if m["role"] == "system"), "") or system
            except Exception:
                pass
        check("17. the assistant was shown each metric canonically and which charts refer to it by name, and told to refer to metrics by name",
              "### Metrics\nNet sales = sum of Sales[Amount]; currency column Currency; reporting EUR; format #,##0 — Invoiced amount, EUR" in system
              and '"By region": Sales by Region; metric Net sales' in system and "refer to it by name" in system, system[system.find("### Metrics"):][:300])

        # 18. save and reload: the metrics and the chart references come back
        page.click(".topbar .save-btn")
        page.wait_for_function("() => !window.__gw.getState().dirty", timeout=8000)
        names_before = sorted(x["name"] for x in metrics())
        page.goto(f"{BASE}/?file={fid}", wait_until="networkidle")
        page.wait_for_function("() => window.__gw && window.__gw.getState().fileId", timeout=30000)
        page.wait_for_timeout(800)
        after = sorted(x["name"] for x in metrics())
        d = page.evaluate(DATA_JS, C)
        check("18. after saving and reopening, the metrics and the charts that refer to them are back, with the same numbers",
              after == names_before == ["Gross sales", "Net sales"] and all(same(v, BY_REGION[c]) for c, v in zip(d["categories"], d["values"][0])), (after, d))

        # 19. a removed metric makes the watch an error, never ok
        page.evaluate("() => window.__gw.book.apply({ type: 'set_metric', name: 'Net sales', metric: null })")
        time.sleep(0.8)
        rest("POST", f"/api/files/{fid}/companion/check")
        deadline = time.time() + 10
        ww = None
        while time.time() < deadline:
            c = rest("GET", f"/api/files/{fid}/companion")
            ww = next((x for x in c.get("watches", []) if x["id"] == w.get("id")), None)
            if ww and ww["health"] == "error":
                break
            time.sleep(0.4)
        check("19. with its metric removed, the watch is in error and names it", ww and ww["health"] == "error" and "no metric named" in (ww["observations"][-1].get("error") or ""), ww and (ww["health"], ww["observations"][-1:]))

        # 20. "Save as metric…" on a chart's inline measure: the measure becomes a reference to the new metric
        U = page.evaluate("() => window.__gw.book.apply({ type: 'add_chart', chart: { kind: 'bar', title: 'Units', x: 700, y: 40, w: 480, h: 320, show_values: true, stat_cards: false, categories: '', series: [],"
                          " analytic: { table: 'Sales', dims: ['Region'], measures: [{ field: 'Units', agg: 'sum' }], sort: 'key' } } }).created_chart")
        page.evaluate("(id) => window.__gw.getState().set({ selectedChart: id, panel: 'chart' })", U)
        page.wait_for_selector(".chart-panel button:has-text('Save as metric')", timeout=5000)
        page.click(".chart-panel button:has-text('Save as metric')")
        page.wait_for_selector(".metric-form input[aria-label='Metric name']", timeout=5000)
        prefilled = page.input_value(".metric-form select[aria-label='Field']")
        page.fill(".metric-form input[aria-label='Metric name']", "Units sold")
        page.click(".metric-form button:has-text('Save metric')")
        page.wait_for_timeout(300)
        uc = page.evaluate("(id) => window.__gw.getState().charts.find((c) => c.id === id)", U)
        ud = page.evaluate(DATA_JS, U)
        units = {r: ref_sum("Units", lambda o, r=r: o["Region"] == r) for r in REGIONS}
        check("20. “Save as metric…” on a chart's measure defines the metric from it and turns the measure into a reference, same numbers",
              prefilled == "Units" and any(x["name"] == "Units sold" and x["measure"]["field"] == "Units" for x in metrics()) and uc["analytic"]["measures"][0].get("metric") == "Units sold"
              and all(same(v, units[c]) for c, v in zip(ud["categories"], ud["values"][0])), (prefilled, uc["analytic"]["measures"], ud))

        # 21. the panel fits a narrow side panel and the page made no errors
        page.evaluate("() => window.__gw.getState().set({ panel: 'metrics' })")
        page.wait_for_selector(".metrics-panel", timeout=5000)
        page.screenshot(path=f"{OUT}/metrics-01.png")
        wide = page.evaluate("() => { const p = document.querySelector('.metrics-panel'); return p.scrollWidth <= p.clientWidth + 1; }")
        check("21. the Metrics panel has no horizontal overflow", wide)
        check("22. no page errors", not errors, errors[:3])
        browser.close()
finally:
    stop()
    if "--data" not in sys.argv:
        shutil.rmtree(DATA, ignore_errors=True)

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
sys.exit(1 if failed else 0)

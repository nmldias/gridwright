#!/usr/bin/env python3
"""Decomposition tree in the browser (roadmap 7.4, assessment 13 Oct 2026).
Over the synthetic inventory (e2e/fixtures/automotive.mjs, 2,000 vehicles, Model blanked on every
97th row): "Break down" on an analytical chart opens a tree whose root and branches equal an
independent sum over the generator's rows; each level says its children add up to the parent; a
different field per sibling; top N folds the rest into "Other (k)", which can itself be split and
reconciles; "(blank)" is its own node; a ratio says its children do not sum and shows its parts;
a suggested split names its rule and runner-up and can be accepted; a node's records add up to it;
a cross-filter from another chart re-runs the tree and keeps a level whose node left; the outline
works from the keyboard and fits a 320px panel; the workbook and its undo stack are unchanged.
    python3 e2e/decomposition_ui.py [--port 8811] [--data /tmp/gw-decomp]
Starts its own loopback server (server/dist and the client build it serves).
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
import urllib.request
from collections import Counter

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8811
DATA = None
for i, a in enumerate(sys.argv):
    if a == "--port":
        PORT = int(sys.argv[i + 1])
    if a == "--data":
        DATA = sys.argv[i + 1]
DATA = DATA or tempfile.mkdtemp(prefix="gw-decomp-")
BASE = f"http://127.0.0.1:{PORT}"
OUT = os.environ.get("E2E_OUT", "/tmp/gridwright-e2e")
os.makedirs(OUT, exist_ok=True)

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"{'PASS' if ok else 'FAIL'} {name}{(' — ' + str(detail)[:400]) if detail else ''}")


# the benchmark rows, from the same generator the engine suite uses; Model blank on every 97th row
fixture = json.loads(subprocess.check_output(
    ["node", "--input-type=module", "-e",
     "import { rows, table } from './e2e/fixtures/automotive.mjs'; const r = rows(2000);"
     " r.forEach((o, i) => { if (i % 97 === 5) o.Model = ''; });"
     " process.stdout.write(JSON.stringify({ rows: r, table: table(r) }));"], cwd=ROOT))
ROWS, VALUES = fixture["rows"], fixture["table"]
AMOUNT = "Inventory value AOA"


def num(v):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def ref_sum(where=lambda o: True):
    return math.fsum(num(o[AMOUNT]) for o in ROWS if where(o) and num(o[AMOUNT]) is not None)


def ref_ratio(where=lambda o: True):
    """Σ landed ÷ Σ price over the rows where both are numbers (a ratio of sums, not a mean of ratios)."""
    rs = [o for o in ROWS if where(o) and num(o["Landed cost AOA"]) is not None and num(o["Selling price AOA"]) is not None]
    return math.fsum(num(o["Landed cost AOA"]) for o in rs) / math.fsum(num(o["Selling price AOA"]) for o in rs)


def same(a, b):
    """Equal at 15 significant digits (the engine's standard), or both missing."""
    if a is None or b is None:
        return a is None and b is None
    return a == b or float(f"{a:.14e}") == float(f"{b:.14e}")


def shown(x):
    """A number as the panel shows it in en-US (grouping, at most 2 decimals)."""
    s = f"{x:,.2f}"
    return s.rstrip("0").rstrip(".") if "." in s else s


BRANCH_SUM = {b: ref_sum(lambda o, b=b: o["Branch"] == b) for b in {o["Branch"] for o in ROWS}}
BRANCH_ORDER = sorted(BRANCH_SUM, key=lambda b: (-BRANCH_SUM[b], b.lower()))
TOP1, TOP2 = BRANCH_ORDER[0], BRANCH_ORDER[1]
REST = BRANCH_ORDER[2:]

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

POINT_JS = """([id, label]) => { const c = window.__gw.getState().charts.find((x) => x.id === id);
  const d = window.__gw.charts.chartData(c);
  const i = d.categories.indexOf(label);
  const p = window.__gw.charts.chartLayout(c, d, c.w, c.h).find((q) => q.k === 'rect' && q.mark === i);
  if (!p) return null;
  const v = window.__gw.viewport(); const host = document.querySelector('.canvas-host').getBoundingClientRect();
  return { x: host.left + (c.x + p.x + p.w / 2) * v.zoom + v.x, y: host.top + (c.y + p.y + p.h / 2) * v.zoom + v.y }; }"""
# the tree as the panel last computed it, and as the outline shows it
TREE_JS = "() => window.__gw.decompTree()"
FIND_JS = """(id) => { const walk = (n) => { if (n.id === id) return n; for (const c of n.split?.children ?? []) { const f = walk(c); if (f) return f; } return null; };
  const t = window.__gw.decompTree(); return t ? walk(t.root) : null; }"""
ROW_JS = """(id) => { const li = [...document.querySelectorAll('.decomp-tree li.decomp-node')].find((x) => x.dataset.id === id); if (!li) return null;
  const row = li.querySelector(':scope > .decomp-row');
  const level = li.querySelector(':scope > .decomp-level');
  const kids = [...li.querySelectorAll(':scope > ul > li.decomp-node')];
  return { label: row.querySelector('.decomp-label').textContent, title: row.querySelector('.decomp-label').getAttribute('title'),
           value: row.querySelector('.decomp-value').textContent, share: row.querySelector('.decomp-share')?.textContent ?? null,
           parts: row.querySelector('.decomp-parts')?.textContent ?? null,
           options: [...row.querySelectorAll('select.decomp-split option')].map((o) => o.value),
           expanded: li.getAttribute('aria-expanded'), selected: li.getAttribute('aria-selected'),
           level: level ? { check: level.dataset.check, text: level.textContent } : null,
           kids: kids.map((k) => ({ id: k.dataset.id, kind: k.dataset.kind, label: k.querySelector('.decomp-label').textContent })) }; }"""

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
            [spec(["Branch", "Manufacturer"], [{"field": AMOUNT, "agg": "sum"}, {"agg": "ratio", "numerator": "Landed cost AOA", "denominator": "Selling price AOA"}], 40, 40),
             spec(["Branch"], [{"agg": "count"}], 640, 40)])
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        before_json = page.evaluate("() => window.__gw.book.toJson()")
        before_undo = page.evaluate("() => window.__gw.getState().canUndo")

        def tree():
            return page.evaluate(TREE_JS)

        def node(i):
            return page.evaluate(FIND_JS, i)

        def row(i):
            return page.evaluate(ROW_JS, i)

        def nid(*steps):
            return "r" + "".join(f"/{f.lower()}={k}" for f, k in steps)

        def split_select(i, field):
            page.locator(f".decomp-tree li.decomp-node[data-id='{i}'] > .decomp-row select.decomp-split").select_option(field)
            page.wait_for_timeout(200)

        def click_row(i):
            page.locator(f".decomp-tree li.decomp-node[data-id='{i}'] > .decomp-row .decomp-label").click()
            page.wait_for_timeout(150)

        # 1. open from the chart panel's "Break down"
        page.evaluate("(id) => window.__gw.getState().set({ selectedChart: id, panel: 'chart' })", A)
        page.wait_for_timeout(200)
        page.click(".chart-panel button:has-text('Break down')")
        page.wait_for_selector(".decomp-panel .decomp-tree", timeout=5000)
        t = tree()
        total = ref_sum()
        r0 = row("r")
        check("1. “Break down” opens the tree; its root equals the reference sum",
              t and same(t["root"]["value"]["value"], total) and r0 and r0["value"] == shown(total) and t["root"]["rows"] == len(ROWS),
              (t and t["root"]["value"], r0 and r0["value"], shown(total)))
        # 2. by branch, value-descending
        kids = r0["kids"] if r0 else []
        vals = [node(k["id"])["value"]["value"] for k in kids]
        check("2. Branch shows 5 nodes, largest first, each equal to the reference",
              [k["label"] for k in kids] == BRANCH_ORDER and all(same(v, BRANCH_SUM[k["label"]]) for v, k in zip(vals, kids)),
              ([k["label"] for k in kids], BRANCH_ORDER))
        check("3. the level says its children add up to the parent", r0 and r0["level"] and r0["level"]["check"] == "ok" and "✓ children add up to the parent" in r0["level"]["text"],
              r0 and r0["level"])
        # 4. a different field per sibling
        top1, top2 = nid(("Branch", f"s:{TOP1.lower()}")), nid(("Branch", f"s:{TOP2.lower()}"))
        split_select(top1, "Manufacturer")
        split_select(top2, "Model")
        n1, n2 = node(top1), node(top2)
        man_ref = {m: ref_sum(lambda o, m=m: o["Branch"] == TOP1 and o["Manufacturer"] == m) for m in {o["Manufacturer"] for o in ROWS if o["Branch"] == TOP1}}
        ok4 = (n1 and n1.get("split") and n1["split"]["field"] == "Manufacturer" and n2 and n2.get("split") and n2["split"]["field"] == "Model"
               and {c["label"]: c["value"]["value"] for c in n1["split"]["children"]}.keys() == man_ref.keys()
               and all(same(c["value"]["value"], man_ref[c["label"]]) for c in n1["split"]["children"])
               and n1["split"]["check"]["status"] == "ok" and n2["split"]["check"]["status"] == "ok")
        check(f"4. {TOP1} splits by Manufacturer and {TOP2} by Model, each reconciled", ok4,
              n1 and n1.get("split") and [(c["label"], c["value"]["value"]) for c in n1["split"]["children"]])
        # 5. fields on the path are not offered
        r1 = row(top1)
        toyota = nid(("Branch", f"s:{TOP1.lower()}"), ("Manufacturer", "s:toyota"))
        rt = row(toyota)
        check("5. a field on the node's path is not offered in its “Split by” list",
              r1 and "Branch" not in r1["options"] and "Manufacturer" in r1["options"] and rt and "Branch" not in rt["options"] and "Manufacturer" not in rt["options"] and "Model" in rt["options"],
              (r1 and r1["options"], rt and rt["options"]))
        # 6. top N = 2
        page.fill(".decomp-controls input[type='number']", "2")
        page.wait_for_timeout(300)
        other = nid(("Branch", "other"))
        ro = row(other)
        on = node(other)
        rest_sum = ref_sum(lambda o: o["Branch"] in REST)
        check("6. Top N = 2 shows “Other (3)”, its tooltip lists the folded values, and it is recomputed from its rows",
              ro and ro["label"] == "Other (3)" and ro["title"] and set(ro["title"].split(", ")) == set(REST) and on and same(on["value"]["value"], rest_sum),
              (ro and (ro["label"], ro["title"]), on and on["value"]["value"], rest_sum))
        # 7. Other split by Model
        split_select(other, "Model")
        on = node(other)
        ro = row(other)
        check("7. Other can be split by Model, and that split reconciles",
              on and on.get("split") and on["split"]["field"] == "Model" and on["split"]["check"]["status"] == "ok" and on["split"]["check"]["rows_ok"] and ro["level"]["check"] == "ok"
              and same(math.fsum(c["value"]["value"] or 0 for c in on["split"]["children"]), rest_sum),
              on and on.get("split") and on["split"]["check"])
        # 8. (blank) under Model
        blank_rows = sum(1 for o in ROWS if o["Branch"] in REST and o["Model"] == "")
        bl = [c for c in (on["split"]["children"] if on and on.get("split") else []) if c["kind"] == "blank"]
        kinds = [k["kind"] for k in (ro["kids"] if ro else [])]
        check("8. “(blank)” is its own node under Model, last, with the reference count",
              blank_rows > 0 and len(bl) == 1 and bl[0]["rows"] == blank_rows and kinds and kinds[-1] == "blank" and ro["kids"][-1]["label"] == "(blank)"
              and same(bl[0]["value"]["value"], ref_sum(lambda o: o["Branch"] in REST and o["Model"] == "")),
              (blank_rows, bl and bl[0]["rows"], kinds))
        # 9. ratio
        page.select_option(".decomp-controls select >> nth=0", label="Landed cost AOA ÷ Selling price AOA")
        page.wait_for_timeout(300)
        t = tree()
        r0 = row("r")
        shares = page.evaluate("() => document.querySelectorAll('.decomp-tree .decomp-share').length")
        n1 = node(top1)
        check("9. a ratio: “children do not sum to parent (ratio)”, no %, num ÷ den on each node, each = Σ ÷ Σ",
              r0["level"]["check"] == "recomputed" and "children do not sum to parent (ratio)" in r0["level"]["text"] and "numerators and denominators add up ✓" in r0["level"]["text"]
              and shares == 0 and r0["parts"] and "÷" in r0["parts"] and same(t["root"]["value"]["value"], ref_ratio()) and same(n1["value"]["value"], ref_ratio(lambda o: o["Branch"] == TOP1)),
              (r0["level"], shares, r0["parts"], t["root"]["value"]["value"], ref_ratio()))
        page.select_option(".decomp-controls select >> nth=0", label=f"Sum of {AMOUNT}")
        page.wait_for_timeout(300)
        # 10. suggestion on a node without a split: the largest manufacturer of the top branch
        named = [c["id"] for c in node(top1)["split"]["children"] if c["kind"] == "value"]
        leaf, leaf2 = named[0], named[1]
        # first split it, collapse it and take the split away: accepting later must show the level
        split_select(leaf, "Model")
        page.click(f".decomp-tree li.decomp-node[data-id='{leaf}'] > .decomp-row .decomp-caret")
        page.wait_for_timeout(150)
        split_select(leaf, "-")
        click_row(leaf)
        page.wait_for_timeout(200)
        chip = page.locator(".decomp-suggest")
        chip_text = chip.first.text_content() if chip.count() else ""
        sug = tree()["suggestion"]
        ok10a = chip.count() == 1 and sug and sug["field"] and f"Suggested: {sug['field']}" in chip_text and "Rule: highest value of a single item" in chip_text and "runner-up" in chip_text
        if chip.count():
            page.click(".decomp-suggest button:has-text('Use this split')")
            page.wait_for_timeout(250)
        nt = node(leaf)
        rl = row(leaf)
        # the pure helper too: a collapsed id left over for the node is cleared on acceptance
        pure = page.evaluate("""() => { const d = window.__gw.getState().decomp; const t = window.__gw.decompTree();
          const s = { node_id: 'r/x=s:y', at: [{ field: 'X', key: { s: 'y' }, other: false }], field: 'Model' };
          return window.__gw.decomp.acceptSuggestion({ ...d, collapsed: ['r/x=s:y', 'keep'] }, { ...t, suggestion: s }).collapsed; }""")
        check("10. the suggestion names its rule and runner-up; “Use this split” adds the level, shown expanded (also after a collapsed split was removed), and the chip goes away",
              ok10a and nt and nt.get("split") and nt["split"]["field"] == sug["field"] and page.locator(".decomp-suggest").count() == 0
              and rl and rl["expanded"] == "true" and rl["level"] and len(rl["kids"]) > 0 and pure == ["keep"],
              (chip_text[:300], nt and nt.get("split") and nt["split"]["field"], rl and (rl["expanded"], len(rl["kids"])), pure))
        # 11. suggestions off
        page.uncheck(".decomp-controls input[type='checkbox']")
        page.wait_for_timeout(200)
        click_row(leaf2)
        check("11. with suggestions off there is no chip", page.locator(".decomp-suggest").count() == 0 and tree()["suggestion"] is None)
        # 12. records of a node
        click_row(other)
        page.click(f".decomp-tree li.decomp-node[data-id='{other}'] > .decomp-row button:has-text('Records')")
        page.wait_for_timeout(300)
        rc = page.evaluate("() => { const p = document.querySelector('.decomp-records [data-check]'); return p ? { check: p.dataset.check, text: p.textContent, rows: document.querySelectorAll('.decomp-records tbody tr').length } : null; }")
        n_rest = sum(1 for o in ROWS if o["Branch"] in REST)
        check("12. a node's records add up to it (✓) and their count is the node's rows",
              rc and rc["check"] == "ok" and f"these {n_rest:,} records add up to the node ✓" in rc["text"] and rc["rows"] == 50, rc)
        page.click(".decomp-records button:has-text('Close records')")
        # 13. a cross-filter from the other chart
        page.evaluate("() => window.__gw.getState().set({ selectedChart: null })")
        pick = REST[0]
        pt = page.evaluate(POINT_JS, [B, pick])
        if pt:
            page.mouse.click(pt["x"], pt["y"])
            page.wait_for_timeout(450)
        page.wait_for_timeout(200)
        t = tree()
        warn = page.evaluate("() => [...document.querySelectorAll('.decomp-panel p.warning')].map((p) => p.textContent)")
        scope = page.evaluate("() => document.querySelector('.decomp-scope').textContent")
        page.evaluate("() => window.__gw.crossfilter.clearMarks()")
        page.wait_for_timeout(250)
        back = tree()
        check("13. a cross-filter from the other chart re-runs the tree; a removed node's level is kept, said so, and comes back when cleared",
              pt and t and same(t["root"]["value"]["value"], BRANCH_SUM[pick]) and any(f"{TOP1} is no longer under Branch" in w and "level kept" in w for w in warn)
              and f"filtered by Branch = {pick}" in scope and back and not back["unresolved"] and node(top1).get("split"),
              (pick, t and t["root"]["value"]["value"], warn, back and back["unresolved"]))
        # 14. keyboard
        click_row("r")
        page.focus(".decomp-tree")
        sel = lambda: page.evaluate("() => window.__gw.getState().decomp.selected")
        first = row("r")["kids"][0]["id"]
        page.keyboard.press("ArrowDown")
        s1 = sel()
        page.keyboard.press("ArrowDown")
        s2 = sel()
        page.keyboard.press("ArrowUp")
        s3 = sel()
        page.keyboard.press("ArrowLeft")
        e1 = row(first)["expanded"]
        page.keyboard.press("ArrowRight")
        e2 = row(first)["expanded"]
        page.keyboard.press("ArrowLeft")
        page.keyboard.press("ArrowLeft")
        s4 = sel()
        splits_before = page.evaluate("() => JSON.stringify(window.__gw.getState().decomp.splits)")
        # → on an expanded node goes to its first child; focus stays on the tree (never in the
        # "Split by" list, where the next arrow key would replace the split on Windows and Linux)
        page.keyboard.press("ArrowRight")
        s5 = sel()
        on_tree = page.evaluate("() => document.activeElement?.classList.contains('decomp-tree')")
        page.keyboard.press("ArrowDown")
        s6 = sel()
        splits_after = page.evaluate("() => JSON.stringify(window.__gw.getState().decomp.splits)")
        # the tree names the selected item for assistive technology
        active = page.evaluate("""() => { const t = document.querySelector('.decomp-tree'); const id = t.getAttribute('aria-activedescendant');
          const li = id ? document.getElementById(id) : null; return li ? { id: li.dataset.id, selected: li.getAttribute('aria-selected') } : null; }""")
        check("14. ↑/↓ move the selection, ← collapses then goes to the parent, → expands then goes to the first child without touching the split list; aria-activedescendant follows",
              s1 == first and s2 not in (first, "r") and s3 == first and e1 == "false" and e2 == "true" and s4 == "r" and s5 == first and on_tree
              and s6 not in (first, "r") and splits_after == splits_before and tree()["root"]["split"]["field"] == "Branch"
              and active and active["id"] == s6 and active["selected"] == "true",
              (s1, s2, s3, e1, e2, s4, s5, on_tree, s6, splits_after == splits_before, active))
        page.screenshot(path=os.path.join(OUT, "decomposition.png"))
        # 15. a 320px panel
        page.evaluate("() => window.__gw.getState().set({ panelWidth: 320 })")
        page.wait_for_timeout(300)
        over = page.evaluate("""() => { const side = document.querySelector('.side'); const p = document.querySelector('.decomp-panel');
          const right = side.getBoundingClientRect().right + 1;
          const out = [...p.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().right > right && !e.closest('.records-table')).map((e) => e.className || e.tagName);
          return { w: side.getBoundingClientRect().width, scroll: side.scrollWidth - side.clientWidth, pscroll: p.scrollWidth - p.clientWidth, out: out.slice(0, 5) }; }""")
        check("15. at a 320px panel nothing overflows sideways", over["w"] <= 321 and over["scroll"] <= 0 and over["pscroll"] <= 0 and not over["out"], over)
        page.screenshot(path=os.path.join(OUT, "decomposition-320.png"))
        # 16. read-only
        check("16. the workbook and its undo stack are unchanged, and there were no page errors",
              page.evaluate("() => window.__gw.book.toJson()") == before_json and page.evaluate("() => window.__gw.getState().canUndo") == before_undo and not errors, errors[:3])
        # 17. view-only changes do not re-run the engine (suggestions are off here)
        page.evaluate("() => { window.__gw.decompTree().__probe = 1; }")
        page.click(f".decomp-tree li.decomp-node[data-id='{top1}'] > .decomp-row .decomp-caret")
        page.wait_for_timeout(150)
        page.click(f".decomp-tree li.decomp-node[data-id='{top1}'] > .decomp-row .decomp-caret")
        page.wait_for_timeout(150)
        click_row(top2)
        page.click(f".decomp-tree li.decomp-node[data-id='{top2}'] > .decomp-row button:has-text('Records')")
        page.wait_for_timeout(250)
        page.click(".decomp-records button:has-text('Close records')")
        page.wait_for_timeout(150)
        same_tree = page.evaluate("() => window.__gw.decompTree().__probe === 1")
        page.fill(".decomp-controls input[type='number']", "3")
        page.wait_for_timeout(300)
        rerun = page.evaluate("() => window.__gw.decompTree().__probe === undefined && window.__gw.decompTree().top_n === 3")
        page.fill(".decomp-controls input[type='number']", "2")
        page.wait_for_timeout(300)
        check("17. collapsing, expanding, selecting (suggestions off) and records reuse the tree; a new Top N re-runs it", same_tree and rerun, (same_tree, rerun))

        # the remaining checks change the workbook on purpose (after the read-only check 16)
        # 18. a decimal-comma workbook: plain numbers, shares and counts follow it, whatever the browser
        page.evaluate("() => window.__gw.book.apply({ type: 'set_decimal_comma', on: true })")
        page.wait_for_function("() => window.__gw.getState().decimalComma === true", timeout=5000)
        page.wait_for_timeout(200)
        swap = lambda x: x.translate(str.maketrans(",.", ".,"))
        r0 = row("r")
        k0 = row(top1)
        share = BRANCH_SUM[TOP1] / total * 100
        share_txt = f"{share:,.1f}".rstrip("0").rstrip(".")
        rows_txt = page.evaluate("() => document.querySelector('.decomp-tree .decomp-rows').textContent")
        check("18. with the workbook's decimal comma the tree shows 1.234,5-style values, shares and counts",
              r0["value"] == swap(shown(total)) and k0["share"] == swap(share_txt) + "%" and rows_txt == f"{len(ROWS):,} rows".replace(",", "."),
              (r0["value"], swap(shown(total)), k0["share"], swap(share_txt), rows_txt))
        page.evaluate("() => window.__gw.book.apply({ type: 'set_decimal_comma', on: false })")
        page.wait_for_function("() => window.__gw.getState().decimalComma === false", timeout=5000)

        # 19. formats: a count of a field with blanks is exact (no "incomplete"), an average's n is a
        # count (not an amount), and a currency column's format is not put on other currencies
        heads = VALUES[0]
        page.evaluate("""([t, cols]) => { for (const c of cols) window.__gw.book.apply({ type: 'set_format', table: t, r0: 1, c0: c[0], r1: 1, c1: c[0], format: { number_format: c[1] } }); }""",
                      [T, [[heads.index(AMOUNT), '#,##0.00 "Kz"'], [heads.index("Landed cost"), "currency:AOA"]]])
        page.wait_for_timeout(200)

        def reopen(measure):
            page.evaluate("(m) => { const d = window.__gw.getState().decomp; window.__gw.openDecomposition({ ...d, measure: m, measures: [m], splits: [{ path: [], field: 'Branch' }], collapsed: [], records: null, selected: 'r', selectedPath: [] }); }", measure)
            page.wait_for_timeout(300)
            return page.evaluate("""() => { const r = document.querySelector('.decomp-tree li.decomp-node[data-id="r"] > .decomp-row');
              return { value: r.querySelector('.decomp-value').textContent, parts: r.querySelector('.decomp-parts')?.textContent ?? null,
                       badges: [...r.querySelectorAll('.decomp-badge')].map((b) => b.textContent) }; }""")
        blanks = sum(1 for o in ROWS if o["Model"] == "")
        cnt = reopen({"agg": "count", "field": "Model"})
        cnt_tree = tree()
        avg = reopen({"agg": "average", "field": AMOUNT})
        avg_n = tree()["root"]["value"]["n"]
        cur = reopen({"field": "Landed cost", "currency": "Currency"})
        cur_tree = tree()
        codes = [c["currency"] for c in cur_tree["root"]["value"].get("by_currency", [])]
        check("19. a count with blanks shows no “incomplete”; an average's n reads as a count; amounts in a currency column do not take the first row's currency format",
              blanks > 0 and cnt_tree["root"]["value"]["missing"] == blanks and not any("incomplete" in b for b in cnt["badges"])
              and avg["parts"] and avg["parts"].endswith(f" ÷ {avg_n:,}") and "Kz" in avg["parts"].split(" ÷ ")[0]
              and cur_tree["root"]["value"]["status"] == "mixed_currency" and len(codes) >= 2 and "Kz" not in cur["value"] and all(c in cur["value"] for c in codes),
              (blanks, cnt, avg, avg_n, cur["value"], codes))

        # 20. a header renamed under a stored split: the panel offers to remove the stale levels
        reopen({"field": AMOUNT, "agg": "sum"})
        split_select(top1, "Manufacturer")
        page.evaluate("([t, c]) => window.__gw.book.apply({ type: 'set_cells', table: t, row: 0, col: c, values: [['Make']] })", [T, heads.index("Manufacturer")])
        page.wait_for_timeout(300)
        err = page.evaluate("() => document.querySelector('.decomp-panel p.error')?.textContent ?? null")
        btn = page.locator(".decomp-recover button:has-text('no longer headers')")
        had_btn = btn.count() == 1
        if had_btn:
            btn.click()
            page.wait_for_timeout(300)
        after = tree()
        check("20. after a split's header is renamed, “Remove 1 level on fields that are no longer headers” brings the tree back",
              err and "Manufacturer" in err and had_btn and after and after["root"]["split"]["field"] == "Branch" and not node(top1).get("split")
              and page.locator(".decomp-panel p.error").count() == 0,
              (err, had_btn, after and after["root"].get("split", {}).get("field")))

        # 21. numeric and date keys read as their column shows them in Other's tooltip
        page.evaluate("() => { const d = window.__gw.getState().decomp; window.__gw.openDecomposition({ ...d, topN: 2, splits: [{ path: [], field: 'Purchase date' }], collapsed: [], records: null, selected: 'r', selectedPath: [] }); }")
        page.wait_for_timeout(300)
        od = row(nid(("Purchase date", "other")))
        named = [k["label"] for k in row("r")["kids"] if k["kind"] == "value"]
        titles = (od["title"] or "").split(", ") if od else []
        digits_only = [x for x in titles[:20] if x.replace(".", "").isdigit()]
        check("21. Other's tooltip shows dates as the column does (like the named items), not serial numbers",
              od and len(titles) > 0 and not digits_only and named and not named[0].replace(".", "").isdigit(),
              (named[:2], titles[:3]))
        check("22. no page errors in the checks that changed the workbook", not errors, errors[:3])
        browser.close()
finally:

    stop()
    if "--data" not in sys.argv:
        shutil.rmtree(DATA, ignore_errors=True)

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
sys.exit(1 if failed else 0)

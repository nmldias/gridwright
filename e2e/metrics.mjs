#!/usr/bin/env node
// Governed metrics on the shipped engine (13 Oct 2026 assessment, phase 7.5): metric definitions are
// document operations (set_metric, rename_metric, undo through restore_metrics), and analysis,
// decomposition and records refer to a metric by name so one definition is used everywhere. Every
// number is checked against an independent JavaScript reference computed from the synthetic
// 10,000-vehicle generator's own rows (e2e/fixtures/automotive.mjs), not from the workbook.
// Covers: definition and round trip (a workbook without metrics is unchanged), a reference equals the
// definition inline and the reference arithmetic, non-additive metrics, a redefinition reaching a
// bound chart with no chart operation, rename / remove / table rename with undo and redo, the
// reporting currency (label, currency_mismatch with the amount per currency), decomposition and
// records through a metric, definition-time refusals with exact messages, drift in the data,
// replay on another replica (relayed ops and undo), read-only queries and latency budgets.
import { createRequire } from 'node:module';
import path from 'node:path';
import { HEADERS, rows as makeRows, table } from './fixtures/automotive.mjs';

const { Book } = createRequire(import.meta.url)(path.resolve(process.argv[2] || 'server/engine', 'gridwright_core.js'));
let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  ok ? passed++ : failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}
const close = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ---- data
const data = makeRows(10000);
const b = new Book('governed');
const log = []; // every op applied locally (refused ones too, as the server logs them), for the replay check
let refused = 0;
const apply = (op) => {
  log.push(op);
  const ch = JSON.parse(b.apply(JSON.stringify(op)));
  if (ch.error) refused++;
  return ch;
};
const undo = () => {
  const ch = JSON.parse(b.undo());
  for (const op of ch.ops ?? []) log.push(op); // the relay form other replicas apply
  return ch;
};
const redo = () => {
  const ch = JSON.parse(b.redo());
  for (const op of ch.ops ?? []) log.push(op);
  return ch;
};
const start = b.to_json();
apply({ type: 'add_table', name: 'Inventory', x: 900, y: 0, rows: data.length + 1, cols: HEADERS.length, values: table(data) });
const analyze = (q) => JSON.parse(b.analyze(JSON.stringify(q)));
const records = (q) => JSON.parse(b.analyze_records(JSON.stringify(q)));
const decompose = (q) => JSON.parse(b.decompose(JSON.stringify(q)));
const metrics = () => JSON.parse(b.metrics());
const define = (metric) => apply({ type: 'set_metric', name: metric.name, metric });

// ---- reference arithmetic over the generator rows
const groupBy = (rs, key) => {
  const m = new Map();
  for (const o of rs) {
    const k = String(o[key]).toLowerCase();
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(o);
  }
  return m;
};
const sumOf = (rs, f) => rs.reduce((s, o) => s + (isNum(o[f]) ? o[f] : 0), 0);
const countNum = (rs, f) => rs.filter((o) => isNum(o[f])).length;
const ratioOf = (rs, n, d) => {
  const both = rs.filter((o) => isNum(o[n]) && isNum(o[d]));
  return sumOf(both, n) / sumOf(both, d);
};

const REVENUE = { name: 'Revenue', table: 'Inventory', measure: { field: 'Selling price AOA', agg: 'sum' }, currency: 'AOA', format: '#,##0.00', description: 'Asking price of the stock, AOA' };
const preMetrics = b.to_json();

// 1. definition, JSON round trip, a workbook without metrics unchanged
{
  const ch = define(REVENUE);
  const json = b.to_json();
  const back = Book.from_json(json);
  const same = back.metrics() === b.metrics();
  back.free();
  const m = metrics()[0];
  check('1. a metric is a document operation saved with the workbook (JSON round trip, canonical form)',
    !ch.error && ch.metrics?.length === 1 && same && json.includes('"metrics":[{"name":"Revenue"') && m.measure.name === '' && m.currency === 'AOA' && !preMetrics.includes('"metrics"') && !start.includes('"metrics"'),
    JSON.stringify({ error: ch.error, n: ch.metrics?.length, same, saved: json.includes('"metrics":[{"name":"Revenue"'), m }));
}

// 2. the metric answers as the reference arithmetic
const byBranch = groupBy(data, 'Branch');
{
  const a = analyze({ dims: ['Branch'], measures: [{ metric: 'Revenue' }] });
  const ok = !a.error && a.table === 'Inventory' && a.groups.length === byBranch.size && a.groups.every((g) => close(g.values[0].value, sumOf(byBranch.get(String(g.key[0].s).toLowerCase()), 'Selling price AOA'))) && close(a.total[0].value, sumOf(data, 'Selling price AOA')) && a.reconciliation[0].status === 'ok';
  check('2. analyze by metric name (table taken from the metric) equals the reference total and every branch', ok, a.error ?? JSON.stringify(a.total?.[0]));
}

// 3. a reference equals the definition given inline
{
  const ref = analyze({ table: 'Inventory', dims: ['Model'], measures: [{ metric: 'revenue' }] });
  const inl = analyze({ table: 'Inventory', dims: ['Model'], measures: [{ field: 'Selling price AOA', agg: 'sum', name: 'Revenue' }] });
  const m = ref.measures[0];
  check('3. a metric reference gives exactly the inline definition\'s groups and totals, and carries the definition (format, currency, description)',
    JSON.stringify(ref.groups) === JSON.stringify(inl.groups.map((g) => ({ ...g, values: g.values.map((v) => ({ ...v, currency: 'AOA' })) }))) && close(ref.total[0].value, inl.total[0].value) && m.metric === 'Revenue' && m.format === '#,##0.00' && m.currency === 'AOA' && m.description.startsWith('Asking'),
    JSON.stringify(m));
}

// 4. non-additive metrics are computed from their parts
{
  define({ name: 'Cost to price', table: 'Inventory', measure: { agg: 'ratio', numerator: 'Landed cost AOA', denominator: 'Selling price AOA' }, format: '0.0%' });
  define({ name: 'Average age', table: 'Inventory', measure: { agg: 'average', field: 'Age (days)' } });
  const a = analyze({ dims: ['Branch'], measures: [{ metric: 'Cost to price' }, { metric: 'Average age' }] });
  const ok = !a.error && close(a.total[0].value, ratioOf(data, 'Landed cost AOA', 'Selling price AOA')) && close(a.total[1].value, sumOf(data, 'Age (days)') / countNum(data, 'Age (days)')) && !a.measures[0].additive && !a.measures[1].additive && a.reconciliation.length === 0 && a.groups.every((g) => close(g.values[0].value, ratioOf(byBranch.get(String(g.key[0].s).toLowerCase()), 'Landed cost AOA', 'Selling price AOA')));
  check('4. ratio and average metrics are Σ/Σ and Σ/n per group, marked non-additive and never reconciled', ok, a.error ?? JSON.stringify(a.total));
}

// 5. a redefinition reaches a bound chart without a chart operation
{
  apply({ type: 'add_chart', chart: { id: 0, kind: 'bar', title: 'Revenue by branch', analytic: { table: 'Inventory', dims: ['Branch'], measures: [{ metric: 'Revenue' }] } } });
  const chartsBefore = b.charts();
  const chart = JSON.parse(chartsBefore)[0];
  const q = () => analyze({ table: chart.analytic.table, dims: chart.analytic.dims, measures: chart.analytic.measures });
  const before = q().total[0].value;
  define({ ...REVENUE, measure: { field: 'Selling price AOA', agg: 'average' } });
  const after = q();
  check('5. redefining the metric (sum → average) changes the bound chart\'s numbers; the chart itself is untouched',
    close(before, sumOf(data, 'Selling price AOA')) && close(after.total[0].value, sumOf(data, 'Selling price AOA') / data.length) && after.measures[0].agg === 'average' && b.charts() === chartsBefore,
    `${before} → ${after.total[0].value}`);
  undo(); // back to the sum
}

// 6. rename follows chart references; undo restores both
{
  const ch = apply({ type: 'rename_metric', name: 'Revenue', to: 'Asking price' });
  const ref = () => JSON.parse(b.charts())[0].analytic.measures[0].metric;
  const renamed = !ch.error && ref() === 'Asking price' && metrics().some((m) => m.name === 'Asking price') && !metrics().some((m) => m.name === 'Revenue');
  const u = undo();
  const back = ref() === 'Revenue' && metrics().some((m) => m.name === 'Revenue') && (u.ops ?? []).map((o) => o.type).join(',') === 'restore_metrics,restore_charts';
  redo();
  const again = ref() === 'Asking price';
  undo();
  check('6. renaming a metric rewrites the charts that refer to it; undo restores name and references (two relay ops), redo again', renamed && back && again, JSON.stringify({ renamed, back, again, ops: u.ops?.map((o) => o.type) }));
}

// 7. removing a metric in use fails loudly; undo brings it back
{
  apply({ type: 'set_metric', name: 'Revenue', metric: null });
  const a = analyze({ table: 'Inventory', dims: ['Branch'], measures: [{ metric: 'Revenue' }] });
  undo();
  const c = analyze({ table: 'Inventory', dims: ['Branch'], measures: [{ metric: 'Revenue' }] });
  check('7. a removed metric gives "no metric named" (never a number); undo restores it', a.error === 'no metric named "Revenue"' && close(c.total[0].value, sumOf(data, 'Selling price AOA')), a.error ?? 'no error');
}

// 8. a table rename follows into metrics and chart bindings; undo restores everything
{
  const id = b.table_id('Inventory');
  apply({ type: 'rename_table', table: id, name: 'Stock' });
  const followed = metrics().every((m) => m.table === 'Stock') && JSON.parse(b.charts())[0].analytic.table === 'Stock' && close(analyze({ measures: [{ metric: 'Revenue' }] }).total[0].value, sumOf(data, 'Selling price AOA'));
  const u = undo();
  const restored = metrics().every((m) => m.table === 'Inventory') && JSON.parse(b.charts())[0].analytic.table === 'Inventory' && b.table_id('Inventory') === id;
  const types = (u.ops ?? []).map((o) => o.type);
  check('8. a table rename follows into metrics and chart bindings; undo restores the table, the bindings and the metrics', followed && restored && types.includes('restore_metrics') && types.includes('restore_charts') && types.includes('restore_tables'), JSON.stringify({ followed, restored, types }));
}

// 9. reporting currency: a label without a currency column, currency_mismatch with one
{
  define({ name: 'Landed USD', table: 'Inventory', measure: { field: 'Landed cost', agg: 'sum', currency: 'Currency' }, currency: 'usd' });
  const a = analyze({ dims: ['Currency'], measures: [{ metric: 'Landed USD' }] });
  const byCur = groupBy(data, 'Currency');
  const g = (code) => a.groups.find((x) => x.key[0].s === code);
  const usd = g('USD').values[0];
  const eur = g('EUR').values[0];
  const total = a.total[0];
  const revenue = analyze({ measures: [{ metric: 'Revenue' }] }).total[0];
  const eurOnly = analyze({ measures: [{ metric: 'Landed USD' }], selections: [{ field: 'Currency', values: [{ s: 'EUR' }] }] });
  const ok = usd.status === 'incomplete' || usd.status === 'ok';
  check('9. a reporting currency labels the value (AOA); rows in another currency give currency_mismatch with the amount per currency; a mix stays mixed_currency',
    revenue.currency === 'AOA' && ok && usd.currency === 'USD' && close(usd.value, sumOf(byCur.get('usd'), 'Landed cost')) && eur.status === 'currency_mismatch' && eur.value === null && eur.by_currency.length === 1 && eur.by_currency[0].currency === 'EUR' && close(eur.by_currency[0].value, sumOf(byCur.get('eur'), 'Landed cost')) && total.status === 'mixed_currency' && eurOnly.total[0].status === 'currency_mismatch' && eurOnly.issues.some((i) => i.kind === 'currency_mismatch' && i.text.includes('reports in USD')),
    JSON.stringify({ usd, eur: eur.status, total: total.status }));
}

// 10. decomposition through a metric reconciles like the inline definition
{
  const splits = [{ path: [], field: 'Branch' }, { path: [{ field: 'Branch', key: { s: 'Luanda' } }], field: 'Manufacturer' }];
  const t1 = decompose({ measure: { metric: 'Revenue' }, splits });
  const t2 = decompose({ table: 'Inventory', measure: { field: 'Selling price AOA', agg: 'sum', name: 'Revenue' }, splits });
  const strip = (n) => ({ ...n, value: { ...n.value, currency: undefined }, split: n.split ? { ...n.split, children: n.split.children.map(strip) } : undefined });
  const checks = [];
  const walk = (n) => {
    if (n.split) {
      checks.push(n.split.check.status === 'ok' && n.split.check.rows_ok);
      n.split.children.forEach(walk);
    }
  };
  walk(t1.root);
  check('10. a decomposition tree by metric name equals the inline one, reconciles at every split and echoes the metric\'s format',
    !t1.error && JSON.stringify(strip(t1.root)) === JSON.stringify(strip(t2.root)) && checks.length === 2 && checks.every(Boolean) && close(t1.root.value.value, sumOf(data, 'Selling price AOA')) && t1.measure.format === '#,##0.00' && t1.measure.metric === 'Revenue',
    t1.error ?? JSON.stringify(checks));
}

// 11. records through a metric add up to the reference
{
  const sel = [{ field: 'Branch', values: [{ s: 'Huambo' }] }];
  const r = records({ measures: [{ metric: 'Revenue' }], selections: sel, fields: ['VIN', 'Selling price AOA'], limit: 10 });
  const ref = byBranch.get('huambo');
  check('11. the records behind a selection, through a metric, count and add up to the reference', !r.error && r.count === ref.length && close(r.total[0].value, sumOf(ref, 'Selling price AOA')) && r.measures[0].metric === 'Revenue' && r.records.length === 10, r.error ?? `${r.count} vs ${ref.length}`);
}

// 12. definition-time refusals, with exact messages
{
  const cases = [
    [{ name: '1st', table: 'Inventory', measure: { field: 'VIN', agg: 'count' } }, "a metric name starts with a letter and contains only letters, digits, spaces, '_', '.' or '-'"],
    [{ name: 'Bad field', table: 'Inventory', measure: { field: 'Colour' } }, 'field "Colour" is not a header of table "Inventory"'],
    [{ name: 'Bad table', table: 'Fleet', measure: { field: 'VIN' } }, 'no table named "Fleet"'],
    [{ name: 'Bad agg', table: 'Inventory', measure: { field: 'Age (days)', agg: 'median' } }, 'unknown aggregation "median" (sum, count, count_distinct, average, min, max, ratio)'],
    [{ name: 'Nested', table: 'Inventory', measure: { metric: 'Revenue' } }, 'a metric cannot refer to another metric'],
    [{ name: 'Bad code', table: 'Inventory', measure: { field: 'Landed cost' }, currency: 'euro' }, 'a reporting currency is a three-letter code such as EUR or AOA'],
    [{ name: 'A1', table: 'Inventory', measure: { field: 'Landed cost' } }, 'that looks like a cell reference'],
  ];
  const before = b.metrics();
  const got = cases.map(([m, want]) => [define(m).error, want]);
  const bad = got.filter(([g, w]) => g !== w);
  const rename = apply({ type: 'rename_metric', name: 'Revenue', to: 'average AGE' }).error;
  check('12. a bad definition is refused when defined, with the engine\'s exact reason, and nothing changes', !bad.length && b.metrics() === before && rename === 'a metric named "Average age" already exists', JSON.stringify(bad) + ' ' + rename);
}

// 13. drift in the data breaks a metric visibly
{
  const id = b.table_id('Inventory');
  const col = HEADERS.indexOf('Selling price AOA');
  apply({ type: 'set_cell', table: id, row: 0, col, input: 'List price AOA' });
  const a = analyze({ measures: [{ metric: 'Revenue' }] });
  undo();
  check('13. a renamed column breaks the metric with an explicit error naming it, and undo mends it', a.error === 'metric "Revenue": field "Selling price AOA" is not a header of table "Inventory"' && !analyze({ measures: [{ metric: 'Revenue' }] }).error, a.error ?? 'no error');
}

// 14. another replica that replays the log (relayed ops, undo as restore ops) ends identical
{
  const other = Book.from_json(start);
  let errors = 0;
  for (const op of log) if (JSON.parse(other.apply_remote(JSON.stringify(op))).error) errors++;
  const same = other.to_json() === b.to_json() && other.metrics() === b.metrics();
  const replay = Book.from_json(start);
  for (const op of log) replay.apply(JSON.stringify(op));
  const same2 = replay.to_json() === b.to_json();
  other.free();
  replay.free();
  check('14. a replica applying the same log remotely (and a history replay) ends with the same workbook and metrics, refusing exactly the ops refused here', same && same2 && errors === refused && refused > 0, JSON.stringify({ same, same2, errors, refused }));
}

// 15. remote metric ops are not undoable locally
{
  const other = Book.from_json(b.to_json());
  other.apply_remote(JSON.stringify({ type: 'set_metric', name: 'Units', metric: { name: 'Units', table: 'Inventory', measure: { agg: 'count' } } }));
  const ok = !other.can_undo() && JSON.parse(other.metrics()).some((m) => m.name === 'Units');
  other.free();
  check('15. a metric defined by another editor (relayed) is not on the local undo stack', ok);
}

// 16. reading leaves the workbook unchanged
{
  const pre = b.to_json();
  analyze({ dims: ['Branch'], measures: [{ metric: 'Revenue' }, { metric: 'Cost to price' }] });
  records({ measures: [{ metric: 'Revenue' }], limit: 5 });
  decompose({ measure: { metric: 'Revenue' }, splits: [{ path: [], field: 'Model' }] });
  check('16. queries through metrics leave the workbook unchanged', b.to_json() === pre);
}

// 17. latency: resolving a metric costs nothing measurable next to the query itself
{
  const time = (f, n = 5) => { f(); const s = performance.now(); for (let i = 0; i < n; i++) f(); return (performance.now() - s) / n; };
  const msRef = time(() => analyze({ dims: ['Model'], measures: [{ metric: 'Revenue' }, { metric: 'Cost to price' }] }));
  const msInline = time(() => analyze({ table: 'Inventory', dims: ['Model'], measures: [{ field: 'Selling price AOA' }, { agg: 'ratio', numerator: 'Landed cost AOA', denominator: 'Selling price AOA' }] }));
  const msDefine = time(() => define({ ...REVENUE }));
  console.log(`timings: by metric ${msRef.toFixed(1)} ms · inline ${msInline.toFixed(1)} ms · define ${msDefine.toFixed(2)} ms`);
  check('17. a query by metric on 10,000 rows takes under 150 ms (within 1.5× + 5 ms of inline); defining one under 20 ms', msRef < 150 && msRef < msInline * 1.5 + 5 && msDefine < 20, `${msRef.toFixed(1)} / ${msInline.toFixed(1)} / ${msDefine.toFixed(2)} ms`);
}

b.free();
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

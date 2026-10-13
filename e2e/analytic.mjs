#!/usr/bin/env node
// Analytical queries on the shipped engine (13 Oct 2026 assessment, phase 7.1): the synthetic
// 10,000-vehicle benchmark (e2e/fixtures/automotive.mjs) queried through Book.analyze and
// Book.analyze_records, every number checked against an independent JavaScript reference computed
// from the generator's own rows (not from the workbook). Covers the assessment's acceptance tests:
// control totals, decomposition that reconciles, drill-through that adds up, excluded populations,
// missing values and currencies that are not hidden, non-additive margins, duplicate identifiers,
// a workbook left unchanged, and latency budgets.
import { createRequire } from 'node:module';
import path from 'node:path';
import { rows as makeRows, table } from './fixtures/automotive.mjs';

const { Book } = createRequire(import.meta.url)(path.resolve(process.argv[2] || 'server/engine', 'gridwright_core.js'));
let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  ok ? passed++ : failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}
const close = (a, b) => a !== null && b !== null && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const num = (v) => (typeof v === 'number' ? v : null);

const data = makeRows();
const b = new Book('benchmark');
let t0 = performance.now();
b.apply(JSON.stringify({ type: 'add_table', name: 'Inventory', x: 0, y: 0, rows: data.length + 1, cols: 13, values: table(data) }));
const loadMs = performance.now() - t0;
const before = b.to_json();
const run = (q) => {
  const a = JSON.parse(b.analyze(JSON.stringify(q)));
  if (a.error) throw new Error(a.error);
  return a;
};

// ---- reference (independent arithmetic over the generator's rows)
const ref = { byBranch: new Map(), total: 0, missing: 0, invalid: 0 };
for (const o of data) {
  const v = o['Inventory value AOA'];
  const x = num(v);
  if (typeof v === 'string') ref.invalid++;
  else if (x === null) ref.missing++;
  const g = ref.byBranch.get(o.Branch) ?? { sum: 0, n: 0, rows: 0 };
  g.rows++;
  if (x !== null) { g.sum += x; g.n++; ref.total += x; }
  ref.byBranch.set(o.Branch, g);
}

// 1. import and control totals
const all = run({ table: 'Inventory', dims: ['Branch'], measures: [{ field: 'Inventory value AOA', agg: 'sum' }, { agg: 'count' }], key: ['VIN'] });
check('every data row is in the population (control count)', all.population.rows === data.length && all.population.blank === 0, JSON.stringify(all.population));
check('control total equals the reference', close(all.total[0].value, ref.total), `${all.total[0].value} vs ${ref.total}`);
check('each branch total equals the reference', all.groups.every((g) => close(g.values[0].value, ref.byBranch.get(g.label[0]).sum) && g.rows === ref.byBranch.get(g.label[0]).rows));
check('branches reconcile to the total (decomposition adds up)', all.reconciliation.every((r) => r.status === 'ok') && all.reconciliation.length === 2, JSON.stringify(all.reconciliation));
check('blank landed costs are reported, not counted as 0', all.total[0].status === 'incomplete' && ref.missing === 40 && all.total[0].missing === ref.missing && all.issues.some((i) => i.kind === 'missing_values' && i.count === ref.missing), JSON.stringify(all.total[0]));
check('text where an amount is expected is reported', ref.invalid === 5 && all.total[0].invalid === ref.invalid && all.issues.some((i) => i.kind === 'invalid_values' && i.count === ref.invalid));
const dup = all.issues.filter((i) => i.kind === 'duplicate_key');
check('the 25 VINs exported twice are reported with their rows', dup.length === 25 && dup.every((d) => d.count === 2 && d.rows.length === 2), `${dup.length} duplicate issues`);

// 2. drill-down: manufacturer → model inside a branch keeps the context and still reconciles
const lu = run({ table: 'Inventory', dims: ['Manufacturer', 'Model'], measures: [{ field: 'Inventory value AOA' }], selections: [{ field: 'Branch', values: [{ s: 'Luanda' }] }] });
check('drilling into Luanda keeps the branch context (total = Luanda)', close(lu.total[0].value, ref.byBranch.get('Luanda').sum));
check('Luanda by manufacturer and model reconciles', lu.reconciliation[0].status === 'ok');
check('the rest of the inventory is visible as excluded', close(lu.excluded.values[0].value, ref.total - ref.byBranch.get('Luanda').sum) && lu.excluded.by_selection === data.length - ref.byBranch.get('Luanda').rows);

// 3. drill-through: the records behind one mark add up to it
const mark = lu.groups.find((g) => g.label[0] === 'Toyota' && g.label[1] === 'Hilux');
const recs = JSON.parse(b.analyze_records(JSON.stringify({ table: 'Inventory', measures: [{ field: 'Inventory value AOA' }], selections: [{ field: 'Branch', values: [{ s: 'Luanda' }] }, { field: 'Manufacturer', values: mark.key.slice(0, 1) }, { field: 'Model', values: mark.key.slice(1, 2) }], fields: ['VIN', 'Inventory value AOA'] })));
const recSum = recs.records.reduce((s, r) => s + (r.values[1]?.n ?? 0), 0);
const refHilux = data.filter((o) => o.Branch === 'Luanda' && o.Model === 'Hilux');
check('drill-through lists exactly the vehicles behind the mark', recs.count === mark.rows && recs.count === refHilux.length && !recs.truncated);
check('drill-through records add up to the displayed number', close(recSum, mark.values[0].value) && close(recs.total[0].value, mark.values[0].value), `${recSum} vs ${mark.values[0].value}`);
const withMembers = run({ table: 'Inventory', dims: ['Branch'], measures: [{ agg: 'count' }], members: true });
check('group membership partitions the rows (no row twice, none lost)', new Set(withMembers.groups.flatMap((g) => g.members)).size === data.length && withMembers.groups.reduce((s, g) => s + g.members.length, 0) === data.length);

// 4. excluded populations: leaving out reserved vehicles must not hide their value
const avail = run({ table: 'Inventory', dims: [], measures: [{ field: 'Inventory value AOA' }, { field: 'Age (days)', agg: 'average' }], selections: [{ field: 'Reserved', values: [{ s: 'No' }] }] });
const resv = data.filter((o) => o.Reserved === 'Yes');
const refResv = resv.reduce((s, o) => s + (num(o['Inventory value AOA']) ?? 0), 0);
const refResvAge = resv.reduce((s, o) => s + o['Age (days)'], 0) / resv.length;
check('excluded reserved vehicles keep their count and value', avail.excluded.by_selection === resv.length && close(avail.excluded.values[0].value, refResv));
check('their ageing is shown, and it is worse than the shown stock', close(avail.excluded.values[1].value, refResvAge) && avail.excluded.values[1].value > avail.total[1].value, `${avail.excluded.values[1].value} vs ${avail.total[1].value}`);

// 5. currencies: source-currency landed costs are not added together
const cur = run({ table: 'Inventory', dims: ['Currency'], measures: [{ field: 'Landed cost', currency: 'Currency' }] });
check('a total over USD, EUR and AOA is refused, with the amount per currency', cur.total[0].value === null && cur.total[0].status === 'mixed_currency' && cur.total[0].by_currency.map((c) => c.currency).join() === 'AOA,EUR,USD');
check('each single-currency group has its number and code', cur.groups.every((g) => g.values[0].value !== null && g.values[0].currency === g.label[0]));
check('the issue says to convert first', cur.issues.some((i) => i.kind === 'mixed_currency'));

// 6. non-additive: margin = Σ(price − cost) / Σ price, not the average of row margins
const marg = data.filter((o) => typeof o['Landed cost AOA'] === 'number');
const sumP = marg.reduce((s, o) => s + o['Selling price AOA'], 0);
const sumC = marg.reduce((s, o) => s + o['Landed cost AOA'], 0);
const rowAvg = marg.reduce((s, o) => s + (1 - o['Landed cost AOA'] / o['Selling price AOA']), 0) / marg.length;
const cr = run({ table: 'Inventory', dims: [], measures: [{ agg: 'ratio', numerator: 'Landed cost AOA', denominator: 'Selling price AOA', name: 'Cost ratio' }] });
check('cost ratio is Σ cost / Σ price over rows with both', close(cr.total[0].value, sumC / sumP), `${cr.total[0].value} vs ${sumC / sumP}`);
check('…which differs from the average of row ratios (the trap is real)', Math.abs((1 - sumC / sumP) - rowAvg) > 1e-4, `${1 - sumC / sumP} vs ${rowAvg}`);
check('a ratio is marked non-additive and is not reconciled', cr.measures[0].additive === false && cr.reconciliation.length === 0);

// 7. selections never change the workbook
check('queries leave the workbook unchanged (no filter op, no recalculation)', b.to_json() === before);

// 8. latency budgets (release wasm; CI runners are slower than a laptop, so the budgets are loose)
const time = (f, n = 5) => { f(); const s = performance.now(); for (let i = 0; i < n; i++) f(); return (performance.now() - s) / n; };
const msBranch = time(() => run({ table: 'Inventory', dims: ['Branch'], measures: [{ field: 'Inventory value AOA' }, { agg: 'count' }, { agg: 'ratio', numerator: 'Landed cost AOA', denominator: 'Selling price AOA' }], selections: [{ field: 'Reserved', values: [{ s: 'No' }] }] }));
const msModel = time(() => run({ table: 'Inventory', dims: ['Manufacturer', 'Model', 'Branch'], measures: [{ field: 'Inventory value AOA' }], members: true }));
const msRecords = time(() => b.analyze_records(JSON.stringify({ table: 'Inventory', measures: [{ field: 'Inventory value AOA' }], selections: [{ field: 'Branch', values: [{ s: 'Huambo' }] }], limit: 500 })));
console.log(`timings: load ${loadMs.toFixed(0)} ms · by branch ${msBranch.toFixed(1)} ms · 3 dims + members ${msModel.toFixed(1)} ms · records ${msRecords.toFixed(1)} ms`);
check('a cross-filtered chart query on 10,000 rows takes under 150 ms', msBranch < 150, `${msBranch.toFixed(1)} ms`);
check('a three-level breakdown with membership takes under 300 ms', msModel < 300, `${msModel.toFixed(1)} ms`);
check('a drill-through answer takes under 150 ms', msRecords < 150, `${msRecords.toFixed(1)} ms`);

b.free();
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

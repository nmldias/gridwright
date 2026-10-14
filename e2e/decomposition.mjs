#!/usr/bin/env node
// Decomposition tree on the shipped engine (13 Oct 2026 assessment, phase 7.4): the synthetic
// 10,000-vehicle benchmark (e2e/fixtures/automotive.mjs) broken down through Book.decompose, every
// number checked against an independent JavaScript reference computed from the generator's own
// rows (not from the workbook). Covers: the root equals the analytical total, every node of a
// three-level tree equals the reference and reconciles (sum, rows, numerators and denominators,
// per currency), siblings by value with ties broken by key, top N + "Other (k)" recomputed from its
// own rows, "(blank)" last and never folded, node selections that list exactly the node's records,
// unresolved paths, pinned nodes, independence from row order, the suggested split against the
// reference argmax, a workbook left unchanged, and latency budgets.
import { createRequire } from 'node:module';
import path from 'node:path';
import { HEADERS, rows as makeRows, table } from './fixtures/automotive.mjs';

const { Book } = createRequire(import.meta.url)(path.resolve(process.argv[2] || 'server/engine', 'gridwright_core.js'));
let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  ok ? passed++ : failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}
const close = (a, b) => a !== null && b !== null && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const num = (v) => (typeof v === 'number' ? v : null);
/** 15 significant digits: the engine's ordering and equality standard (Excel keeps 15 digits). */
const r15 = (x) => (x === null ? null : Number(x.toPrecision(15)));

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- data: four tables built from the same generator rows
const data = makeRows(10000);
const dataB = data.map((o, i) => (i % 333 === 5 ? { ...o, Model: '' } : o));
const dataS = data.slice();
{
  const r = mulberry32(7);
  for (let i = dataS.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [dataS[i], dataS[j]] = [dataS[j], dataS[i]];
  }
}

const b = new Book('decomposition');
let t0 = performance.now();
const add = (name, rs, x) => b.apply(JSON.stringify({ type: 'add_table', name, x, y: 0, rows: rs.length + 1, cols: HEADERS.length, values: table(rs) }));
add('Inventory', data, 0);
const loadMs = performance.now() - t0;
add('InventoryB', dataB, 20);
add('InventoryS', dataS, 40);
const before = () => b.to_json();

const dec = (q) => {
  const a = JSON.parse(b.decompose(JSON.stringify(q)));
  if (a.error) throw new Error(a.error);
  return a;
};
const analyze = (q) => {
  const a = JSON.parse(b.analyze(JSON.stringify(q)));
  if (a.error) throw new Error(a.error);
  return a;
};

// ---- reference (independent arithmetic over the generator's rows)
const blankish = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
/** canonical key of a generator value: text case-insensitive, blank = whitespace or nothing */
const refKey = (v) => (blankish(v) ? 'blank' : typeof v === 'number' ? `n:${v}` : `s:${String(v).trim().toLowerCase()}`);
/** canonical key of an engine value ({"s":..}, {"n":..}, null) */
const engKey = (v) => (v === null || v === undefined ? 'blank' : 'n' in v ? `n:${v.n}` : 's' in v ? `s:${v.s.trim().toLowerCase()}` : JSON.stringify(v));

const SUM = { field: 'Inventory value AOA' };
const RATIO = { agg: 'ratio', numerator: 'Landed cost AOA', denominator: 'Selling price AOA' };
const AVERAGE = { field: 'Inventory value AOA', agg: 'average' };

/** reference value of a measure over a set of generator rows */
function refAgg(rs, m) {
  const out = { rows: rs.length, n: 0, missing: 0, invalid: 0, sum: 0, num: 0, den: 0, value: null };
  if (m.agg === 'ratio') {
    for (const o of rs) {
      const a = num(o[m.numerator]), d = num(o[m.denominator]);
      if (a !== null && d !== null) { out.num += a; out.den += d; out.n++; }
    }
    out.value = out.den === 0 ? null : out.num / out.den;
    return out;
  }
  for (const o of rs) {
    const v = o[m.field];
    if (typeof v === 'number') { out.n++; out.sum += v; } else if (blankish(v)) out.missing++; else out.invalid++;
  }
  if (out.n) out.value = m.agg === 'average' ? out.sum / out.n : out.sum;
  return out;
}

/** reference rows of each child of a split: value and blank by key, Other by its folded keys */
function childRows(parentRows, field, child) {
  if (child.kind === 'other') {
    const keys = new Set(child.folded.map(engKey));
    return parentRows.filter((o) => keys.has(refKey(o[field])));
  }
  const k = engKey(child.key);
  return parentRows.filter((o) => refKey(o[field]) === k);
}

/** every node with its reference rows, depth first */
function walk(node, rs, out = []) {
  out.push({ node, rs });
  if (node.split) for (const c of node.split.children) walk(c, childRows(rs, node.split.field, c), out);
  return out;
}
const splitsOf = (all) => all.filter((x) => x.node.split);

/** reference ranking of one split: groups by key, value descending, then label */
function refRank(rs, field, m) {
  const g = new Map();
  for (const o of rs) {
    const k = refKey(o[field]);
    if (k === 'blank') continue;
    if (!g.has(k)) g.set(k, { label: String(o[field]), rows: [] });
    g.get(k).rows.push(o);
  }
  const items = [...g.values()].map((x) => ({ ...x, agg: refAgg(x.rows, m) }));
  items.sort((a, b) => (r15(b.agg.value) - r15(a.agg.value)) || a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
  return items;
}

// a request that splits every node of Branch → Manufacturer → Model
const BRANCHES = [...new Set(data.map((o) => o.Branch))];
const pairs = [...new Set(data.map((o) => `${o.Branch}\u0001${o.Manufacturer}`))].map((s) => s.split('\u0001'));
const threeLevels = [
  { path: [], field: 'Branch' },
  ...BRANCHES.map((br) => ({ path: [{ field: 'Branch', key: { s: br } }], field: 'Manufacturer' })),
  ...pairs.map(([br, mk]) => ({ path: [{ field: 'Branch', key: { s: br } }, { field: 'Manufacturer', key: { s: mk } }], field: 'Model' })),
];

// InventoryT: two appended rows that make the two largest models exactly equal
const [A, B] = refRank(data, 'Model', SUM);
const cents = (x) => Math.round(x * 100);
const target = Math.ceil(A.agg.sum / 1e6) * 1e6 + 1e6;
const dataT = [...data,
  { ...A.rows[0], VIN: 'VIN-T00001', Model: A.label, 'Inventory value AOA': (cents(target) - cents(A.agg.sum)) / 100 },
  { ...B.rows[0], VIN: 'VIN-T00002', Model: B.label, 'Inventory value AOA': (cents(target) - cents(B.agg.sum)) / 100 }];
add('InventoryT', dataT, 60);

const pre = before();

// 1. root == analyze total == reference
{
  const t = dec({ table: 'Inventory', measure: SUM, key: ['VIN'] });
  const a = analyze({ table: 'Inventory', dims: [], measures: [SUM], key: ['VIN'] });
  const ref = refAgg(data, SUM);
  const v = t.root.value;
  check('1. the root is the analytical total and the reference total (rows, missing, invalid, population, issues)',
    close(v.value, a.total[0].value) && close(v.value, ref.sum) && v.n === ref.n && v.missing === 40 && ref.missing === 40 && v.invalid === 5 && ref.invalid === 5 &&
    t.root.rows === data.length && JSON.stringify(t.population) === JSON.stringify(a.population) && JSON.stringify(t.issues) === JSON.stringify(a.issues) && t.root.id === 'r' && t.root.kind === 'root',
    `${v.value} vs analyze ${a.total[0].value} vs ref ${ref.sum}; ${JSON.stringify(t.population)}`);
}

// 2. Branch → Manufacturer → Model, every node split: every node == the reference
const tree3 = dec({ table: 'Inventory', measure: SUM, key: ['VIN'], splits: threeLevels });
const all3 = walk(tree3.root, data);
{
  const bad = all3.filter(({ node, rs }) => {
    const r = refAgg(rs, SUM);
    return node.rows !== r.rows || !close(node.value.value, r.value) || node.value.n !== r.n || node.value.missing !== r.missing || node.value.invalid !== r.invalid;
  });
  const leafRows = all3.filter((x) => x.node.path.length === 3).reduce((s, x) => s + x.node.rows, 0);
  check('2. three-level tree: every node\'s value, rows, n, missing and invalid equal the reference',
    bad.length === 0 && all3.length > 100 && leafRows === data.length && splitsOf(all3).length === threeLevels.length && tree3.unresolved.length === 0,
    `${bad.length} of ${all3.length} differ, e.g. ${bad[0]?.node.id}; ${splitsOf(all3).length} splits of ${threeLevels.length}`);
}

// 3. every check ok with rows_ok, including Other and blank (also a tree with Other and blank)
const treeOB = dec({
  table: 'InventoryB', measure: SUM, top_n: 3,
  splits: [{ path: [], field: 'Model' }, { path: [{ field: 'Model', other: true }], field: 'Manufacturer' }, { path: [{ field: 'Model', key: null }], field: 'Branch' }],
});
const allOB = walk(treeOB.root, dataB);
{
  const splits = [...splitsOf(all3), ...splitsOf(allOB)];
  const notOk = splits.filter(({ node }) => node.split.check.kind !== 'sum' || node.split.check.status !== 'ok' || !node.split.check.rows_ok || node.split.check.text !== 'children add up to the parent');
  // the figures, not only the status: parent == the reference sum of the node's rows, and
  // sum_of_children == the reference sums of each child's rows added up
  const figuresBad = splits.filter(({ node, rs }) => {
    const c = node.split.check;
    const kidsRef = node.split.children.reduce((s, ch) => s + (refAgg(childRows(rs, node.split.field, ch), SUM).value ?? 0), 0);
    return !close(c.parent, refAgg(rs, SUM).value) || !close(c.sum_of_children, kidsRef);
  });
  const kinds = new Set(allOB.map((x) => x.node.kind));
  const refOk = allOB.every(({ node, rs }) => node.rows === rs.length && close(node.value.value, refAgg(rs, SUM).value));
  check('3. every split reconciles (sum ok with parent and children equal to the reference, rows partition), including Other and (blank) splits',
    notOk.length === 0 && figuresBad.length === 0 && kinds.has('other') && kinds.has('blank') && refOk && allOB.find((x) => x.node.kind === 'other').node.split && allOB.find((x) => x.node.kind === 'blank').node.split,
    `${notOk.length} not ok: ${JSON.stringify(notOk[0]?.node.split.check)}; ${figuresBad.length} with other figures (${figuresBad[0]?.node.id}); kinds ${[...kinds]}`);
}

// 4. siblings value-descending; an injected tie is broken by key
{
  const orderBad = splitsOf([...all3, ...allOB]).filter(({ node }) => {
    const named = node.split.children.filter((c) => c.kind === 'value');
    return named.some((c, i) => i > 0 && (r15(c.value.value) > r15(named[i - 1].value.value) || c.rank <= named[i - 1].rank));
  });
  const tt = dec({ table: 'InventoryT', measure: SUM, splits: [{ path: [], field: 'Model' }] });
  const [c1, c2] = tt.root.split.children;
  const byName = [A.label, B.label].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
  check('4. siblings are ordered by value (descending) and a 15-digit tie is broken by key',
    orderBad.length === 0 && r15(c1.value.value) === r15(c2.value.value) && r15(c1.value.value) === target && c1.label === byName[0] && c2.label === byName[1] && c1.rank === 1 && c2.rank === 2,
    `${orderBad.length} splits out of order; tie ${c1.label} ${c1.value.value} / ${c2.label} ${c2.value.value} (expected ${byName.join(', ')} at ${target})`);
}

// 5. top_n=3 on Model: 3 named + Other (12) == the reference Σ of the 12 folded
{
  const t = dec({ table: 'Inventory', measure: SUM, top_n: 3, splits: [{ path: [], field: 'Model' }] });
  const ch = t.root.split.children;
  const ref = refRank(data, 'Model', SUM);
  const foldedRef = ref.slice(3);
  const other = ch.find((c) => c.kind === 'other');
  const refOther = refAgg(foldedRef.flatMap((x) => x.rows), SUM);
  check('5. top 3 of Model: three named items and "Other (12)" equal to the reference sum of the 12 folded',
    ch.length === 4 && ch.slice(0, 3).every((c, i) => c.kind === 'value' && c.label === ref[i].label && close(c.value.value, ref[i].agg.value)) &&
    other && other.k === 12 && other.label === 'Other (12)' && other.folded.map(engKey).join() === foldedRef.map((x) => refKey(x.label)).join() &&
    close(other.value.value, refOther.value) && other.rows === refOther.rows && t.root.split.items === 15,
    `${ch.map((c) => c.label).join(', ')}; other ${other?.value.value} vs ${refOther.value}`);
}

// 6. top_n=15 on Model: no Other
{
  const t = dec({ table: 'Inventory', measure: SUM, top_n: 15, splits: [{ path: [], field: 'Model' }] });
  const ch = t.root.split.children;
  check('6. top 15 of the 15 models: every model named, no Other', ch.length === 15 && ch.every((c) => c.kind === 'value') && ch.map((c) => c.rank).join() === Array.from({ length: 15 }, (_, i) => i + 1).join(),
    ch.map((c) => c.label).join(', '));
}

// 7. InventoryB: (blank) present, last, never folded at top_n=1, and equal to the reference
{
  const t = dec({ table: 'InventoryB', measure: SUM, top_n: 1, splits: [{ path: [], field: 'Model' }] });
  const ch = t.root.split.children;
  const last = ch[ch.length - 1];
  const refBlank = refAgg(dataB.filter((o) => blankish(o.Model)), SUM);
  const other = ch.find((c) => c.kind === 'other');
  check('7. (blank) is shown last, outside Other even at top 1, with the reference rows and value',
    last.kind === 'blank' && last.label === '(blank)' && last.key === null && last.id === 'r/model=blank' && ch.filter((c) => c.kind === 'blank').length === 1 &&
    refBlank.rows === dataB.filter((_, i) => i % 333 === 5).length && last.rows === refBlank.rows && close(last.value.value, refBlank.value) &&
    other && other.k === 14 && other.folded.every((v) => v !== null) && ch.length === 3 && t.root.split.check.status === 'ok',
    `${ch.map((c) => `${c.label}:${c.rows}`).join(', ')}; ref blank ${refBlank.rows}`);
}

// 8. ratio: every node == Σ/Σ, children do not sum, parts reconcile, no shares, the trap is real
{
  const t = dec({ table: 'Inventory', measure: RATIO, top_n: 3, splits: [{ path: [], field: 'Model' }, { path: [{ field: 'Model', other: true }], field: 'Branch' }] });
  const all = walk(t.root, data);
  const bad = all.filter(({ node, rs }) => {
    const r = refAgg(rs, RATIO);
    return !close(node.value.value, r.value) || !node.parts || !close(node.parts.numerator, r.num) || !close(node.parts.denominator, r.den) || 'share' in node;
  });
  const checks = splitsOf(all).map((x) => x.node.split.check);
  const kids = t.root.split.children;
  const meanOfChildren = kids.reduce((s, c) => s + c.value.value, 0) / kids.length;
  check('8. ratio: every node is Σ cost / Σ price over its rows, "children do not sum to parent (ratio)", parts add up, no shares',
    bad.length === 0 && checks.length === 2 && checks.every((c) => c.kind === 'children_do_not_sum' && c.status === 'recomputed' && c.text === 'children do not sum to parent (ratio)' && c.parts_ok === true && c.rows_ok) &&
    t.measure.additive === false && Math.abs(meanOfChildren - t.root.value.value) > 1e-6,
    `${bad.length} nodes differ (${bad[0]?.node.id}); ${JSON.stringify(checks[0])}; mean of children ${meanOfChildren} vs ${t.root.value.value}`);
}

// 9. average: every node == Σ/n; Other recomputed from its rows
{
  const t = dec({ table: 'Inventory', measure: AVERAGE, top_n: 3, splits: [{ path: [], field: 'Model' }] });
  const all = walk(t.root, data);
  const bad = all.filter(({ node, rs }) => {
    const r = refAgg(rs, AVERAGE);
    return !close(node.value.value, r.value) || !close(node.parts.numerator, r.sum) || node.parts.denominator !== r.n;
  });
  const other = t.root.split.children.find((c) => c.kind === 'other');
  const foldedAvgs = refRank(data, 'Model', AVERAGE).filter((x) => other.folded.map(engKey).includes(refKey(x.label))).map((x) => x.agg.value);
  const meanOfAverages = foldedAvgs.reduce((s, v) => s + v, 0) / foldedAvgs.length;
  check('9. average: every node is Σ / n, and Other is recomputed from its rows (not an average of averages)',
    bad.length === 0 && other.k === 12 && foldedAvgs.length === 12 && Math.abs(meanOfAverages - other.value.value) > 1e-6 && t.root.split.check.text === 'children do not sum to parent (average)' && t.root.split.check.parts_ok === true,
    `${bad.length} nodes differ (${bad[0]?.node.id}); other ${other?.value.value} vs mean of averages ${meanOfAverages}`);
}

// 10. missing (40) and invalid (5) counts sum over the children
{
  const bad = splitsOf([...all3, ...allOB]).filter(({ node }) => {
    const ch = node.split.children;
    return ch.reduce((s, c) => s + c.value.missing, 0) !== node.value.missing || ch.reduce((s, c) => s + c.value.invalid, 0) !== node.value.invalid;
  });
  const lvl1 = tree3.root.split.children;
  check('10. blank (40) and text (5) amounts are counted per node and add up over the children',
    bad.length === 0 && tree3.root.value.missing === 40 && tree3.root.value.invalid === 5 && lvl1.reduce((s, c) => s + c.value.missing, 0) === 40 && lvl1.every((c) => c.value.status === (c.value.missing || c.value.invalid ? 'incomplete' : 'ok')),
    `${bad.length} splits do not add up`);
}

// 11. mixed currencies: the root has no single value, children sorted by key, per-currency checks ok
{
  const M = { field: 'Landed cost', currency: 'Currency' };
  const t = dec({ table: 'Inventory', measure: M, splits: [{ path: [], field: 'Branch' }, { path: [{ field: 'Branch', key: { s: 'Huambo' } }], field: 'Currency' }] });
  const perCur = (rs) => {
    const m = new Map();
    for (const o of rs) if (typeof o['Landed cost'] === 'number') m.set(o.Currency, (m.get(o.Currency) ?? 0) + o['Landed cost']);
    return m;
  };
  const sp = t.root.split;
  const refRoot = perCur(data);
  const keyOrder = [...BRANCHES].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
  const childOk = walk(t.root, data).every(({ node, rs }) => {
    const ref = perCur(rs);
    if (node.value.status === 'mixed_currency') return node.value.value === null && node.value.by_currency.length === ref.size && node.value.by_currency.every((c) => close(c.value, ref.get(c.currency)));
    return ref.size === 1 && node.value.currency === [...ref.keys()][0] && close(node.value.value, [...ref.values()][0]);
  });
  const hu = sp.children.find((c) => c.label === 'Huambo');
  check('11. mixed currencies: the root has no single amount, siblings are sorted by key, and each currency reconciles',
    t.root.value.status === 'mixed_currency' && t.root.value.value === null && sp.sort === 'key' && sp.children.map((c) => c.label).join() === keyOrder.join() &&
    sp.check.status === 'ok' && sp.check.text === 'children add up to the parent in each currency' && sp.check.parent === null &&
    sp.check.by_currency.length === 3 && sp.check.by_currency.every((c) => c.status === 'ok' && close(c.parent, refRoot.get(c.currency)) && close(c.sum_of_children, refRoot.get(c.currency))) &&
    childOk && hu.split.sort === 'key' && hu.split.check.status === 'ok' && hu.split.children.every((c) => c.value.status !== 'mixed_currency' && c.share === undefined) && sp.children.every((c) => c.share === undefined),
    `${t.root.value.status}; sort ${sp.sort}; ${sp.children.map((c) => c.label).join()}; ${JSON.stringify(sp.check)}`);
}

// 12. records(node.selections) add up to the node, including Other and blank
{
  const pick = [
    allOB.find((x) => x.node.kind === 'other'),
    allOB.find((x) => x.node.kind === 'blank'),
    allOB.find((x) => x.node.path.length === 2 && x.node.path[0].other),
    allOB.find((x) => x.node.path.length === 2 && x.node.path[0].key === null),
    allOB.find((x) => x.node.kind === 'value' && x.node.path.length === 1),
  ];
  const bad = pick.filter((x) => {
    if (!x) return true;
    const r = JSON.parse(b.analyze_records(JSON.stringify({ table: 'InventoryB', measures: [SUM], selections: x.node.selections, fields: ['Inventory value AOA'], limit: 20000 })));
    const listed = r.records.reduce((s, rec) => s + (rec.values[0]?.n ?? 0), 0);
    // the records list stops at 5,000 (MAX_RECORDS); the count and total always cover every record
    const listedOk = r.count > 5000 ? r.truncated && r.records.length === 5000 : !r.truncated && close(listed, x.node.value.value);
    return r.error || r.count !== x.node.rows || !close(r.total[0].value, x.node.value.value) || !listedOk;
  });
  check('12. each node\'s selections list exactly its records (5 nodes, including Other and (blank))', bad.length === 0,
    `${bad.length} nodes differ: ${bad.map((x) => x?.node.id).join(', ')}`);
}

// 13. a selection that removes Luanda leaves Luanda's split unresolved, with its reason
{
  const t = dec({
    table: 'Inventory', measure: SUM,
    selections: [{ field: 'Branch', values: BRANCHES.filter((x) => x !== 'Luanda').map((s) => ({ s })) }],
    splits: [{ path: [], field: 'Branch' }, { path: [{ field: 'Branch', key: { s: 'Luanda' } }], field: 'Manufacturer' }, { path: [{ field: 'Branch', key: { s: 'Luanda' } }, { field: 'Manufacturer', key: { s: 'Kia' } }], field: 'Model' }],
  });
  const u = t.unresolved;
  check('13. a filtered-out node keeps its split as unresolved, with the reason (not an error)',
    u.length === 2 && u[0].field === 'Manufacturer' && u[0].reason === 'Luanda is no longer under Branch (filtered out or changed)' && u[1].reason === 'its parent is no longer in the tree' &&
    t.root.split.children.length === 4 && t.excluded.by_selection === data.filter((o) => o.Branch === 'Luanda').length,
    JSON.stringify(u));
}

// 14. a pinned node with rank > N stays named
{
  const ref = refRank(data, 'Model', SUM);
  const eighth = ref[7];
  const t = dec({ table: 'Inventory', measure: SUM, top_n: 3, splits: [{ path: [], field: 'Model' }, { path: [{ field: 'Model', key: { s: eighth.label } }], field: 'Branch' }] });
  const ch = t.root.split.children;
  const p = ch.find((c) => c.label === eighth.label);
  const other = ch.find((c) => c.kind === 'other');
  check('14. a node that an open split goes through stays named at rank 8 (pinned), and Other holds the other 11',
    p && p.pinned === true && p.rank === 8 && p.split && p.split.check.status === 'ok' && close(p.value.value, eighth.agg.value) &&
    ch.indexOf(p) === 3 && other.k === 11 && !other.folded.map(engKey).includes(refKey(eighth.label)) && ch.slice(0, 3).every((c) => !c.pinned) && t.root.split.check.status === 'ok',
    ch.map((c) => `${c.label}#${c.rank}${c.pinned ? '*' : ''}`).join(', '));
}

// 15. shuffled rows give the same ids, keys, values and suggestion
const SUGGEST_AT = [{ field: 'Branch', key: { s: 'Benguela' } }];
{
  const q = (table) => ({ table, measure: SUM, key: ['VIN'], top_n: 3, splits: threeLevels.slice(0, 6).concat([{ path: [{ field: 'Branch', key: { s: 'Luanda' } }, { field: 'Manufacturer', other: true }], field: 'Model' }]), suggest: { at: SUGGEST_AT } });
  const a = dec(q('Inventory'));
  const s = dec(q('InventoryS'));
  const sig = (t) => walk(t.root, []).map(({ node }) => [node.id, node.kind, JSON.stringify(node.key), r15(node.value.value), node.rows, node.rank, JSON.stringify(node.folded ?? [])].join('|')).join('\n');
  const sa = sig(a), ss = sig(s);
  check('15. shuffled rows give the same ids, kinds, keys, values, ranks and suggestion',
    sa === ss && sa.split('\n').length > 20 && a.suggestion.text === s.suggestion.text && a.suggestion.field === s.suggestion.field && a.unresolved.length === 0,
    `${sa.split('\n').find((l, i) => l !== ss.split('\n')[i])} vs ${ss.split('\n').find((l, i) => l !== sa.split('\n')[i])}`);
}

// 16. the suggestion's field and item == the reference argmax; the text names the rule
{
  const isNumberCell = (v) => typeof v === 'number' || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v));
  function refSuggest(rs, rule, skip) {
    const ranked = [];
    HEADERS.filter((h) => !skip.includes(h)).forEach((h, pos) => {
      const vals = rs.map((o) => o[h]).filter((v) => !blankish(v));
      if (vals.length && vals.every(isNumberCell)) return; // numbers: not an automatic candidate
      const items = refRank(rs, h, SUM);
      if (items.length > 100 || items.length < 2) return;
      const scored = items.filter((x) => x.agg.value !== null);
      if (scored.length < 2) return;
      const top = scored[0];
      const mean = scored.reduce((s, x) => s + Math.abs(x.agg.value), 0) / scored.length;
      ranked.push({ field: h, pos, items: items.length, node: top.label, value: top.agg.value, score: rule === 'relative' ? top.agg.value / mean : top.agg.value, mean });
    });
    ranked.sort((a, b) => (r15(b.score) - r15(a.score)) || (a.items - b.items) || (a.pos - b.pos));
    return ranked;
  }
  const rsAt = data.filter((o) => o.Branch === 'Benguela');
  const results = ['high_value', 'relative'].map((rule) => {
    const t = dec({ table: 'Inventory', measure: SUM, key: ['VIN'], splits: [{ path: [], field: 'Branch' }], suggest: { at: SUGGEST_AT, rule } });
    const s = t.suggestion;
    const ref = refSuggest(rsAt, rule, ['VIN', 'Branch', 'Inventory value AOA']);
    const [best, second] = ref;
    const ruleText = rule === 'relative' ? "largest ratio of an item to its siblings' mean" : 'highest value of a single item';
    const ok = s.rule === rule && s.rule_text === ruleText && s.node_id === 'r/branch=s:benguela' &&
      s.field === best.field && s.best.node === best.node && close(s.best.score, best.score) && close(s.best.value, best.value) &&
      s.runner_up.field === second.field && s.runner_up.node === second.node && close(s.runner_up.score, second.score) &&
      s.candidates.filter((c) => !c.skipped).map((c) => c.field).join() === ref.map((x) => x.field).join() &&
      s.text.startsWith(`Suggested split: ${best.field}. Rule: ${ruleText}.`) && s.text.includes(best.node) && s.text.includes(`runner-up ${second.field}: ${second.node}`) && s.text.endsWith('A heuristic, not a cause.') &&
      s.candidates.some((c) => c.skipped === 'numbers (amount or date): name it in fields to use it') && (rule !== 'relative' || close(s.best.mean, best.mean));
    return { ok, rule, got: `${s.field}/${s.best?.node} then ${s.runner_up?.field}/${s.runner_up?.node}`, want: `${best.field}/${best.node} then ${second.field}/${second.node}` };
  });
  check('16. the suggested split (high value and relative) is the reference argmax, and the text names the rule, item and runner-up',
    results.every((r) => r.ok), results.filter((r) => !r.ok).map((r) => `${r.rule}: ${r.got} vs ${r.want}`).join('; '));
}

// 17. the workbook is unchanged (no operation, no recalculation)
check('17. decomposing leaves the workbook unchanged', b.to_json() === pre);

// 18. latency budgets (release wasm; CI runners are slower than a laptop, so the budgets are loose)
const time = (f, n = 5) => { f(); const s = performance.now(); for (let i = 0; i < n; i++) f(); return (performance.now() - s) / n; };
const msSplit = time(() => dec({ table: 'Inventory', measure: SUM, key: ['VIN'], splits: [{ path: [], field: 'Model' }] }));
const msTree = time(() => dec({ table: 'Inventory', measure: SUM, key: ['VIN'], splits: threeLevels, suggest: { at: SUGGEST_AT } }));
console.log(`timings: load ${loadMs.toFixed(0)} ms · one split ${msSplit.toFixed(1)} ms · 3 levels (${threeLevels.length} splits) + suggestion ${msTree.toFixed(1)} ms`);
check('18. one split on 10,000 rows takes under 150 ms; the three-level tree plus a suggestion under 300 ms', msSplit < 150 && msTree < 300, `${msSplit.toFixed(1)} ms, ${msTree.toFixed(1)} ms`);

b.free();
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

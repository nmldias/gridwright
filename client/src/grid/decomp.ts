// Decomposition tree (roadmap 7.4): pure helpers over the viewer's tree state (store.decomp), exposed
// as window.__gw.decomp. The tree itself is one read-only engine call (Book.decompose); these build
// its query and edit which node is split by which field. Nothing here is an operation.

import * as book from '../engine/book';
import type { AnalyticSelection, Chart, DecompNode, DecompQuery, DecompSplit, DecompSplitSpec, DecompStep, DecompTree, KeyValue, MeasureSpec } from '../engine/types';
import { cellAt, getState, loadDecompPrefs, useStore, type Decomp } from '../state/store';
import { currentField, keyId, recordSelections } from './crossfilter';
import { formatNumber } from './format';
import { analyticFromTable, tableHeaders } from '../ui/review';
import { resolveSpec } from './metrics';

const lower = (s: string) => s.trim().toLowerCase();

/** One step's identity: field and canonical key (or Other). */
function stepId(s: DecompStep): string {
  return `${lower(s.field)}=${s.other ? 'other' : keyId(s.key ?? null)}`;
}
export function samePath(a: DecompStep[], b: DecompStep[]): boolean {
  return a.length === b.length && a.every((s, i) => stepId(s) === stepId(b[i]));
}
/** `p` starts with `prefix` (or is it). */
export function hasPrefix(p: DecompStep[], prefix: DecompStep[]): boolean {
  return p.length >= prefix.length && prefix.every((s, i) => stepId(s) === stepId(p[i]));
}
/** A step as the engine reads it (a value, (blank) as null, or Other). */
export function stepOf(n: DecompNode): DecompStep | null {
  const field = n.path[n.path.length - 1]?.field;
  if (!field) return null;
  if (n.kind === 'other') return { field, key: null, other: true };
  return { field, key: n.kind === 'blank' ? null : n.key, other: false };
}

/** A tree opened from an analytical chart: its measures, its current field as the first level. */
export function seedFromChart(chart: Chart): Decomp | null {
  const an = chart.analytic;
  if (!an || !an.table || !an.measures.length) return null;
  const prefs = loadDecompPrefs();
  const field = currentField(chart);
  return {
    table: an.table,
    measure: an.measures[0],
    measures: an.measures,
    fromChart: chart.id,
    base: [],
    topN: prefs.topN,
    splits: field ? [{ path: [], field }] : [],
    suggest: prefs.suggest,
    rule: prefs.rule,
    selected: 'r',
    selectedPath: [],
    collapsed: [],
    records: null,
  };
}

/** A tree over a table, with the same first guess as an analytical chart from that table. */
export function seedFromTable(name: string): Decomp | null {
  const id = [...getState().tables.values()].find((t) => lower(t.name) === lower(name))?.id;
  if (id === undefined) return null;
  const guess = analyticFromTable(id);
  if (!guess?.analytic) return null;
  const prefs = loadDecompPrefs();
  return {
    table: guess.analytic.table,
    measure: guess.analytic.measures[0],
    measures: guess.analytic.measures,
    fromChart: null,
    base: [],
    topN: prefs.topN,
    splits: [{ path: [], field: guess.analytic.dims[0] }],
    suggest: prefs.suggest,
    rule: prefs.rule,
    selected: 'r',
    selectedPath: [],
    collapsed: [],
    records: null,
  };
}

export function chartOf(d: Decomp): Chart | null {
  return d.fromChart === null ? null : (getState().charts.find((c) => c.id === d.fromChart && c.analytic) ?? null);
}

/** The starting filter: the chart's own filters (recomputed live), or the stored one. */
export function baseOf(d: Decomp): AnalyticSelection[] {
  const chart = chartOf(d);
  return chart ? recordSelections(chart, true) : d.base;
}

/** The table's headers, the chart's dimensions first. */
export function fieldsOf(d: Decomp): string[] {
  const id = book.tableIdByName(d.table);
  const heads = id ? tableHeaders(id).filter(Boolean) : [];
  const dims = (chartOf(d)?.analytic?.dims ?? []).filter((f) => heads.some((h) => lower(h) === lower(f)));
  return [...new Set([...dims, ...heads.filter((h) => !dims.some((f) => lower(f) === lower(h)))])];
}

let numericCache: { key: string; set: Set<string> } | null = null;
/** Columns whose first values are mostly numbers (amounts, dates): not useful to split by by default.
 * Scanned once per table and workbook change, not on every query. */
function numericColumns(table: string): Set<string> {
  const key = `${lower(table)}\u0001${getState().cellsVersion}`;
  if (numericCache?.key === key) return numericCache.set;
  const out = new Set<string>();
  numericCache = { key, set: out };
  const id = book.tableIdByName(table);
  const meta = id ? getState().tables.get(id) : undefined;
  if (!id || !meta) return out;
  const heads = tableHeaders(id);
  const last = Math.min(meta.rows - 1, meta.header_rows + 400);
  heads.forEach((h, c) => {
    if (!h) return;
    let nums = 0;
    let texts = 0;
    for (let r = meta.header_rows; r <= last; r++) {
      const v = cellAt(id, r, c)?.v;
      if (!v) continue;
      if ('n' in v) nums++;
      else texts++;
    }
    if (nums > texts) out.add(lower(h));
  });
  return out;
}

function measureFields(spec: MeasureSpec): string[] {
  const m = resolveSpec(spec).spec;
  return [m.field, m.numerator, m.denominator].filter((f): f is string => !!f);
}

/** Suggestion candidates: from a chart, its dimensions first, then the other text columns in column
 * order; otherwise automatic (the engine's own column order and filters). */
function candidates(d: Decomp, path: DecompStep[]): string[] {
  const chart = chartOf(d);
  if (!chart) return [];
  const on = new Set([...path.map((s) => lower(s.field)), ...measureFields(d.measure).map(lower)]);
  const numeric = numericColumns(d.table);
  const id = book.tableIdByName(d.table);
  const identity = id ? lower(tableHeaders(id)[0] ?? '') : '';
  const dims = (chart.analytic?.dims ?? []).map(lower);
  return fieldsOf(d)
    .filter((f) => !on.has(lower(f)) && (dims.includes(lower(f)) || (!numeric.has(lower(f)) && lower(f) !== identity)))
    .slice(0, 32);
}

/** The engine query for the tree as it stands. */
export function query(d: Decomp): DecompQuery {
  const q: DecompQuery = { table: d.table, measure: d.measure, selections: baseOf(d), top_n: d.topN, splits: d.splits };
  const at = d.selectedPath;
  // a suggestion is worked out only for the selected node, and only while it has no split
  if (d.suggest && d.selected && at && !d.splits.some((s) => samePath(s.path, at))) {
    const fields = candidates(d, at);
    q.suggest = { at, rule: d.rule, ...(fields.length ? { fields } : {}) };
  }
  return q;
}

/** Split the node at `path` by `field`. A different field replaces its split, and the levels that hung
 * below the old one go with it (their paths go through the old field's values). */
export function addSplit(d: Decomp, path: DecompStep[], field: string): Decomp {
  const cur = d.splits.find((s) => samePath(s.path, path));
  if (cur && lower(cur.field) === lower(field)) return d;
  return { ...removeSplit(d, path), splits: [...removeSplit(d, path).splits, { path, field }] };
}

/** Remove the split of the node at `path`, and every split below it. */
export function removeSplit(d: Decomp, path: DecompStep[]): Decomp {
  return { ...d, splits: d.splits.filter((s) => !hasPrefix(s.path, path)) };
}

/** Accept the engine's suggested split for its node, and show the new level (a node collapsed
 * before its old split was removed would otherwise hide it). */
export function acceptSuggestion(d: Decomp, tree: DecompTree): Decomp {
  const s = tree.suggestion;
  if (!s || !s.field) return d;
  const out = addSplit(d, s.at, s.field);
  return { ...out, collapsed: out.collapsed.filter((c) => c !== s.node_id) };
}

/** Splits that name a field (or go through one) that is no longer a header of the table: the
 * engine refuses the whole tree for them, so the panel offers to remove them. */
export function staleSplits(d: Decomp): DecompSplitSpec[] {
  const id = book.tableIdByName(d.table);
  if (!id) return [];
  const heads = new Set(tableHeaders(id).filter(Boolean).map(lower));
  return d.splits.filter((s) => !heads.has(lower(s.field)) || s.path.some((st) => !heads.has(lower(st.field))));
}

export interface FlatNode {
  node: DecompNode;
  depth: number;
  parent: string | null;
  split?: DecompSplit;
}

/** The outline in display order, skipping the children of collapsed nodes. */
export function flatten(tree: DecompTree, collapsed: string[]): FlatNode[] {
  const out: FlatNode[] = [];
  const shut = new Set(collapsed);
  const walk = (n: DecompNode, depth: number, parent: string | null) => {
    out.push({ node: n, depth, parent, split: n.split });
    if (n.split && !shut.has(n.id)) for (const c of n.split.children) walk(c, depth + 1, n.id);
  };
  walk(tree.root, 0, null);
  return out;
}

/** Find a node by id. */
export function findNode(tree: DecompTree, id: string | null): DecompNode | null {
  if (!id) return null;
  const walk = (n: DecompNode): DecompNode | null => {
    if (n.id === id) return n;
    for (const c of n.split?.children ?? []) {
      const f = walk(c);
      if (f) return f;
    }
    return null;
  };
  return walk(tree.root);
}

/** A canonical key as its column shows it: numbers and dates through the column's number format
 * (its first data row's, as the grid shows them) and the workbook's decimal comma; the rest as
 * keyLabel. */
export function keyText(table: string, field: string, v: KeyValue): string {
  if (v !== null && typeof v === 'object' && 'n' in v) {
    const id = book.tableIdByName(table);
    const meta = id ? getState().tables.get(id) : undefined;
    const c = id ? tableHeaders(id).findIndex((h) => lower(h) === lower(field)) : -1;
    const pattern = id && meta && c >= 0 ? cellAt(id, meta.header_rows, c)?.f?.number_format : undefined;
    return formatNumber(v.n, pattern || undefined);
  }
  return keyLabel(v);
}

/** Label of a canonical key, as shown. */
export function keyLabel(v: KeyValue): string {
  if (v === null) return '(blank)';
  if ('n' in v) return String(v.n);
  if ('s' in v) return v.s.trim() === '' ? '(blank)' : v.s;
  if ('b' in v) return v.b ? 'TRUE' : 'FALSE';
  return v.e;
}

/** Open the panel on a chart (its id), a table (its name) or a ready tree state. */
export function openDecomposition(seed: number | string | Decomp): boolean {
  const st = getState();
  let d: Decomp | null = null;
  if (typeof seed === 'number') {
    const chart = st.charts.find((c) => c.id === seed);
    d = chart ? seedFromChart(chart) : null;
  } else if (typeof seed === 'string') d = seedFromTable(seed);
  else d = seed;
  if (!d) return false;
  useStore.setState({ decomp: d, panel: 'decompose' });
  return true;
}

let last: DecompTree | null = null;
/** The tree the panel last showed (tests). */
export function decompTree(): DecompTree | null {
  return last;
}
export function rememberTree(t: DecompTree | null) {
  last = t;
}

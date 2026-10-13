// Cross-filtering between analytical charts (roadmap 7.2). Selecting marks is this viewer's
// interaction state (store.markSelections), never an operation: the workbook, its filters, the log
// and SUBTOTAL are untouched (docs/analytical-model.md).
//
// Policies, stated rather than assumed (docs/research/interaction-behaviour.md §1):
// * a selection in chart A filters every other analytical chart on the same table; A itself is
//   not filtered, it highlights its selected marks — so links cannot loop;
// * click selects one mark, Ctrl/Cmd/Shift-click adds or removes one;
// * clearing (click the selected mark again, click empty plot area, Esc) shows all values;
// * a chart with several dimensions drills down one level at a time (store.drillPaths, also per
//   viewer); the path filters only that chart, and its selection is on the current level's field;
// * drill-through lists the records behind the selected marks (or behind the whole chart) with the
//   same selections the chart used, so they add up to what it shows (roadmap 7.3).

import type { AnalyticSelection, Chart, KeyValue } from '../engine/types';
import { getState, useStore, type MarkSelection } from '../state/store';

/** Canonical identity of a key, as the engine groups values: numbers at 15 significant digits,
 * text ignoring case and surrounding blanks, blank text as blank. */
export function keyId(v: KeyValue): string {
  if (v === null) return 'e:';
  if ('n' in v) return `n:${v.n === 0 ? 0 : Number(v.n.toPrecision(15))}`;
  if ('s' in v) return v.s.trim() === '' ? 'e:' : `s:${v.s.toLowerCase()}`;
  if ('b' in v) return `b:${v.b}`;
  return `x:${v.e}`;
}

const sameTable = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** How deep a chart is drilled (0 = its first dimension). */
export function drillLevel(chart: Chart, paths = getState().drillPaths): number {
  const n = chart.analytic?.dims.length ?? 0;
  return Math.max(0, Math.min(paths[chart.id]?.keys.length ?? 0, n - 1));
}

/** The field a chart currently groups by. */
export function currentField(chart: Chart, paths = getState().drillPaths): string {
  return chart.analytic?.dims[drillLevel(chart, paths)] ?? '';
}

/** The drill path as selections: each outer level fixed at the value drilled into. */
export function pathSelections(chart: Chart, paths = getState().drillPaths): AnalyticSelection[] {
  const an = chart.analytic;
  const p = paths[chart.id];
  if (!an || !p) return [];
  return p.keys.slice(0, drillLevel(chart, paths)).map((k, i) => ({ field: an.dims[i], values: [k] }));
}

/** The drill path's labels, outermost first ("Toyota"). */
export function pathLabels(chart: Chart, paths = getState().drillPaths): string[] {
  return (paths[chart.id]?.labels ?? []).slice(0, drillLevel(chart, paths));
}

/** The selection of a chart, if it still matches what the chart shows (table and current field). */
export function ownSelection(chart: Chart, sels = getState().markSelections, paths = getState().drillPaths): MarkSelection | null {
  const s = sels[chart.id];
  const an = chart.analytic;
  if (!s || !an || !an.dims.length) return null;
  return sameTable(s.table, an.table) && s.field.toLowerCase() === currentField(chart, paths).toLowerCase() ? s : null;
}

/** What the other charts' selections ask of this chart (AND across charts). */
export function incoming(chart: Chart, charts = getState().charts, sels = getState().markSelections): { selections: AnalyticSelection[]; from: MarkSelection[] } {
  const an = chart.analytic;
  const out: AnalyticSelection[] = [];
  const from: MarkSelection[] = [];
  if (!an) return { selections: out, from };
  for (const other of charts) {
    if (other.id === chart.id) continue;
    const s = ownSelection(other, sels);
    if (!s || !s.keys.length || !sameTable(s.table, an.table)) continue;
    out.push({ field: s.field, values: s.keys });
    from.push(s);
  }
  return { selections: out, from };
}

/** Select (or with `additive`, toggle) one mark of an analytical chart. */
export function toggleMark(chart: Chart, key: KeyValue, label: string, additive: boolean | 'only') {
  const an = chart.analytic;
  if (!an || !an.dims.length) return;
  const sels = getState().markSelections;
  const cur = ownSelection(chart, sels);
  const id = keyId(key);
  const has = !!cur && cur.keys.some((k) => keyId(k) === id);
  let keys: KeyValue[];
  let labels: string[];
  if (additive === 'only') {
    keys = [key];
    labels = [label];
  } else if (additive && cur) {
    keys = has ? cur.keys.filter((k) => keyId(k) !== id) : [...cur.keys, key];
    labels = has ? cur.labels.filter((_, i) => keyId(cur.keys[i]) !== id) : [...cur.labels, label];
  } else if (has && cur!.keys.length === 1) {
    keys = [];
    labels = [];
  } else {
    keys = [key];
    labels = [label];
  }
  const next = { ...sels };
  if (keys.length) next[chart.id] = { table: an.table, field: currentField(chart), keys, labels };
  else delete next[chart.id];
  useStore.setState({ markSelections: next });
}

/** Clear one chart's selection, or every selection. Returns whether anything was cleared. */
export function clearMarks(chartId?: number): boolean {
  const sels = getState().markSelections;
  if (chartId === undefined) {
    if (!Object.keys(sels).length) return false;
    useStore.setState({ markSelections: {} });
    return true;
  }
  if (!sels[chartId]) return false;
  const next = { ...sels };
  delete next[chartId];
  useStore.setState({ markSelections: next });
  return true;
}

/** Drill into one value of the current level (needs a next dimension). Clears the chart's selection. */
export function drillDown(chart: Chart, key: KeyValue, label: string): boolean {
  const an = chart.analytic;
  if (!an) return false;
  const lvl = drillLevel(chart);
  if (lvl >= an.dims.length - 1) return false;
  const st = getState();
  const cur = st.drillPaths[chart.id] ?? { keys: [], labels: [] };
  const sels = { ...st.markSelections };
  delete sels[chart.id];
  useStore.setState({
    drillPaths: { ...st.drillPaths, [chart.id]: { keys: [...cur.keys.slice(0, lvl), key], labels: [...cur.labels.slice(0, lvl), label] } },
    markSelections: sels,
  });
  return true;
}

/** Go back up one level. Nothing is selected there: selecting would start filtering other charts. */
export function drillUp(chart: Chart): boolean {
  const st = getState();
  const lvl = drillLevel(chart);
  const cur = st.drillPaths[chart.id];
  if (!cur || lvl === 0 || !chart.analytic) return false;
  const paths = { ...st.drillPaths };
  if (lvl - 1 === 0) delete paths[chart.id];
  else paths[chart.id] = { keys: cur.keys.slice(0, lvl - 1), labels: cur.labels.slice(0, lvl - 1) };
  const sels = { ...st.markSelections };
  delete sels[chart.id];
  useStore.setState({ drillPaths: paths, markSelections: sels });
  return true;
}

/** Forget a chart's interaction state (deleted, or its binding changed). */
export function forgetChart(chartId: number) {
  const st = getState();
  if (!st.markSelections[chartId] && !st.drillPaths[chartId]) return;
  const sels = { ...st.markSelections };
  const paths = { ...st.drillPaths };
  delete sels[chartId];
  delete paths[chartId];
  useStore.setState({ markSelections: sels, drillPaths: paths });
}

/** The selections behind a chart's records: what filters it, its drill path and, unless
 * `whole`, its selected marks — the same selections its numbers were computed with. */
export function recordSelections(chart: Chart, whole = false): AnalyticSelection[] {
  const own = whole ? null : ownSelection(chart);
  const out = [...incoming(chart).selections, ...pathSelections(chart)];
  if (own && own.keys.length) out.push({ field: own.field, values: own.keys });
  return out;
}


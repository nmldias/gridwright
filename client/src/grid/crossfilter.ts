// Cross-filtering between analytical charts (roadmap 7.2). Selecting marks is this viewer's
// interaction state (store.markSelections), never an operation: the workbook, its filters, the log
// and SUBTOTAL are untouched (docs/analytical-model.md).
//
// Policies, stated rather than assumed (docs/research/interaction-behaviour.md §1):
// * a selection in chart A filters every other analytical chart on the same table; A itself is
//   not filtered, it highlights its selected marks — so links cannot loop;
// * click selects one mark, Ctrl/Cmd/Shift-click adds or removes one;
// * clearing (click the selected mark again, click empty plot area, Esc) shows all values.

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

/** The selection of a chart, if it still matches what the chart shows (table and first field). */
export function ownSelection(chart: Chart, sels = getState().markSelections): MarkSelection | null {
  const s = sels[chart.id];
  const an = chart.analytic;
  if (!s || !an || !an.dims.length) return null;
  return sameTable(s.table, an.table) && s.field.toLowerCase() === an.dims[0].toLowerCase() ? s : null;
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
export function toggleMark(chart: Chart, key: KeyValue, label: string, additive: boolean) {
  const an = chart.analytic;
  if (!an || !an.dims.length) return;
  const sels = getState().markSelections;
  const cur = ownSelection(chart, sels);
  const id = keyId(key);
  const has = !!cur && cur.keys.some((k) => keyId(k) === id);
  let keys: KeyValue[];
  let labels: string[];
  if (additive && cur) {
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
  if (keys.length) next[chart.id] = { table: an.table, field: an.dims[0], keys, labels };
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

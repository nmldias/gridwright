// Review helpers: sign-offs, checks, trace navigation and chart creation from a selection.

import * as book from '../engine/book';
import { EMPTY_CHART, refText, type Chart, type ChartKind, type Rect, type TableId } from '../engine/types';
import { layoutOf } from '../grid/geometry';
import { selectCell } from '../grid/actions';
import { cellAt, getState, setStatus, useStore } from '../state/store';

/** Sign off the current selection (or the whole table when nothing is selected). */
export function signOffSelection(note: string, locked: boolean): boolean {
  const st = getState();
  const sel = st.selection;
  if (!sel) return false;
  const meta = st.tables.get(sel.table);
  if (!meta) return false;
  const name = st.me.name || 'Guest';
  const ch = book.apply(
    {
      type: 'add_signoff',
      table: sel.table,
      r0: sel.r0,
      c0: sel.c0,
      r1: sel.r1,
      c1: sel.c1,
      by: name,
      login: st.me.login,
      at: new Date().toISOString(),
      note,
      locked,
    },
    { note: `signed off ${refText(meta.name, sel.r0, sel.c0, sel.r1, sel.c1)}${note ? ': ' + note : ''}` },
  );
  if (ch.error) {
    setStatus(ch.error, 5000);
    return false;
  }
  setStatus(locked ? 'Signed off and locked' : 'Signed off', 2000);
  return true;
}

export function removeSignoff(table: TableId, id: number) {
  const ch = book.apply({ type: 'remove_signoff', table, id }, { note: 'sign-off removed' });
  if (ch.error) setStatus(ch.error, 5000);
}

export function setSignoffLocked(table: TableId, id: number, locked: boolean) {
  const ch = book.apply({ type: 'set_signoff_locked', table, id, locked }, { note: locked ? 'range locked' : 'range unlocked' });
  if (ch.error) setStatus(ch.error, 5000);
}

/** Show the precedents/dependents overlay for the active cell. */
export function traceActiveCell(): boolean {
  const sel = getState().selection;
  if (!sel) return false;
  const t = book.trace(sel.table, sel.ar, sel.ac);
  useStore.setState({ trace: { cell: { table: sel.table, row: sel.ar, col: sel.ac }, precedents: t.precedents, dependents: t.dependents } });
  return t.precedents.length + t.dependents.length > 0;
}

/**
 * Ctrl+[ jumps to the first precedent, Ctrl+] to the first dependent (and shows the overlay);
 * repeated presses walk through them.
 */
let walk: { cell: string; dir: 'precedents' | 'dependents'; idx: number } | null = null;
export function traceStep(dir: 'precedents' | 'dependents') {
  const st = getState();
  const sel = st.selection;
  if (!sel) return;
  const key = `${sel.table}:${sel.ar}:${sel.ac}`;
  const current = st.trace && `${st.trace.cell.table}:${st.trace.cell.row}:${st.trace.cell.col}` === key ? st.trace : null;
  const t = current ?? book.trace(sel.table, sel.ar, sel.ac);
  if (!current) useStore.setState({ trace: { cell: { table: sel.table, row: sel.ar, col: sel.ac }, precedents: t.precedents, dependents: t.dependents } });
  const targets: { table: TableId; row: number; col: number }[] = dir === 'precedents' ? t.precedents.map((r: Rect) => ({ table: r.table, row: r.r0, col: r.c0 })) : t.dependents.map((d) => ({ table: d.table, row: d.row, col: d.col }));
  if (!targets.length) {
    setStatus(dir === 'precedents' ? 'This cell reads no other cells' : 'No cell reads this one', 2500);
    return;
  }
  const idx = walk && walk.cell === key && walk.dir === dir ? (walk.idx + 1) % targets.length : 0;
  walk = { cell: key, dir, idx };
  const target = targets[idx];
  // keep the overlay on the original cell while walking its references
  const keep = getState().trace;
  selectCell(target.table, target.row, target.col);
  useStore.setState({ trace: keep });
  setStatus(`${dir === 'precedents' ? 'Precedent' : 'Dependent'} ${idx + 1} of ${targets.length}`, 2000);
}

export function clearTrace() {
  walk = null;
  useStore.setState({ trace: null });
}

/** Header-aware guess of a chart from the selection: first column = categories, other columns = series. */
export function chartFromSelection(kind: ChartKind = 'bar'): Chart | null {
  const st = getState();
  const sel = st.selection;
  if (!sel) return null;
  const meta = st.tables.get(sel.table);
  if (!meta) return null;
  let { r0, c0, r1, c1 } = sel;
  // a single cell: take the whole table
  if (r0 === r1 && c0 === c1) {
    r0 = 0;
    c0 = 0;
    r1 = meta.rows - 1;
    c1 = meta.cols - 1;
    // trim trailing empty rows/cols
    const cells = st.cells.get(sel.table);
    const used = (r: number, c: number) => {
      const v = cells?.get(r * 65536 + c);
      return !!v && (v.i !== '' || v.v !== null);
    };
    while (r1 > 0 && ![...Array(c1 + 1).keys()].some((c) => used(r1, c))) r1--;
    while (c1 > 0 && ![...Array(r1 + 1).keys()].some((r) => used(r, c1))) c1--;
  }
  const firstIsHeader = meta.header_rows > 0 && r0 < meta.header_rows ? true : (() => {
    // no declared header: treat the first row as labels when it is text and the second row holds numbers
    const a = cellAt(sel.table, r0, c0 + (c1 > c0 ? 1 : 0))?.v;
    const b = cellAt(sel.table, r0 + 1, c0 + (c1 > c0 ? 1 : 0))?.v;
    return !!a && 's' in a && !!b && 'n' in b;
  })();
  const dataR0 = firstIsHeader ? r0 + 1 : r0;
  if (dataR0 > r1) return null;
  const chart: Chart = { ...EMPTY_CHART, kind, series: [] };
  const cats = c1 > c0 ? refText(meta.name, dataR0, c0, r1, c0) : '';
  chart.categories = cats;
  const firstSeriesCol = c1 > c0 ? c0 + 1 : c0;
  for (let c = firstSeriesCol; c <= c1; c++) {
    const header = firstIsHeader ? cellAt(sel.table, r0, c) : undefined;
    const name = header ? String(header.v && 's' in header.v ? header.v.s : header.i || '') : '';
    chart.series.push({ name: name || `Series ${c - firstSeriesCol + 1}`, range: refText(meta.name, dataR0, c, r1, c) });
  }
  if (!chart.series.length) return null;
  const n = r1 - dataR0 + 1;
  if (n > 30 && chart.kind === 'bar') chart.kind = 'line';
  const L = layoutOf(meta);
  chart.x = Math.round((meta.x + L.width + 40) / 8) * 8;
  chart.y = meta.y;
  chart.exhibit = `Exhibit ${st.charts.length + 1} — ${meta.name}`;
  const s0 = chart.series[0].name;
  chart.title = chart.series.length === 1 ? `${s0} by ${firstIsHeader ? String(cellAt(sel.table, r0, c0)?.v && 's' in (cellAt(sel.table, r0, c0)!.v as object) ? (cellAt(sel.table, r0, c0)!.v as { s: string }).s : 'category') : 'category'}` : `${chart.series.map((s) => s.name).join(', ')} by category`;
  chart.subtitle = `${meta.name}, ${n} ${n === 1 ? 'row' : 'rows'}`;
  chart.source = `${meta.name} table, ${st.fileName}`;
  return chart;
}

/** Insert a chart built from the selection; returns its id. */
export function insertChart(kind: ChartKind = 'bar'): number | null {
  const chart = chartFromSelection(kind);
  if (!chart) {
    setStatus('Select a table (or a block with a header row and numbers) first', 4000);
    return null;
  }
  const ch = book.apply({ type: 'add_chart', chart }, { note: `chart: ${chart.title}` });
  if (ch.error) {
    setStatus(ch.error, 5000);
    return null;
  }
  const id = ch.created_chart ?? null;
  useStore.setState({ selectedChart: id, selectedTable: null, panel: 'chart' });
  return id;
}

export function updateChart(chart: Chart, note = 'chart changed') {
  const ch = book.apply({ type: 'update_chart', chart }, { note });
  if (ch.error) setStatus(ch.error, 5000);
}

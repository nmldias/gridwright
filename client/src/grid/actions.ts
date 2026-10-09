// Selection, editing and clipboard actions shared by the canvas controller,
// keyboard handling and the toolbar.

import * as book from '../engine/book';
import { isCodeKind, type CellKind, type CellView, type Format, type TableId } from '../engine/types';
import { cellAt, getState, setStatus, useStore, type Selection } from '../state/store';
import { FILTER_BTN, layoutOf, nextVisibleRow } from './geometry';
import { displayOf } from './format';
import { neededWidth } from './renderer';

export interface RendererLike {
  ensureVisible: (x0: number, y0: number, x1: number, y1: number) => void;
  fitRect: (x0: number, y0: number, x1: number, y1: number, margin?: number, maxZoom?: number) => void;
  resetZoom: () => void;
  markDirty: () => void;
  pan: { x: number; y: number };
  zoom: number;
}
let renderer: RendererLike | null = null;
export function bindRenderer(r: RendererLike | null) {
  renderer = r;
}
export function getRenderer(): RendererLike | null {
  return renderer;
}

export function selectCell(table: TableId, r: number, c: number, extend = false) {
  const st = getState();
  const meta = st.tables.get(table);
  if (!meta) return;
  r = Math.max(0, Math.min(r, meta.rows - 1));
  c = Math.max(0, Math.min(c, meta.cols - 1));
  let sel: Selection;
  if (extend && st.selection && st.selection.table === table) {
    const a = st.selection;
    sel = { table, r0: Math.min(a.ar, r), c0: Math.min(a.ac, c), r1: Math.max(a.ar, r), c1: Math.max(a.ac, c), ar: a.ar, ac: a.ac };
  } else {
    sel = { table, r0: r, c0: c, r1: r, c1: c, ar: r, ac: c };
  }
  useStore.setState({ selection: sel, editorText: cellAt(table, sel.ar, sel.ac)?.i ?? '' });
  scrollTo(table, extend ? r : sel.ar, extend ? c : sel.ac);
  renderer?.markDirty();
}

export function selectRange(table: TableId, r0: number, c0: number, r1: number, c1: number) {
  const meta = getState().tables.get(table);
  if (!meta) return;
  const sel: Selection = {
    table,
    r0: Math.max(0, Math.min(r0, r1)),
    c0: Math.max(0, Math.min(c0, c1)),
    r1: Math.min(meta.rows - 1, Math.max(r0, r1)),
    c1: Math.min(meta.cols - 1, Math.max(c0, c1)),
    ar: Math.max(0, Math.min(r0, r1)),
    ac: Math.max(0, Math.min(c0, c1)),
  };
  useStore.setState({ selection: sel, editorText: cellAt(table, sel.ar, sel.ac)?.i ?? '' });
  renderer?.markDirty();
}

/** World rectangle of a table, a selection, or everything on the canvas. */
function worldRectOf(what: { table: TableId; r0?: number; c0?: number; r1?: number; c1?: number } | 'all'): [number, number, number, number] | null {
  const st = getState();
  if (what === 'all') {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const meta of st.tables.values()) {
      const L = layoutOf(meta);
      x0 = Math.min(x0, meta.x);
      y0 = Math.min(y0, meta.y - 24);
      x1 = Math.max(x1, meta.x + L.width);
      y1 = Math.max(y1, meta.y + L.height);
    }
    for (const ch of st.charts) {
      x0 = Math.min(x0, ch.x);
      y0 = Math.min(y0, ch.y);
      x1 = Math.max(x1, ch.x + ch.w);
      y1 = Math.max(y1, ch.y + ch.h);
    }
    return Number.isFinite(x0) ? [x0, y0, x1, y1] : null;
  }
  const meta = st.tables.get(what.table);
  if (!meta) return null;
  const L = layoutOf(meta);
  const r0 = what.r0 ?? 0;
  const c0 = what.c0 ?? 0;
  const r1 = what.r1 ?? meta.rows - 1;
  const c1 = what.c1 ?? meta.cols - 1;
  return [meta.x + L.colX[c0], meta.y + L.rowY[r0] - (r0 === 0 ? 24 : 0), meta.x + L.colX[Math.min(meta.cols, c1 + 1)], meta.y + L.rowY[Math.min(meta.rows, r1 + 1)]];
}

/** Fit the whole table (or a range of it) in the view. */
export function fitTable(table: TableId, range?: { r0: number; c0: number; r1: number; c1: number }) {
  const rect = worldRectOf({ table, ...(range ?? {}) });
  if (rect && renderer) renderer.fitRect(...rect);
}

/** Select a table (its first body cell active) and fit it in the view. */
export function jumpToTable(table: TableId) {
  const meta = getState().tables.get(table);
  if (!meta) return;
  useStore.setState({ selectedTable: table, selectedChart: null });
  selectCell(table, Math.min(meta.rows - 1, meta.header_rows), 0);
  fitTable(table);
}

/** Fit every table and chart in the view. */
export function fitAll() {
  const rect = worldRectOf('all');
  if (rect && renderer) renderer.fitRect(...rect, 40, 1);
}

/** Fit the current selection (a single cell gets its table). */
export function fitSelection() {
  const sel = getState().selection;
  if (!sel) return fitAll();
  const single = sel.r0 === sel.r1 && sel.c0 === sel.c1;
  fitTable(sel.table, single ? undefined : { r0: sel.r0, c0: sel.c0, r1: sel.r1, c1: sel.c1 });
}

export function resetZoom() {
  renderer?.resetZoom();
}

/** Bring a chart into view and select it. */
export function goToChart(id: number) {
  const ch = getState().charts.find((c) => c.id === id);
  if (!ch || !renderer) return;
  useStore.setState({ selectedChart: id, selectedTable: null });
  renderer.ensureVisible(ch.x, ch.y, ch.x + ch.w, ch.y + ch.h);
  renderer.markDirty();
}

/** Jump to a table by name, or to a reference like `Sales::B2` / `Sales::A1:C9` / `B2` (in the selected table). */
export function goTo(text: string): boolean {
  const st = getState();
  const t = text.trim();
  if (!t) return false;
  const byName = [...st.tables.values()].find((m) => m.name.toLowerCase() === t.toLowerCase());
  if (byName) {
    jumpToTable(byName.id);
    return true;
  }
  const m = /^(?:'([^']+)'|([^:!]+))?(?:::|!)?\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$/.exec(t);
  if (!m) return false;
  const tname = m[1] ?? m[2];
  const table = tname ? [...st.tables.values()].find((x) => x.name.toLowerCase() === tname.trim().toLowerCase()) : st.selection ? st.tables.get(st.selection.table) : st.tables.values().next().value;
  if (!table) return false;
  const col = (s: string) => s.toUpperCase().split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
  const r0 = parseInt(m[4], 10) - 1;
  const c0 = col(m[3]);
  const r1 = m[6] ? parseInt(m[6], 10) - 1 : r0;
  const c1 = m[5] ? col(m[5]) : c0;
  if (r0 < 0 || c0 < 0 || r0 >= table.rows || c0 >= table.cols) return false;
  if (r1 === r0 && c1 === c0) selectCell(table.id, r0, c0);
  else {
    selectRange(table.id, Math.min(r0, r1), Math.min(c0, c1), Math.min(table.rows - 1, Math.max(r0, r1)), Math.min(table.cols - 1, Math.max(c0, c1)));
    scrollTo(table.id, Math.min(r0, r1), Math.min(c0, c1));
  }
  return true;
}

export function scrollTo(table: TableId, r: number, c: number) {
  const meta = getState().tables.get(table);
  if (!meta || !renderer) return;
  const L = layoutOf(meta);
  renderer.ensureVisible(meta.x + L.colX[c], meta.y + L.rowY[r], meta.x + L.colX[c + 1], meta.y + L.rowY[r + 1]);
}

export function moveActive(dr: number, dc: number, extend = false) {
  const st = getState();
  const sel = st.selection;
  if (!sel) return;
  const meta = st.tables.get(sel.table);
  if (!meta) return;
  // rows hidden by filters are skipped
  const step = (from: number, d: number): number => {
    if (d === 0 || !meta.hidden_rows?.length) return Math.max(0, Math.min(meta.rows - 1, from + d));
    const dir: 1 | -1 = d > 0 ? 1 : -1;
    let r = from;
    let left = Math.min(Math.abs(d), meta.rows);
    while (left > 0) {
      const next = nextVisibleRow(meta, r + dir, dir);
      if (next === null) break;
      r = next;
      left--;
    }
    return r;
  };
  if (extend) {
    // move the far corner relative to the anchor
    const fr = sel.r1 !== sel.ar ? sel.r1 : sel.r0;
    const fc = sel.c1 !== sel.ac ? sel.c1 : sel.c0;
    const nr = step(fr, dr);
    const nc = Math.max(0, Math.min(meta.cols - 1, fc + dc));
    selectCell(sel.table, nr, nc, true);
  } else {
    selectCell(sel.table, step(sel.ar, dr), sel.ac + dc);
  }
}

export function startEdit(initial?: string, replace = false) {
  const st = getState();
  const sel = st.selection;
  if (!sel) return;
  const cell = cellAt(sel.table, sel.ar, sel.ac);
  if (cell?.s) {
    setStatus('This cell shows spilled output — edit the source cell.');
    return;
  }
  if (cell && isCodeKind(cell.k)) {
    openCodeCell(sel.table, sel.ar, sel.ac);
    return;
  }
  const meta = st.tables.get(sel.table);
  if (meta?.pivot) {
    setStatus('This table is a pivot — its cells are computed from the source table.');
    return;
  }
  const text = initial !== undefined ? initial : (cell?.i ?? '');
  useStore.setState({ editing: { table: sel.table, r: sel.ar, c: sel.ac, initial: text, replace, source: 'cell' }, editorText: text, selectedTable: null });
  renderer?.markDirty();
}

/** Returns false when a strict validation rule refused the value (the editor stays open). */
export function commitEdit(text: string, move: { dr: number; dc: number } | null): boolean {
  const st = getState();
  const ed = st.editing;
  if (!ed) return true;
  const prev = cellAt(ed.table, ed.r, ed.c)?.i ?? '';
  if (text !== prev) {
    const meta = st.tables.get(ed.table);
    if (meta?.validations.length) {
      const v = book.checkValidation(ed.table, ed.r, ed.c, text);
      if (!v.ok) {
        if (v.strict) {
          setStatus(`Not allowed: ${v.message}`, 5000);
          return false;
        }
        setStatus(`Note: ${v.message}`, 4000);
      }
    }
    useStore.setState({ editing: null });
    book.apply({ type: 'set_cell', table: ed.table, row: ed.r, col: ed.c, input: text });
  } else {
    useStore.setState({ editing: null });
  }
  if (move) moveActive(move.dr, move.dc);
  else selectCell(ed.table, ed.r, ed.c);
  return true;
}

export function cancelEdit() {
  const ed = getState().editing;
  if (!ed) return;
  useStore.setState({ editing: null, editorText: cellAt(ed.table, ed.r, ed.c)?.i ?? '' });
  renderer?.markDirty();
}

export function clearSelection() {
  const sel = getState().selection;
  if (!sel) return;
  book.apply({ type: 'clear_range', table: sel.table, r0: sel.r0, c0: sel.c0, r1: sel.r1, c1: sel.c1 });
  useStore.setState({ editorText: '' });
}

export function applyFormat(format: Format) {
  const sel = getState().selection;
  if (!sel) return;
  book.apply({ type: 'set_format', table: sel.table, r0: sel.r0, c0: sel.c0, r1: sel.r1, c1: sel.c1, format });
}

export function toggleBold() {
  const sel = getState().selection;
  if (!sel) return;
  const cell = cellAt(sel.table, sel.ar, sel.ac);
  applyFormat({ bold: !cell?.f?.bold });
}

/** Turn the active cell into a code cell of the given language and open the editor. */
export function makeCodeCell(kind: CellKind, conn?: string) {
  const sel = getState().selection;
  if (!sel) return;
  const cell = cellAt(sel.table, sel.ar, sel.ac);
  if (cell?.s) {
    setStatus('This cell shows spilled output — pick another cell.');
    return;
  }
  if (getState().tables.get(sel.table)?.pivot) {
    setStatus('This table is a pivot — pick a cell in another table.');
    return;
  }
  const existing = cell?.i ?? '';
  const templates: Record<string, string> = {
    python: `# Python cell — the last expression is written to the sheet\n# q.cells("A1:B5") reads a range, q.cells("A1") a single value\n`,
    javascript: `// JavaScript cell — return a value, a list, or a 2-D array\n// q.cells("A1:B5") reads a range\nreturn 1 + 1;\n`,
    sql: `-- SQL cell: the result spills from this cell. Use {{A1}} or {{Table::B2}} as parameters.\nSELECT 1 AS answer\n`,
  };
  const template = existing && cell?.k === kind ? existing : templates[kind] ?? '';
  if (!cell || cell.k !== kind) {
    // new Python cells run on the server when the host offers it (faster, real CPython); existing cells keep their choice
    const sp = getState().serverPython;
    const runtime = kind === 'python' && sp && sp.can?.run !== false ? 'server' : undefined;
    book.apply({ type: 'set_cell', table: sel.table, row: sel.ar, col: sel.ac, input: template, kind, conn: kind === 'sql' ? (conn ?? null) : undefined, runtime });
  }
  openCodeCell(sel.table, sel.ar, sel.ac);
}

export function openCodeCell(table: TableId, r: number, c: number) {
  useStore.setState({ panel: 'code', codeCell: { table, row: r, col: c }, editing: null });
}

// ---------------------------------------------------------------------------
// clipboard
// ---------------------------------------------------------------------------

interface ClipBlock {
  tsv: string;
  inputs: string[][];
  origin: { table: TableId; r: number; c: number };
  cut: boolean;
}
let lastCopy: ClipBlock | null = null;

export function selectionToTsv(sel: Selection): { tsv: string; inputs: string[][] } {
  const rows: string[] = [];
  const inputs: string[][] = [];
  for (let r = sel.r0; r <= sel.r1; r++) {
    const line: string[] = [];
    const inp: string[] = [];
    for (let c = sel.c0; c <= sel.c1; c++) {
      const cell = cellAt(sel.table, r, c);
      const v = cell?.v;
      let text = '';
      if (v) {
        if ('n' in v) text = String(v.n);
        else if ('s' in v) text = v.s;
        else if ('b' in v) text = v.b ? 'TRUE' : 'FALSE';
        else if ('e' in v) text = v.e;
      }
      line.push(text.replace(/\t/g, ' ').replace(/\n/g, ' '));
      inp.push(cell?.s ? text : (cell?.i ?? ''));
    }
    rows.push(line.join('\t'));
    inputs.push(inp);
  }
  return { tsv: rows.join('\n'), inputs };
}

export async function copySelection(cut = false) {
  const sel = getState().selection;
  if (!sel) return;
  const { tsv, inputs } = selectionToTsv(sel);
  lastCopy = { tsv, inputs, origin: { table: sel.table, r: sel.r0, c: sel.c0 }, cut };
  try {
    await navigator.clipboard.writeText(tsv);
  } catch {
    /* clipboard may be unavailable (http, permissions) — internal copy still works */
  }
  setStatus(cut ? 'Cut' : 'Copied', 1500);
}

export function parseTsv(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => l.split('\t'));
}

export async function pasteFromClipboard(explicitText?: string) {
  const sel = getState().selection;
  if (!sel) return;
  let text = explicitText;
  if (text === undefined) {
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = undefined;
    }
  }
  if (lastCopy && (text === undefined || text === lastCopy.tsv)) {
    // internal paste: shift relative references, keep formulas/code
    const dr = sel.r0 - lastCopy.origin.r;
    const dc = sel.c0 - lastCopy.origin.c;
    const values = lastCopy.inputs.map((row) => row.map((s) => (s.startsWith('=') ? book.shiftFormula(s, dr, dc) : s)));
    book.apply({ type: 'set_cells', table: sel.table, row: sel.r0, col: sel.c0, values });
    if (lastCopy.cut) {
      const o = lastCopy.origin;
      book.apply({
        type: 'clear_range',
        table: o.table,
        r0: o.r,
        c0: o.c,
        r1: o.r + lastCopy.inputs.length - 1,
        c1: o.c + (lastCopy.inputs[0]?.length ?? 1) - 1,
      });
      lastCopy = null;
    }
    const rows = values.length;
    const cols = values[0]?.length ?? 1;
    selectRange(sel.table, sel.r0, sel.c0, sel.r0 + rows - 1, sel.c0 + cols - 1);
    return;
  }
  if (!text) return;
  const values = parseTsv(text);
  if (!values.length) return;
  book.apply({ type: 'set_cells', table: sel.table, row: sel.r0, col: sel.c0, values });
  selectRange(sel.table, sel.r0, sel.c0, sel.r0 + values.length - 1, sel.c0 + (values[0]?.length ?? 1) - 1);
}

/** Fill the selection from its first row/column (Ctrl+D / Ctrl+R style). */
export function fillDown() {
  const sel = getState().selection;
  if (!sel || sel.r1 === sel.r0) return;
  const values: string[][] = [];
  for (let r = sel.r0 + 1; r <= sel.r1; r++) {
    const row: string[] = [];
    for (let c = sel.c0; c <= sel.c1; c++) {
      const src = cellAt(sel.table, sel.r0, c)?.i ?? '';
      row.push(src.startsWith('=') ? book.shiftFormula(src, r - sel.r0, 0) : src);
    }
    values.push(row);
  }
  book.apply({ type: 'set_cells', table: sel.table, row: sel.r0 + 1, col: sel.c0, values });
}

/** Sort the table's data rows (below the header) by a column. Formulas keep their relative references. */
export function sortTableByColumn(table: TableId, col: number, ascending: boolean, rowRange?: { r0: number; r1: number }) {
  const st = getState();
  const meta = st.tables.get(table);
  if (!meta) return;
  // sort the selected rows when several are selected, otherwise every row below the header
  const start = rowRange ? rowRange.r0 : meta.header_rows;
  const end = rowRange ? rowRange.r1 : meta.rows - 1;
  const rows: { r: number; key: CellView['v'] }[] = [];
  for (let r = start; r <= end; r++) rows.push({ r, key: cellAt(table, r, col)?.v ?? null });
  const rank = (v: CellView['v']) => (v === null ? 3 : 'n' in v ? 0 : 's' in v ? 1 : 'b' in v ? 2 : 3);
  rows.sort((a, b) => {
    const ra = rank(a.key);
    const rb = rank(b.key);
    if (ra !== rb) return ra - rb; // blanks always last
    let cmp = 0;
    if (a.key && b.key) {
      if ('n' in a.key && 'n' in b.key) cmp = a.key.n - b.key.n;
      else if ('s' in a.key && 's' in b.key) cmp = a.key.s.localeCompare(b.key.s, undefined, { numeric: true, sensitivity: 'base' });
      else if ('b' in a.key && 'b' in b.key) cmp = Number(a.key.b) - Number(b.key.b);
    }
    return ascending ? cmp : -cmp;
  });
  const values: string[][] = rows.map((src, i) => {
    const target = start + i;
    const row: string[] = [];
    for (let c = 0; c < meta.cols; c++) {
      const cell = cellAt(table, src.r, c);
      const input = cell?.s ? '' : (cell?.i ?? '');
      row.push(input.startsWith('=') ? book.shiftFormulaRow(input, src.r, target - src.r) : input);
    }
    return row;
  });
  book.apply({ type: 'set_cells', table, row: start, col: 0, values });
}

/** Autofill: extend the source block into the (larger) target selection. */
export function fillFromSource(table: TableId, src: { r0: number; c0: number; r1: number; c1: number }, target: Selection | null) {
  if (!target || target.table !== table) return;
  const sameRows = target.r0 === src.r0 && target.r1 === src.r1;
  const sameCols = target.c0 === src.c0 && target.c1 === src.c1;
  if (sameRows && sameCols) return;
  const srcH = src.r1 - src.r0 + 1;
  const srcW = src.c1 - src.c0 + 1;
  const values: string[][] = [];
  for (let r = target.r0; r <= target.r1; r++) {
    const row: string[] = [];
    for (let c = target.c0; c <= target.c1; c++) {
      const insideSrc = r >= src.r0 && r <= src.r1 && c >= src.c0 && c <= src.c1;
      if (insideSrc) {
        row.push(cellAt(table, r, c)?.i ?? '');
        continue;
      }
      const vertical = sameCols;
      const i = vertical ? (((r - src.r0) % srcH) + srcH) % srcH : (((c - src.c0) % srcW) + srcW) % srcW;
      const sr = vertical ? src.r0 + i : r;
      const sc = vertical ? c : src.c0 + i;
      const srcCell = cellAt(table, sr, sc);
      const input = srcCell?.i ?? '';
      // numeric series when the source column/row holds ≥2 numbers with a constant step
      const seriesValues: number[] = [];
      for (let k = 0; k < (vertical ? srcH : srcW); k++) {
        const cc = cellAt(table, vertical ? src.r0 + k : r, vertical ? c : src.c0 + k);
        if (cc?.k === 'value' && cc.v && 'n' in cc.v) seriesValues.push(cc.v.n);
        else {
          seriesValues.length = 0;
          break;
        }
      }
      if (seriesValues.length >= 1 && srcCell?.k === 'value') {
        const step = seriesValues.length >= 2 ? seriesValues[1] - seriesValues[0] : 1;
        const n = seriesValues.length;
        const idx = vertical ? r - src.r0 : c - src.c0; // may be negative (filling upwards/leftwards)
        const base = seriesValues[0];
        const val = seriesValues.length >= 2 || idx >= n ? base + step * idx : base;
        row.push(String(Math.round(val * 1e10) / 1e10));
        continue;
      }
      if (input.startsWith('=')) row.push(book.shiftFormula(input, r - sr, c - sc));
      else row.push(input);
    }
    values.push(row);
  }
  book.apply({ type: 'set_cells', table, row: target.r0, col: target.c0, values });
}

export function addTable(opts: { x?: number; y?: number; rows?: number; cols?: number; name?: string; values?: string[][]; origin?: 'user' | 'ai' | 'import' | 'sql' } = {}) {
  const st = getState();
  // place below the lowest table by default
  let y = 80;
  let x = 80;
  for (const t of st.tables.values()) {
    const L = layoutOf(t);
    y = Math.max(y, t.y + L.height + 80);
  }
  const ch = book.apply(
    {
      type: 'add_table',
      name: opts.name,
      x: opts.x ?? x,
      y: opts.y ?? y,
      rows: opts.rows ?? 10,
      cols: opts.cols ?? 5,
      values: opts.values,
    },
    { origin: opts.origin ?? 'user' },
  );
  const id = ch.created?.[0];
  if (id) {
    useStore.setState({ selectedTable: id });
    selectCell(id, 0, 0);
  }
  return id;
}

/** Widen (or narrow) a column to its widest displayed value: no amount shown as a marker, no ellipsis. */
export function autoFitColumn(table: TableId, col: number, min = 48, max = 600): number | null {
  const meta = getState().tables.get(table);
  const map = getState().cells.get(table);
  if (!meta || col < 0 || col >= meta.cols) return null;
  let need = min;
  if (map) {
    for (const cell of map.values()) {
      if (cell.c !== col || cell.s) continue;
      const text = displayOf(cell);
      if (!text) continue;
      const bold = !!cell.f?.bold || cell.r < meta.header_rows;
      const w = neededWidth(text, bold) + (cell.r < meta.header_rows ? FILTER_BTN + 2 : 0);
      if (w > need) need = w;
    }
  }
  const width = Math.min(max, Math.round(need));
  if (Math.abs(width - meta.col_widths[col]) >= 1) book.apply({ type: 'set_col_width', table, col, width });
  return width;
}

/** Fit every column of a table (or those of the selection). */
export function autoFitColumns(table: TableId, c0?: number, c1?: number) {
  const meta = getState().tables.get(table);
  if (!meta) return;
  const a = c0 ?? 0;
  const b = c1 ?? meta.cols - 1;
  for (let c = a; c <= b; c++) autoFitColumn(table, c);
}

export function deleteSelectedTable() {
  const st = getState();
  const id = st.selectedTable ?? st.selection?.table;
  if (!id) return;
  if (st.tables.size <= 1) {
    setStatus('A document keeps at least one table.');
    return;
  }
  book.apply({ type: 'delete_table', table: id });
}

// Selection, editing and clipboard actions shared by the canvas controller,
// keyboard handling and the toolbar.

import * as book from '../engine/book';
import type { CellKind, CellView, Format, TableId } from '../engine/types';
import { cellAt, getState, setStatus, useStore, type Selection } from '../state/store';
import { layoutOf } from './geometry';

export interface RendererLike {
  ensureVisible: (x0: number, y0: number, x1: number, y1: number) => void;
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
  if (extend) {
    // move the far corner relative to the anchor
    const fr = sel.r1 !== sel.ar ? sel.r1 : sel.r0;
    const fc = sel.c1 !== sel.ac ? sel.c1 : sel.c0;
    const nr = Math.max(0, Math.min(meta.rows - 1, fr + dr));
    const nc = Math.max(0, Math.min(meta.cols - 1, fc + dc));
    selectCell(sel.table, nr, nc, true);
  } else {
    selectCell(sel.table, sel.ar + dr, sel.ac + dc);
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
  if (cell && (cell.k === 'python' || cell.k === 'javascript')) {
    openCodeCell(sel.table, sel.ar, sel.ac);
    return;
  }
  const text = initial !== undefined ? initial : (cell?.i ?? '');
  useStore.setState({ editing: { table: sel.table, r: sel.ar, c: sel.ac, initial: text, replace, source: 'cell' }, editorText: text, selectedTable: null });
  renderer?.markDirty();
}

export function commitEdit(text: string, move: { dr: number; dc: number } | null) {
  const st = getState();
  const ed = st.editing;
  if (!ed) return;
  useStore.setState({ editing: null });
  const prev = cellAt(ed.table, ed.r, ed.c)?.i ?? '';
  if (text !== prev) {
    book.apply({ type: 'set_cell', table: ed.table, row: ed.r, col: ed.c, input: text });
  }
  if (move) moveActive(move.dr, move.dc);
  else selectCell(ed.table, ed.r, ed.c);
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
export function makeCodeCell(kind: CellKind) {
  const sel = getState().selection;
  if (!sel) return;
  const cell = cellAt(sel.table, sel.ar, sel.ac);
  if (cell?.s) {
    setStatus('This cell shows spilled output — pick another cell.');
    return;
  }
  const existing = cell?.i ?? '';
  const template =
    kind === 'python'
      ? existing && cell?.k === 'python'
        ? existing
        : `# Python cell — the last expression is written to the sheet\n# q.cells("A1:B5") reads a range, q.cells("A1") a single value\n`
      : existing && cell?.k === 'javascript'
        ? existing
        : `// JavaScript cell — return a value, a list, or a 2-D array\n// q.cells("A1:B5") reads a range\nreturn 1 + 1;\n`;
  if (!cell || cell.k !== kind) {
    book.apply({ type: 'set_cell', table: sel.table, row: sel.ar, col: sel.ac, input: template, kind });
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

export function addTable(opts: { x?: number; y?: number; rows?: number; cols?: number; name?: string; values?: string[][] } = {}) {
  const st = getState();
  // place below the lowest table by default
  let y = 80;
  let x = 80;
  for (const t of st.tables.values()) {
    const L = layoutOf(t);
    y = Math.max(y, t.y + L.height + 80);
  }
  const ch = book.apply({
    type: 'add_table',
    name: opts.name,
    x: opts.x ?? x,
    y: opts.y ?? y,
    rows: opts.rows ?? 10,
    cols: opts.cols ?? 5,
    values: opts.values,
  });
  const id = ch.created?.[0];
  if (id) {
    useStore.setState({ selectedTable: id });
    selectCell(id, 0, 0);
  }
  return id;
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

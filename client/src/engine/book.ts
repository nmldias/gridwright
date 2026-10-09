// Wrapper around the WASM engine: owns the Book instance, applies ops, and
// patches the zustand store from the engine's change sets.

import init, { Book } from './pkg/gridwright_core';
import wasmUrl from './pkg/gridwright_core_bg.wasm?url';
import type { CellRef, CellValue, CellView, Changes, Chart, CheckView, NamedRange, Op, SignoffStatus, TableId, TableMeta, Trace } from './types';
import { cellKey, isCodeKind } from './types';
import { readOnly, useStore } from '../state/store';

const SIGN_OPS = new Set<Op['type']>(['add_signoff', 'remove_signoff', 'set_signoff_locked']);

/** Where a change came from (recorded in the document's audit log). */
export type Origin = 'user' | 'ai' | 'code' | 'sql' | 'import' | 'remote' | 'system';

export interface ApplyMeta {
  origin: Origin;
  /** short human-readable description for the history (optional) */
  note?: string;
}

type Listener = (op: Op | null, changes: Changes, meta: ApplyMeta) => void;

let book: Book | null = null;
let ready: Promise<void> | null = null;
const opListeners = new Set<Listener>();
const rerunListeners = new Set<(refs: CellRef[]) => void>();
let redrawCb: (() => void) | null = null;

export function onOp(l: Listener) {
  opListeners.add(l);
  return () => opListeners.delete(l);
}
export function onRerun(l: (refs: CellRef[]) => void) {
  rerunListeners.add(l);
  return () => rerunListeners.delete(l);
}
export function setRedraw(cb: () => void) {
  redrawCb = cb;
}
export function requestRedraw() {
  redrawCb?.();
}

export async function ensureEngine(): Promise<void> {
  if (!ready) ready = init({ module_or_path: wasmUrl }).then(() => undefined);
  await ready;
}

export function getBook(): Book {
  if (!book) throw new Error('engine not loaded');
  return book;
}

export function nowSerial(): number {
  return Date.now() / 86400000 + 25569;
}

/** Replace the current workbook with a fresh one or a loaded JSON document. */
export async function loadBook(json: string | null, name = 'Untitled', fileId: string | null = null, opts: { keepView?: boolean } = {}) {
  await ensureEngine();
  if (book) book.free();
  book = json ? Book.from_json(json) : new Book(name);
  book.set_now(nowSerial());
  const metas: TableMeta[] = JSON.parse(book.tables());
  const tables = new Map<TableId, TableMeta>();
  const cells = new Map<TableId, Map<number, CellView>>();
  for (const m of metas) {
    tables.set(m.id, m);
    cells.set(m.id, toCellMap(JSON.parse(book.cells(m.id))));
  }
  const prev = useStore.getState();
  const keep = opts.keepView && prev.selection && tables.has(prev.selection.table);
  useStore.setState({
    ready: true,
    tables,
    cells,
    names: JSON.parse(book.names()) as NamedRange[],
    charts: JSON.parse(book.charts()) as Chart[],
    selectedChart: null,
    trace: null,
    fileName: json ? book.name() : name,
    fileId,
    dirty: false,
    selection: keep ? prev.selection : metas[0] ? { table: metas[0].id, r0: 0, c0: 0, r1: 0, c1: 0, ar: 0, ac: 0 } : null,
    selectedTable: keep ? prev.selectedTable : null,
    editing: null,
    editorText: '',
    canUndo: false,
    canRedo: false,
    runs: new Map(),
  });
  requestRedraw();
  // code cells need their outputs rebuilt after load
  const refs: CellRef[] = [];
  for (const m of metas) {
    for (const c of cells.get(m.id)!.values()) {
      if (isCodeKind(c.k) && !c.s) refs.push({ table: m.id, row: c.r, col: c.c });
    }
  }
  if (refs.length) rerunListeners.forEach((l) => l(refs));
}

function toCellMap(list: CellView[]): Map<number, CellView> {
  const m = new Map<number, CellView>();
  for (const c of list) m.set(cellKey(c.r, c.c), c);
  return m;
}

export function toJson(): string {
  return getBook().to_json();
}

/** Apply an op locally (and notify listeners, e.g. the multiplayer link). */
export function apply(op: Op, opts: { remote?: boolean; silent?: boolean; origin?: Origin; note?: string } = {}): Changes {
  const b = getBook();
  if (!opts.remote && readOnly() && op.type !== 'code_result' && !(useStore.getState().permission === 'sign' && SIGN_OPS.has(op.type))) {
    const msg = useStore.getState().permission === 'sign' ? 'You may sign off on this document but not edit it' : 'This document is read-only for you';
    if (!opts.silent) useStore.setState({ status: msg });
    return { cells: {}, tables: [], reload: [], removed_tables: [], rerun_code: [], created: [], error: msg };
  }
  const changes: Changes = JSON.parse(b.apply(JSON.stringify(op)));
  if (changes.error) {
    if (!opts.silent) useStore.setState({ status: changes.error });
    return changes;
  }
  applyChanges(changes);
  if (!opts.remote) {
    useStore.setState({ dirty: true });
    const meta: ApplyMeta = { origin: opts.origin ?? 'user', note: opts.note };
    opListeners.forEach((l) => l(op, changes, meta));
  }
  return changes;
}

/** Apply an op authored elsewhere (multiplayer): not recorded for local undo. */
export function applyRemote(op: Op): Changes {
  const b = getBook();
  const changes: Changes = JSON.parse(b.apply_remote(JSON.stringify(op)));
  if (!changes.error) applyChanges(changes);
  return changes;
}

export function undo() {
  const changes: Changes = JSON.parse(getBook().undo());
  applyChanges(changes);
  if (!changes.ops?.length) return;
  useStore.setState({ dirty: true });
  // the restore ops travel like any other op, so the other clients replay them in order
  for (const op of changes.ops) opListeners.forEach((l) => l(op, changes, { origin: 'user', note: 'undo' }));
}

export function redo() {
  const changes: Changes = JSON.parse(getBook().redo());
  applyChanges(changes);
  if (!changes.ops?.length) return;
  useStore.setState({ dirty: true });
  for (const op of changes.ops) opListeners.forEach((l) => l(op, changes, { origin: 'user', note: 'redo' }));
}

/** Tell listeners the whole document changed (after a restore/import): multiplayer sends a snapshot. */
export function announceSnapshot(note: string, origin: Origin = 'system') {
  useStore.setState({ dirty: true });
  const empty: Changes = { cells: {}, tables: [], reload: [], removed_tables: [], rerun_code: [], created: [] };
  opListeners.forEach((l) => l(null, empty, { origin, note }));
}

export function applyChanges(changes: Changes) {
  const b = getBook();
  const st = useStore.getState();
  const tables = new Map(st.tables);
  // the outer map gets a new identity (so subscribers notice); inner maps are patched in place
  const cells = new Map(st.cells);
  for (const id of changes.removed_tables) {
    tables.delete(id);
    cells.delete(id);
  }
  for (const m of changes.tables) tables.set(m.id, m);
  for (const id of changes.created) {
    if (!tables.has(id)) {
      const metas: TableMeta[] = JSON.parse(b.tables());
      const m = metas.find((t) => t.id === id);
      if (m) tables.set(id, m);
    }
  }
  for (const id of changes.reload) {
    if (tables.has(id)) cells.set(id, toCellMap(JSON.parse(b.cells(id))));
  }
  for (const [tid, views] of Object.entries(changes.cells)) {
    const id = Number(tid);
    if (!tables.has(id)) continue;
    let m = cells.get(id);
    if (!m) {
      m = new Map();
      cells.set(id, m);
    }
    for (const v of views) {
      const empty = v.i === '' && v.v === null && !v.f && !v.s && !v.err && !v.out;
      if (empty) m.delete(cellKey(v.r, v.c));
      else m.set(cellKey(v.r, v.c), v);
    }
  }
  // keep selection valid
  let selection = st.selection;
  if (selection && !tables.has(selection.table)) {
    const first = tables.values().next().value as TableMeta | undefined;
    selection = first ? { table: first.id, r0: 0, c0: 0, r1: 0, c1: 0, ar: 0, ac: 0 } : null;
  } else if (selection) {
    const t = tables.get(selection.table)!;
    selection = {
      ...selection,
      r0: Math.min(selection.r0, t.rows - 1),
      r1: Math.min(selection.r1, t.rows - 1),
      c0: Math.min(selection.c0, t.cols - 1),
      c1: Math.min(selection.c1, t.cols - 1),
      ar: Math.min(selection.ar, t.rows - 1),
      ac: Math.min(selection.ac, t.cols - 1),
    };
  }
  let selectedTable = st.selectedTable;
  if (selectedTable !== null && !tables.has(selectedTable)) selectedTable = null;
  useStore.setState({
    tables,
    cells,
    selection,
    selectedTable,
    canUndo: b.can_undo(),
    canRedo: b.can_redo(),
    cellsVersion: st.cellsVersion + 1,
    ...(changes.names ? { names: changes.names } : {}),
    ...(changes.charts ? { charts: changes.charts } : {}),
    ...(changes.created_chart ? { selectedChart: changes.created_chart } : {}),
  });
  requestRedraw();
  if (changes.rerun_code.length) rerunListeners.forEach((l) => l(changes.rerun_code));
}

/** Plain values: number | string | boolean | null | {e: "#ERR"} */
export function rangeValues(table: TableId, r0: number, c0: number, r1: number, c1: number): (number | string | boolean | null | { e: string })[][] {
  return JSON.parse(getBook().range_values(table, r0, c0, r1, c1));
}

export function preview(table: TableId, formula: string): CellValue {
  return JSON.parse(getBook().preview(table, formula));
}

/** Evaluate a formula as if it sat in a given cell (conditional-format formulas). */
export function evalAt(table: TableId, row: number, col: number, formula: string): CellValue {
  return JSON.parse(getBook().eval_at(table, row, col, formula));
}

export function shiftFormula(src: string, dr: number, dc: number): string {
  return Book.shift_formula(src, dr, dc);
}

export function shiftFormulaRow(src: string, srcRow: number, dr: number): string {
  return Book.shift_formula_row(src, srcRow, dr);
}

export function tableIdByName(name: string): TableId {
  return getBook().table_id(name);
}

export function engineVersion(): string {
  return Book.version();
}

export function checkValidation(table: TableId, row: number, col: number, input: string): { ok: boolean; message?: string; strict: boolean } {
  return JSON.parse(getBook().check_validation(table, row, col, input));
}

export function listEntries(table: TableId, row: number, col: number): string[] {
  return JSON.parse(getBook().list_entries(table, row, col));
}

export function formatWithEngine(n: number, pattern: string): string {
  return Book.format_number(n, pattern);
}

export function trace(table: TableId, row: number, col: number): Trace {
  return JSON.parse(getBook().trace(table, row, col));
}

export function checks(): CheckView[] {
  return JSON.parse(getBook().checks());
}

export function signoffStatus(table: TableId): SignoffStatus[] {
  return JSON.parse(getBook().signoff_status(table));
}

export function rangeHash(table: TableId, r0: number, c0: number, r1: number, c1: number): string {
  return getBook().range_hash(table, r0, c0, r1, c1);
}

/** Values of a reference text (`Sales::B2:B13`, `Sales[Revenue]`, a name) as a 2-D array, or null when it does not resolve. */
export function resolveValues(table: TableId, reference: string): (number | string | boolean | null | { e: string })[][] | null {
  if (!book || !reference.trim()) return null;
  const out = JSON.parse(book.resolve_values(table, reference));
  return Array.isArray(out) ? out : null;
}

/** Build a throw-away Book from a checkpoint and a list of ops (history replay). */
export async function replayDocument(json: string | null, ops: Op[], name: string): Promise<string> {
  await ensureEngine();
  const b = json ? Book.from_json(json) : new Book(name);
  b.set_now(nowSerial());
  for (const op of ops) b.apply(JSON.stringify(op));
  const out = b.to_json();
  b.free();
  return out;
}

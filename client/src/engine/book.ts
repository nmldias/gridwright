// Wrapper around the WASM engine: owns the Book instance, applies ops, and
// patches the zustand store from the engine's change sets.

import init, { Book } from './pkg/gridwright_core';
import wasmUrl from './pkg/gridwright_core_bg.wasm?url';
import type { CellRef, CellValue, CellView, Changes, Op, TableId, TableMeta } from './types';
import { cellKey } from './types';
import { useStore } from '../state/store';

type Listener = (op: Op | null, changes: Changes) => void;

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
export async function loadBook(json: string | null, name = 'Untitled', fileId: string | null = null) {
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
  useStore.setState({
    ready: true,
    tables,
    cells,
    fileName: json ? book.name() : name,
    fileId,
    dirty: false,
    selection: metas[0] ? { table: metas[0].id, r0: 0, c0: 0, r1: 0, c1: 0, ar: 0, ac: 0 } : null,
    selectedTable: null,
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
      if ((c.k === 'python' || c.k === 'javascript') && !c.s) refs.push({ table: m.id, row: c.r, col: c.c });
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
export function apply(op: Op, opts: { remote?: boolean; silent?: boolean } = {}): Changes {
  const b = getBook();
  const changes: Changes = JSON.parse(b.apply(JSON.stringify(op)));
  if (changes.error) {
    if (!opts.silent) useStore.setState({ status: changes.error });
    return changes;
  }
  applyChanges(changes);
  if (!opts.remote) {
    useStore.setState({ dirty: true });
    opListeners.forEach((l) => l(op, changes));
  }
  return changes;
}

export function undo() {
  const changes: Changes = JSON.parse(getBook().undo());
  applyChanges(changes);
  useStore.setState({ dirty: true });
  opListeners.forEach((l) => l(null, changes));
}

export function redo() {
  const changes: Changes = JSON.parse(getBook().redo());
  applyChanges(changes);
  useStore.setState({ dirty: true });
  opListeners.forEach((l) => l(null, changes));
}

export function applyChanges(changes: Changes) {
  const b = getBook();
  const st = useStore.getState();
  const tables = new Map(st.tables);
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
    const m = new Map(cells.get(id) ?? []);
    for (const v of views) {
      const empty = v.i === '' && v.v === null && !v.f && !v.s && !v.err && !v.out;
      if (empty) m.delete(cellKey(v.r, v.c));
      else m.set(cellKey(v.r, v.c), v);
    }
    cells.set(id, m);
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

export function shiftFormula(src: string, dr: number, dc: number): string {
  return Book.shift_formula(src, dr, dc);
}

export function tableIdByName(name: string): TableId {
  return getBook().table_id(name);
}

export function engineVersion(): string {
  return Book.version();
}

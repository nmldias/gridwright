// Orchestrates code-cell execution: builds a workbook snapshot, dispatches to
// the Python or JavaScript worker, and writes results back through the engine.

import * as book from '../engine/book';
import type { CellRef, CellValue, Rect } from '../engine/types';
import { cellAt, getState, useStore } from '../state/store';
import type { Plain, Snapshot } from './q';
import JsWorker from './js.worker?worker';
import PyWorker from './python.worker?worker';

const PY_INDEX_KEY = 'gridwright.pyodideIndexURL';
export const DEFAULT_PYODIDE_INDEX = 'https://cdn.jsdelivr.net/pyodide/v0.27.5/full/';

export function pyodideIndexURL(): string {
  try {
    return localStorage.getItem(PY_INDEX_KEY) || (window as any).__GRIDWRIGHT_PYODIDE__ || DEFAULT_PYODIDE_INDEX;
  } catch {
    return DEFAULT_PYODIDE_INDEX;
  }
}
export function setPyodideIndexURL(url: string) {
  try {
    localStorage.setItem(PY_INDEX_KEY, url);
  } catch {
    /* ignore */
  }
}

let jsWorker: Worker | null = null;
let pyWorker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, CellRef>();
const queue = new Map<string, CellRef>();
const lastRun = new Map<string, number[]>();
let flushTimer: number | null = null;

const keyOf = (r: CellRef) => `${r.table}:${r.row}:${r.col}`;

function toCellValue(p: Plain): CellValue {
  if (p === null || p === undefined) return null;
  if (typeof p === 'number') return { n: p };
  if (typeof p === 'boolean') return { b: p };
  return { s: String(p) };
}

function handleResult(e: MessageEvent) {
  const d = e.data;
  if (d.type === 'ready') {
    useStore.setState({ pythonStatus: 'ready' });
    return;
  }
  if (d.type === 'init-error') {
    useStore.setState({ pythonStatus: 'error', status: `Python runtime failed to load: ${d.error}` });
    return;
  }
  const ref = pending.get(d.id);
  if (!ref) return;
  pending.delete(d.id);
  const runs = new Map(getState().runs);
  runs.delete(keyOf(ref));
  useStore.setState({ runs });
  const cell = cellAt(ref.table, ref.row, ref.col);
  if (!cell || (cell.k !== 'python' && cell.k !== 'javascript')) return; // cell changed meanwhile
  const deps: Rect[] = (d.deps ?? []).map((x: Rect) => ({ table: x.table, r0: x.r0, c0: x.c0, r1: x.r1, c1: x.c1 }));
  if (d.ok) {
    const output: CellValue[][] | null = d.output ? (d.output as Plain[][]).map((row) => row.map(toCellValue)) : null;
    book.apply({ type: 'code_result', table: ref.table, row: ref.row, col: ref.col, output, std_out: d.std_out || null, std_err: null, deps });
  } else {
    book.apply({ type: 'code_result', table: ref.table, row: ref.row, col: ref.col, output: null, std_out: d.std_out || null, std_err: d.error || 'error', deps });
  }
}

function getJsWorker(): Worker {
  if (!jsWorker) {
    jsWorker = new JsWorker();
    jsWorker.onmessage = handleResult;
    jsWorker.onerror = (e) => useStore.setState({ status: `JavaScript worker error: ${e.message}` });
  }
  return jsWorker;
}

export function getPyWorker(): Worker {
  if (!pyWorker) {
    pyWorker = new PyWorker();
    pyWorker.onmessage = handleResult;
    pyWorker.onerror = (e) => useStore.setState({ status: `Python worker error: ${e.message}`, pythonStatus: 'error' });
    useStore.setState({ pythonStatus: 'loading' });
    pyWorker.postMessage({ type: 'init', indexURL: pyodideIndexURL() });
  }
  return pyWorker;
}

/** Restart the Python runtime (e.g. after changing the Pyodide URL). */
export function resetPython() {
  pyWorker?.terminate();
  pyWorker = null;
  useStore.setState({ pythonStatus: 'idle' });
}

export function buildSnapshot(current: CellRef): Snapshot {
  const st = getState();
  const tables = Array.from(st.tables.values()).map((t) => ({
    id: t.id,
    name: t.name,
    rows: t.rows,
    cols: t.cols,
    // range_values returns plain JSON (numbers, strings, booleans, null, {"e": "#ERR"})
    values: (book.rangeValues(t.id, 0, 0, t.rows - 1, t.cols - 1) as unknown as (Plain | { e: string })[][]).map((row) =>
      row.map((v) => (v !== null && typeof v === 'object' && 'e' in v ? v.e : (v as Plain))),
    ),
  }));
  return { tables, current: { table: current.table, row: current.row, col: current.col } };
}

export function runCell(ref: CellRef) {
  const cell = cellAt(ref.table, ref.row, ref.col);
  if (!cell || (cell.k !== 'python' && cell.k !== 'javascript')) return;
  // loop guard: at most 6 runs per cell per 10 s
  const k = keyOf(ref);
  const now = Date.now();
  const hist = (lastRun.get(k) ?? []).filter((t) => now - t < 10000);
  if (hist.length >= 6) {
    useStore.setState({ status: `Code cell ${k} re-ran too often — check for a dependency loop.` });
    return;
  }
  hist.push(now);
  lastRun.set(k, hist);
  const id = nextId++;
  pending.set(id, ref);
  const runs = new Map(getState().runs);
  runs.set(k, { running: true, startedAt: now });
  useStore.setState({ runs });
  const snapshot = buildSnapshot(ref);
  const worker = cell.k === 'python' ? getPyWorker() : getJsWorker();
  worker.postMessage({ type: 'run', id, code: cell.i, snapshot });
}

export function scheduleRuns(refs: CellRef[]) {
  for (const r of refs) queue.set(keyOf(r), r);
  if (flushTimer === null) {
    flushTimer = window.setTimeout(() => {
      flushTimer = null;
      const items = Array.from(queue.values());
      queue.clear();
      items.forEach(runCell);
    }, 30);
  }
}

export function installRunner() {
  return book.onRerun(scheduleRuns);
}

// Orchestrates code-cell execution: builds a workbook snapshot, dispatches to
// the Python or JavaScript worker, and writes results back through the engine.

import { api, type SqlParam } from '../api/client';
import { getClientId } from '../api/ws';
import * as book from '../engine/book';
import { isCodeKind, parseA1, type CellRef, type CellValue, type Rect } from '../engine/types';
import { cellAt, getState, useStore } from '../state/store';
import type { Plain, Snapshot } from './q';
import JsWorker from './js.worker?worker';
import PyWorker from './python.worker?worker';
import { fnv, inputsHashFromSnapshot, outputHash, record as recordRun, type RunRecord, type RunRuntime } from './runs';

const PY_INDEX_KEY = 'gridwright.pyodideIndexURL';
export const DEFAULT_PYODIDE_INDEX = 'https://cdn.jsdelivr.net/pyodide/v0.27.5/full/';
/** Set when the server reports a self-hosted Pyodide at /pyodide/ (used unless the user chose a URL). */
export let localPyodideIndex: string | null = null;
export function setLocalPyodide(available: boolean) {
  localPyodideIndex = available ? `${location.origin}/pyodide/` : null;
}

export function pyodideIndexURL(): string {
  try {
    return localStorage.getItem(PY_INDEX_KEY) || (window as any).__GRIDWRIGHT_PYODIDE__ || localPyodideIndex || DEFAULT_PYODIDE_INDEX;
  } catch {
    return localPyodideIndex || DEFAULT_PYODIDE_INDEX;
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
const started = new Map<number, number>();
/** the snapshot each run was given: inputs are hashed from it, never from the live sheet */
const snapshots = new Map<number, Snapshot>();
/** the newest run id per cell: results of superseded runs are dropped */
const latest = new Map<string, number>();
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
  const t0 = started.get(d.id) ?? Date.now();
  started.delete(d.id);
  const snapshot = snapshots.get(d.id);
  snapshots.delete(d.id);
  const key = keyOf(ref);
  if (latest.get(key) !== d.id) return; // a newer run of this cell started meanwhile: this result is superseded
  const runs = new Map(getState().runs);
  runs.delete(key);
  useStore.setState({ runs });
  const cell = cellAt(ref.table, ref.row, ref.col);
  if (!cell || !isCodeKind(cell.k)) return; // cell changed meanwhile
  if (fnv(cell.i) !== fnv(d.code ?? cell.i)) return; // the code changed while this ran: its result is not the current code's
  const deps: Rect[] = (d.deps ?? []).map((x: Rect) => ({ table: x.table, r0: x.r0, c0: x.c0, r1: x.r1, c1: x.c1 }));
  const runtime: RunRuntime = d.runtime ?? { name: cell.k, version: '', packages: {} };
  // the record binds the code that ran, the inputs it was given (from its snapshot) and the output it produced
  const inHash = snapshot ? inputsHashFromSnapshot(snapshot, deps) : d.inputsHash ?? fnv('');
  const finishRecord = (ok: boolean, output: CellValue[][] | null, error?: string) =>
    recordRun(
      d.record
        ? { ...(d.record as RunRecord), deps, runtime, attested: 'server' }
        : {
            table: ref.table,
            row: ref.row,
            col: ref.col,
            kind: cell.k,
            codeHash: fnv(cell.i),
            inputsHash: inHash,
            deps,
            outputHash: outputHash(output),
            ok,
            error,
            ms: Date.now() - t0,
            runtime,
            at: new Date().toISOString(),
            startedAt: new Date(t0).toISOString(),
            attested: 'client',
          },
    );
  if (d.ok) {
    let output: CellValue[][] | null;
    if (d.output && !Array.isArray(d.output) && typeof d.output === 'object' && typeof d.output.image === 'string') {
      // a picture: reserve a block of cells roughly matching its pixel size (100×24 px cells)
      const meta = getState().tables.get(ref.table);
      const avgW = meta && meta.cols ? meta.col_widths.reduce((a, b) => a + b, 0) / meta.cols : 100;
      const avgH = meta && meta.rows ? meta.row_heights.reduce((a, b) => a + b, 0) / meta.rows : 24;
      const cols = Math.max(2, Math.min(40, Math.ceil((d.output.width || 640) / avgW)));
      const rows = Math.max(2, Math.min(200, Math.ceil((d.output.height || 480) / avgH)));
      output = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => (r === 0 && c === 0 ? { s: d.output.image as string } : null)));
    } else {
      output = d.output ? (d.output as Plain[][]).map((row) => row.map(toCellValue)) : null;
    }
    book.apply({ type: 'code_result', table: ref.table, row: ref.row, col: ref.col, output, std_out: d.std_out || null, std_err: null, deps }, { origin: 'code' });
    finishRecord(true, output);
  } else {
    book.apply({ type: 'code_result', table: ref.table, row: ref.row, col: ref.col, output: null, std_out: d.std_out || null, std_err: d.error || 'error', deps }, { origin: 'code' });
    finishRecord(false, null, String(d.error || 'error').slice(0, 500));
  }
}

// --- SQL cells ---------------------------------------------------------------------------
// `{{A1}}` / `{{Orders::B2}}` become bound parameters; a range expands to a list (`IN ({{A2:A9}})`).
export function prepareSql(sql: string, current: CellRef): { text: string; params: SqlParam[]; deps: Rect[]; error?: string } {
  const params: SqlParam[] = [];
  const deps: Rect[] = [];
  let error: string | undefined;
  const st = getState();
  const text = sql.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, ref: string) => {
    const p = parseA1(ref);
    if (!p) {
      error = `bad reference {{${ref}}}`;
      return 'NULL';
    }
    const table = p.table ? book.tableIdByName(p.table) : current.table;
    if (!table) {
      error = `table "${p.table}" not found`;
      return 'NULL';
    }
    const meta = st.tables.get(table)!;
    const r1 = Math.min(p.r1, meta.rows - 1);
    const c1 = Math.min(p.c1, meta.cols - 1);
    deps.push({ table, r0: p.r0, c0: p.c0, r1, c1 });
    const vals = book.rangeValues(table, p.r0, p.c0, r1, c1).flat().map((v) => (v !== null && typeof v === 'object' ? null : v));
    if (vals.length === 1) {
      params.push(vals[0]);
      return '?';
    }
    for (const v of vals) params.push(v);
    return vals.map(() => '?').join(', ') || 'NULL';
  });
  return { text, params, deps, error };
}

async function runSqlCell(ref: CellRef, id: number, code: string, conn: string | undefined) {
  const finish = (d: any) => handleResult({ data: { id, ...d } } as MessageEvent);
  if (!conn) {
    finish({ ok: false, error: 'choose a connection for this SQL cell', deps: [] });
    return;
  }
  const prep = prepareSql(code, ref);
  if (prep.error) {
    finish({ ok: false, error: prep.error, deps: prep.deps });
    return;
  }
  const runtime: RunRuntime = { name: 'sql', version: '', packages: { connection: conn } };
  try {
    const res = await api.connections.query(conn, prep.text, 5000, prep.params);
    const output: Plain[][] = [res.columns, ...res.rows];
    finish({ ok: true, output, std_out: `${res.rows.length} row${res.rows.length === 1 ? '' : 's'} in ${res.ms} ms${res.truncated ? ' (truncated to the row limit)' : ''}`, deps: prep.deps, runtime });
  } catch (e) {
    finish({ ok: false, error: (e as Error).message, deps: prep.deps, runtime });
  }
}

// --- Python on the server -------------------------------------------------------------------
// Same snapshot the browser worker gets, same `q` API, same output shape; the run record says
// "python-server" with the sandbox level and the packages the host used.
async function runServerPython(ref: CellRef, id: number, code: string, gpu: boolean, snapshot: Snapshot, startedAt: number) {
  const finish = (d: any) => handleResult({ data: { id, code, ...d } } as MessageEvent);
  try {
    // the server computes and logs the record itself (attested: server) when it knows which cell this is
    const st = getState();
    const cellRef = st.fileId ? { file: st.fileId, table: ref.table, row: ref.row, col: ref.col, kind: 'python', startedAt: new Date(startedAt).toISOString(), client: getClientId() } : undefined;
    const res = await api.python.run(code, snapshot, gpu, cellRef);
    const runtime: RunRuntime = res.runtime ?? { name: 'python-server', version: '', packages: {} };
    if (res.ok) finish({ ok: true, output: res.output ?? null, std_out: res.std_out, deps: res.deps, runtime, record: res.record });
    else finish({ ok: false, error: res.error || 'error', std_out: res.std_out, deps: res.deps, runtime, record: res.record });
  } catch (e) {
    finish({ ok: false, error: (e as Error).message, deps: [], runtime: { name: 'python-server', version: '', packages: {} } });
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
  if (!cell || !isCodeKind(cell.k)) return;
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
  started.set(id, now);
  latest.set(k, id);
  const runs = new Map(getState().runs);
  runs.set(k, { running: true, startedAt: now });
  useStore.setState({ runs });
  if (cell.k === 'sql') {
    void runSqlCell(ref, id, cell.i, cell.conn);
    return;
  }
  const snapshot = buildSnapshot(ref);
  snapshots.set(id, snapshot);
  if (cell.k === 'python' && cell.runtime === 'server') {
    void runServerPython(ref, id, cell.i, !!cell.gpu, snapshot, now);
    return;
  }
  const worker = cell.k === 'python' ? getPyWorker() : getJsWorker();
  worker.postMessage({ type: 'run', id, code: cell.i, snapshot });
}

/** Periodic refresh of code/SQL cells that asked for it (`refresh` seconds). */
const lastFinished = new Map<string, number>();
export function installRefreshScheduler(): () => void {
  const timer = window.setInterval(() => {
    const st = getState();
    if (document.hidden) return;
    const now = Date.now();
    for (const [tid, map] of st.cells) {
      for (const c of map.values()) {
        if (!isCodeKind(c.k) || !c.refresh || c.s) continue;
        const key = `${tid}:${c.r}:${c.c}`;
        if (st.runs.get(key)?.running) continue;
        const last = lastFinished.get(key) ?? 0;
        if (now - last >= c.refresh * 1000) {
          lastFinished.set(key, now);
          lastRun.delete(key); // periodic runs are not loops
          runCell({ table: tid, row: c.r, col: c.c });
        }
      }
    }
  }, 2000);
  return () => window.clearInterval(timer);
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

// Run records: every execution of a Python / JavaScript / SQL cell is described by the hash of
// the code, the hash of the values it read (taken from the snapshot the run was given, never from
// the live sheet), the runtime (and its package versions) and the hash of the output. Server-side
// runs are recorded by the server itself ("attested: server"); browser runs are the client's own
// statement ("attested: client"). The Review panel compares the record with what is on screen:
// code, inputs and the displayed output must all match for a result to count as the recorded run.

import * as book from '../engine/book';
import type { CellRef, CellValue, Rect } from '../engine/types';
import { getState, useStore } from '../state/store';
import type { Plain, Snapshot } from './q';

export interface RunRuntime {
  name: string; // pyodide | javascript | sql
  version: string;
  packages: Record<string, string>;
}

export interface RunRecord {
  table: number;
  row: number;
  col: number;
  kind: string;
  codeHash: string;
  inputsHash: string;
  deps: Rect[];
  outputHash: string;
  ok: boolean;
  error?: string;
  ms: number;
  runtime: RunRuntime;
  at: string;
  /** when the run started: a result from an older start never replaces a newer one */
  startedAt?: string;
  /** who computed the hashes */
  attested?: 'server' | 'client';
  /** log position once the server recorded it */
  seq?: number;
}

export type RunStatus = 'matches' | 'inputs-changed' | 'code-changed' | 'output-changed' | 'failed' | 'not-run';

const keyOf = (r: CellRef) => `${r.table}:${r.row}:${r.col}`;
const records = new Map<string, RunRecord>();
const listeners = new Set<(r: RunRecord) => void>();

/** FNV-1a over a string, 64-bit, hex — the same scheme the engine uses for sign-offs. */
export function fnv(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/** Canonical plain value for hashing: errors become their text, exactly as the runtimes see them. */
const canon = (v: unknown): Plain => (v !== null && typeof v === 'object' && 'e' in (v as object) ? String((v as { e: string }).e) : (v as Plain));

/**
 * Hash of the values a cell read, from the snapshot the run was given (immutable for the run's
 * whole duration). The server computes the same hash with the same rules for server-side runs.
 */
export function inputsHashFromSnapshot(snapshot: Snapshot, deps: Rect[]): string {
  const parts: string[] = [];
  for (const d of deps) {
    const t = snapshot.tables.find((x) => x.id === d.table);
    if (!t) {
      parts.push(`${d.table}:missing`);
      continue;
    }
    const r1 = Math.min(d.r1, t.rows - 1);
    const c1 = Math.min(d.c1, t.cols - 1);
    if (r1 < d.r0 || c1 < d.c0) continue;
    const area = (r1 - d.r0 + 1) * (c1 - d.c0 + 1);
    if (area > 2_000_000) {
      parts.push(`${d.table}:${d.r0},${d.c0}-${r1},${c1}:too-large`);
      continue;
    }
    const rows: Plain[][] = [];
    for (let r = d.r0; r <= r1; r++) {
      const row: Plain[] = [];
      for (let c = d.c0; c <= c1; c++) row.push(canon(t.values[r]?.[c] ?? null));
      rows.push(row);
    }
    parts.push(`${d.table}:${d.r0},${d.c0}-${r1},${c1}:` + JSON.stringify(rows));
  }
  return fnv(parts.join('|'));
}

/** The same hash over the live sheet — what the inputs are *now*, to compare with a record. */
export function inputsHash(deps: Rect[]): string {
  const st = getState();
  const parts: string[] = [];
  for (const d of deps) {
    const meta = st.tables.get(d.table);
    if (!meta) {
      parts.push(`${d.table}:missing`);
      continue;
    }
    const r1 = Math.min(d.r1, meta.rows - 1);
    const c1 = Math.min(d.c1, meta.cols - 1);
    if (r1 < d.r0 || c1 < d.c0) continue;
    const area = (r1 - d.r0 + 1) * (c1 - d.c0 + 1);
    if (area > 2_000_000) {
      parts.push(`${d.table}:${d.r0},${d.c0}-${r1},${c1}:too-large`);
      continue;
    }
    const rows = (book.rangeValues(d.table, d.r0, d.c0, r1, c1) as unknown[][]).map((row) => row.map(canon));
    parts.push(`${d.table}:${d.r0},${d.c0}-${r1},${c1}:` + JSON.stringify(rows));
  }
  return fnv(parts.join('|'));
}

/** Hash of an output grid; a picture is hashed by its image data, whatever block it occupies. */
export function outputHash(output: CellValue[][] | null): string {
  if (!output) return fnv('');
  const first = output[0]?.[0];
  if (first && 's' in first && first.s.startsWith('data:image/')) return fnv('image:' + first.s);
  return fnv(JSON.stringify(output));
}

/** The output as it is on screen now: the cell's value plus its spilled block, in the recorded shape. */
export function displayedOutputHash(ref: CellRef): string {
  const st = getState();
  const map = st.cells.get(ref.table);
  const cell = map?.get(ref.row * 65536 + ref.col);
  if (!cell || cell.v === null || cell.v === undefined) return fnv('');
  if ('s' in cell.v && cell.v.s.startsWith('data:image/')) return fnv('image:' + cell.v.s);
  const rows = cell.ss?.[0] ?? 1;
  const cols = cell.ss?.[1] ?? 1;
  const grid: CellValue[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: CellValue[] = [];
    for (let c = 0; c < cols; c++) row.push(map?.get((ref.row + r) * 65536 + ref.col + c)?.v ?? null);
    grid.push(row);
  }
  return fnv(JSON.stringify(grid));
}

export function record(r: RunRecord) {
  // a result from an older start never replaces a newer record
  const prev = records.get(keyOf(r));
  if (prev?.startedAt && r.startedAt && r.startedAt < prev.startedAt) return;
  records.set(keyOf(r), r);
  useStore.setState({ runsVersion: (getState().runsVersion ?? 0) + 1 });
  listeners.forEach((l) => l(r));
}

export function onRecord(l: (r: RunRecord) => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function lastRecord(ref: CellRef): RunRecord | undefined {
  return records.get(keyOf(ref));
}

export function clearRecords() {
  records.clear();
}

/**
 * Does the output on screen correspond to the recorded run of the current code and inputs?
 * Three things must hold: the code is the recorded code, the inputs are the recorded inputs, and
 * the displayed output is the recorded output. Anything else is named for what changed.
 */
export function statusOf(ref: CellRef, code: string): { status: RunStatus; record?: RunRecord } {
  const r = records.get(keyOf(ref));
  if (!r) return { status: 'not-run' };
  if (!r.ok) return { status: 'failed', record: r };
  if (fnv(code) !== r.codeHash) return { status: 'code-changed', record: r };
  if (inputsHash(r.deps) !== r.inputsHash) return { status: 'inputs-changed', record: r };
  if (displayedOutputHash(ref) !== r.outputHash) return { status: 'output-changed', record: r };
  return { status: 'matches', record: r };
}

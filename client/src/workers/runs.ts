// Run records: every execution of a Python / JavaScript / SQL cell is described by the hash of
// the code, the hash of the values it read, the runtime (and its package versions) and the hash
// of the output. The record goes to the document's audit log (when the document is saved) and is
// kept here so the Review panel can show whether the output on screen is the verified result of
// the current code and inputs.

import * as book from '../engine/book';
import type { CellRef, CellValue, Rect } from '../engine/types';
import { getState, useStore } from '../state/store';

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
  /** log position once the server recorded it */
  seq?: number;
}

export type RunStatus = 'verified' | 'inputs-changed' | 'code-changed' | 'failed' | 'not-run';

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

/** Hash of the values a cell read (its dependency rectangles, clipped to the tables). */
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
    parts.push(`${d.table}:${d.r0},${d.c0}-${r1},${c1}:` + JSON.stringify(book.rangeValues(d.table, d.r0, d.c0, r1, c1)));
  }
  return fnv(parts.join('|'));
}

export function outputHash(output: CellValue[][] | null): string {
  return fnv(output ? JSON.stringify(output) : '');
}

export function record(r: RunRecord) {
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

/** Is the output on screen the verified result of the current code and inputs? */
export function statusOf(ref: CellRef, code: string): { status: RunStatus; record?: RunRecord } {
  const r = records.get(keyOf(ref));
  if (!r) return { status: 'not-run' };
  if (!r.ok) return { status: 'failed', record: r };
  if (fnv(code) !== r.codeHash) return { status: 'code-changed', record: r };
  if (inputsHash(r.deps) !== r.inputsHash) return { status: 'inputs-changed', record: r };
  return { status: 'verified', record: r };
}

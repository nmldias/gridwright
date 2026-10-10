// Execution evidence computed by the server for the runs it executes: the same hashes the browser
// computes for its own runs (FNV-1a over canonical JSON), so a record from either runtime can be
// compared with what a sheet shows. Inputs are hashed from the snapshot the run was given, never
// from live state; the output is hashed in the shape the client writes into the sheet.

import type { Snapshot } from './pyrun.js';

type Plain = null | number | string | boolean;
type CellValue = null | { n: number } | { s: string } | { b: boolean };

/** FNV-1a, 64-bit as two 32-bit lanes, hex — identical to the client's and the engine's. */
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

const canon = (v: unknown): Plain => (v !== null && typeof v === 'object' && 'e' in (v as object) ? String((v as { e: string }).e) : (v as Plain));

export function inputsHashFromSnapshot(snapshot: Snapshot, deps: { table: number; r0: number; c0: number; r1: number; c1: number }[]): string {
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
      for (let c = d.c0; c <= c1; c++) row.push(canon((t.values[r] as unknown[] | undefined)?.[c] ?? null));
      rows.push(row);
    }
    parts.push(`${d.table}:${d.r0},${d.c0}-${r1},${c1}:` + JSON.stringify(rows));
  }
  return fnv(parts.join('|'));
}

const toCellValue = (p: unknown): CellValue => {
  if (p === null || p === undefined) return null;
  if (typeof p === 'number') return { n: p };
  if (typeof p === 'boolean') return { b: p };
  return { s: String(p) };
};

/** Hash of a runner output in the shape the sheet will hold it (a picture by its image data). */
export function outputHashOf(output: unknown): string {
  if (output === null || output === undefined) return fnv('');
  if (!Array.isArray(output) && typeof output === 'object' && typeof (output as { image?: unknown }).image === 'string') {
    return fnv('image:' + (output as { image: string }).image);
  }
  const grid = (output as unknown[][]).map((row) => (Array.isArray(row) ? row : [row]).map(toCellValue));
  return fnv(JSON.stringify(grid));
}

// The `q` data-access object used inside code cells (both workers), working on
// a snapshot of the workbook taken right before the run.

import { parseA1 } from '../engine/types';

export type Plain = null | number | string | boolean;

export interface SnapshotTable {
  id: number;
  name: string;
  rows: number;
  cols: number;
  values: Plain[][];
}

export interface Snapshot {
  tables: SnapshotTable[];
  current: { table: number; row: number; col: number };
}

export interface DepRect {
  table: number;
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export interface CellsResult {
  values: Plain[][];
  rect: DepRect;
  rows: number;
  cols: number;
}

export class QError extends Error {}

export function makeQ(snapshot: Snapshot) {
  const deps: DepRect[] = [];
  const byName = new Map(snapshot.tables.map((t) => [t.name.trim().toLowerCase(), t]));
  const byId = new Map(snapshot.tables.map((t) => [t.id, t]));

  function tableFor(name?: string): SnapshotTable {
    if (name === undefined) {
      const t = byId.get(snapshot.current.table);
      if (!t) throw new QError('current table not found');
      return t;
    }
    const t = byName.get(name.trim().toLowerCase());
    if (!t) throw new QError(`table "${name}" not found (tables: ${snapshot.tables.map((x) => x.name).join(', ')})`);
    return t;
  }

  function cellsRaw(ref: string): CellsResult {
    const p = parseA1(ref);
    if (!p) throw new QError(`bad reference "${ref}" — use A1, A1:B5 or "Table 2::A1:B5"`);
    const t = tableFor(p.table);
    const r1 = Math.min(p.r1, t.rows - 1);
    const c1 = Math.min(p.c1, t.cols - 1);
    if (p.r0 >= t.rows || p.c0 >= t.cols) throw new QError(`reference "${ref}" is outside table "${t.name}" (${t.rows}×${t.cols})`);
    const values: Plain[][] = [];
    for (let r = p.r0; r <= r1; r++) {
      const row: Plain[] = [];
      for (let c = p.c0; c <= c1; c++) row.push(t.values[r]?.[c] ?? null);
      values.push(row);
    }
    deps.push({ table: t.id, r0: p.r0, c0: p.c0, r1, c1 });
    return { values, rect: { table: t.id, r0: p.r0, c0: p.c0, r1, c1 }, rows: r1 - p.r0 + 1, cols: c1 - p.c0 + 1 };
  }

  function tableRaw(name?: string): CellsResult {
    const t = tableFor(name);
    deps.push({ table: t.id, r0: 0, c0: 0, r1: t.rows - 1, c1: t.cols - 1 });
    return { values: t.values, rect: { table: t.id, r0: 0, c0: 0, r1: t.rows - 1, c1: t.cols - 1 }, rows: t.rows, cols: t.cols };
  }

  const q = {
    /** Values of a range: scalar for one cell, array for one row/column, 2-D array otherwise. */
    cells(ref: string): Plain | Plain[] | Plain[][] {
      const r = cellsRaw(ref);
      if (r.rows === 1 && r.cols === 1) return r.values[0][0];
      if (r.cols === 1) return r.values.map((row) => row[0]);
      if (r.rows === 1) return r.values[0];
      return r.values;
    },
    /** All values of a table (2-D array), current table when no name is given. */
    table(name?: string): Plain[][] {
      return tableRaw(name).values;
    },
    /** Rows of a table as objects keyed by the header row. */
    records(name?: string): Record<string, Plain>[] {
      const v = tableRaw(name).values;
      if (!v.length) return [];
      const header = v[0].map((h, i) => (h === null || h === '' ? `col${i + 1}` : String(h)));
      return v.slice(1).map((row) => Object.fromEntries(header.map((h, i) => [h, row[i] ?? null])));
    },
    names(): string[] {
      return snapshot.tables.map((t) => t.name);
    },
    pos() {
      return { ...snapshot.current };
    },
    _raw: cellsRaw,
    _table: tableRaw,
    deps,
  };
  return q;
}

/** Convert a JavaScript value into a 2-D grid of plain values for the sheet. */
export function toGrid(v: unknown): Plain[][] | null {
  if (v === undefined || v === null) return null;
  const plain = (x: unknown): Plain => {
    if (x === null || x === undefined) return null;
    if (typeof x === 'number') return Number.isFinite(x) ? x : null;
    if (typeof x === 'boolean' || typeof x === 'string') return x;
    if (typeof x === 'bigint') return Number(x);
    if (x instanceof Date) return x.toISOString().slice(0, 10);
    if (typeof x === 'object') return JSON.stringify(x);
    return String(x);
  };
  if (Array.isArray(v)) {
    if (v.length === 0) return [[null]];
    if (v.every((r) => Array.isArray(r))) return (v as unknown[][]).map((r) => r.map(plain));
    if (v.every((r) => r !== null && typeof r === 'object' && !Array.isArray(r) && !(r instanceof Date))) {
      // array of records → header + rows
      const keys: string[] = [];
      for (const r of v as Record<string, unknown>[]) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
      return [keys, ...(v as Record<string, unknown>[]).map((r) => keys.map((k) => plain(r[k])))];
    }
    return v.map((x) => [plain(x)]);
  }
  if (v instanceof Map) return Array.from(v.entries()).map(([k, val]) => [plain(k), plain(val)]);
  if (typeof v === 'object' && !(v instanceof Date)) {
    return Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, plain(val)]);
  }
  return [[plain(v)]];
}

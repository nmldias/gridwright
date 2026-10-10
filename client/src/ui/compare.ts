// Diff two document JSON strings (as produced by the engine) cell by cell.

import { a1 } from '../engine/types';

export interface DiffLine {
  kind: 'added' | 'removed' | 'changed';
  where: string;
  before: string;
  after: string;
  table?: number;
  row?: number;
  col?: number;
}

export interface VersionDiff {
  a: number;
  b: number;
  lines: DiffLine[];
  truncated: boolean;
}

interface DocCell {
  input?: string;
  value?: unknown;
  spill_from?: unknown;
}
interface DocTable {
  id: number;
  name: string;
  rows: number;
  cols: number;
  cells: { r: number; c: number; cell: DocCell }[];
  signoffs?: { id: number; by: string; r0: number; c0: number; r1: number; c1: number }[];
}
interface Doc {
  tables: DocTable[];
  charts?: { id: number; title: string; kind: string }[];
  names?: { name: string; reference: string }[];
}

const MAX = 500;

function displayValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('n' in o) return String(o.n);
    if ('s' in o) return String(o.s);
    if ('b' in o) return o.b ? 'TRUE' : 'FALSE';
    if ('e' in o) return String(o.e);
  }
  return String(v);
}

function cellText(c: DocCell | undefined): string {
  if (!c) return '';
  if (c.input) return c.input;
  if (c.spill_from) return `↳ ${displayValue(c.value)}`;
  return displayValue(c.value);
}

export function diffDocuments(jsonA: string, jsonB: string, a: number, b: number): VersionDiff {
  const A = JSON.parse(jsonA) as Doc;
  const B = JSON.parse(jsonB) as Doc;
  const lines: DiffLine[] = [];
  const tablesA = new Map(A.tables.map((t) => [t.id, t]));
  const tablesB = new Map(B.tables.map((t) => [t.id, t]));
  for (const [id, ta] of tablesA) {
    const tb = tablesB.get(id);
    if (!tb) {
      lines.push({ kind: 'removed', where: ta.name, before: `table ${ta.rows}×${ta.cols}`, after: '' });
      continue;
    }
    if (ta.name !== tb.name) lines.push({ kind: 'changed', where: ta.name, before: ta.name, after: tb.name });
    if (ta.rows !== tb.rows || ta.cols !== tb.cols) lines.push({ kind: 'changed', where: tb.name, before: `${ta.rows}×${ta.cols}`, after: `${tb.rows}×${tb.cols}` });
    const mapA = new Map((ta.cells ?? []).map((e) => [e.r * 65536 + e.c, e.cell]));
    const mapB = new Map((tb.cells ?? []).map((e) => [e.r * 65536 + e.c, e.cell]));
    const keys = new Set([...mapA.keys(), ...mapB.keys()]);
    for (const k of keys) {
      const ca = mapA.get(k);
      const cb = mapB.get(k);
      const va = cellText(ca);
      const vb = cellText(cb);
      if (va === vb) continue;
      const r = Math.floor(k / 65536);
      const c = k % 65536;
      const where = `${tb.name}::${a1(r, c)}`;
      lines.push({ kind: !ca ? 'added' : !cb ? 'removed' : 'changed', where, before: va, after: vb, table: id, row: r, col: c });
      if (lines.length >= MAX) break;
    }
    const sa = new Map((ta.signoffs ?? []).map((s) => [s.id, s]));
    const sb = new Map((tb.signoffs ?? []).map((s) => [s.id, s]));
    for (const [sid, s] of sb) if (!sa.has(sid)) lines.push({ kind: 'added', where: `${tb.name} sign-off`, before: '', after: `${s.by} ${a1(s.r0, s.c0)}:${a1(s.r1, s.c1)}` });
    for (const [sid, s] of sa) if (!sb.has(sid)) lines.push({ kind: 'removed', where: `${tb.name} sign-off`, before: `${s.by} ${a1(s.r0, s.c0)}:${a1(s.r1, s.c1)}`, after: '' });
    if (lines.length >= MAX) break;
  }
  for (const [id, tb] of tablesB) if (!tablesA.has(id)) lines.push({ kind: 'added', where: tb.name, before: '', after: `table ${tb.rows}×${tb.cols}` });
  const ca = new Map((A.charts ?? []).map((c) => [c.id, c]));
  const cb = new Map((B.charts ?? []).map((c) => [c.id, c]));
  for (const [id, c] of cb) if (!ca.has(id)) lines.push({ kind: 'added', where: 'chart', before: '', after: c.title || c.kind });
  for (const [id, c] of ca) if (!cb.has(id)) lines.push({ kind: 'removed', where: 'chart', before: c.title || c.kind, after: '' });
  const na = new Map((A.names ?? []).map((n) => [n.name, n.reference]));
  const nb = new Map((B.names ?? []).map((n) => [n.name, n.reference]));
  for (const [n, ref] of nb) if (na.get(n) !== ref) lines.push({ kind: na.has(n) ? 'changed' : 'added', where: `name ${n}`, before: na.get(n) ?? '', after: ref });
  for (const [n, ref] of na) if (!nb.has(n)) lines.push({ kind: 'removed', where: `name ${n}`, before: ref, after: '' });
  return { a, b, lines: lines.slice(0, MAX), truncated: lines.length > MAX };
}

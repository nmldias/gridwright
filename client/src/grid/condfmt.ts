// Conditional formatting: evaluates a table's rules for one cell at draw time.
// Per-rule statistics (min/max, duplicates, top-N thresholds) are cached per
// cells version so a redraw costs O(visible cells).

import * as book from '../engine/book';
import type { CellValue, CellView, CondFormat, TableMeta } from '../engine/types';
import { cellKey } from '../engine/types';

export interface CondStyle {
  fill?: string;
  color?: string;
  bold?: boolean;
}

interface RuleStats {
  min: number;
  max: number;
  counts: Map<string, number>;
  topThreshold: number | null;
  bottomThreshold: number | null;
}

const statsCache = new Map<string, RuleStats>();
let cacheVersion = -1;
// formula rules: result per (table, rule, cell) for the current cells version, so a redraw
// evaluates each visible cell at most once per change
const formulaCache = new Map<string, boolean>();
let formulaVersion = -1;

function numberOf(v: CellValue): number | null {
  return v && 'n' in v ? v.n : null;
}
function textOf(v: CellValue): string {
  if (!v) return '';
  if ('s' in v) return v.s;
  if ('n' in v) return String(v.n);
  if ('b' in v) return v.b ? 'TRUE' : 'FALSE';
  return v.e;
}

function stats(meta: TableMeta, cellMap: Map<number, CellView> | undefined, idx: number, rule: CondFormat, version: number): RuleStats {
  if (version !== cacheVersion) {
    statsCache.clear();
    cacheVersion = version;
  }
  const key = `${meta.id}:${idx}`;
  const hit = statsCache.get(key);
  if (hit) return hit;
  const nums: number[] = [];
  const counts = new Map<string, number>();
  const r1 = Math.min(rule.r1, meta.rows - 1);
  const c1 = Math.min(rule.c1, meta.cols - 1);
  const area = (r1 - rule.r0 + 1) * (c1 - rule.c0 + 1);
  if (cellMap && area <= 200000) {
    for (let r = rule.r0; r <= r1; r++) {
      for (let c = rule.c0; c <= c1; c++) {
        const cell = cellMap.get(cellKey(r, c));
        if (!cell || cell.v === null) continue;
        const n = numberOf(cell.v);
        if (n !== null) nums.push(n);
        if (rule.kind === 'duplicate') {
          const t = textOf(cell.v).toLowerCase();
          counts.set(t, (counts.get(t) ?? 0) + 1);
        }
      }
    }
  }
  nums.sort((a, b) => a - b);
  const k = Math.max(1, Math.round(Number(rule.values[0] ?? 10)));
  const s: RuleStats = {
    min: nums.length ? nums[0] : 0,
    max: nums.length ? nums[nums.length - 1] : 0,
    counts,
    topThreshold: nums.length ? nums[Math.max(0, nums.length - k)] : null,
    bottomThreshold: nums.length ? nums[Math.min(nums.length - 1, k - 1)] : null,
  };
  statsCache.set(key, s);
  return s;
}

function parseColor(hex?: string): [number, number, number] | null {
  if (!hex) return null;
  const m = hex.trim().replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(m)) return null;
  return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
}
function toHex(rgb: [number, number, number]): string {
  return '#' + rgb.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');
}

function cmpNumber(x: number, op: string, a: number, b: number): boolean {
  switch (op) {
    case 'gt':
      return x > a;
    case 'ge':
      return x >= a;
    case 'lt':
      return x < a;
    case 'le':
      return x <= a;
    case 'eq':
      return x === a;
    case 'ne':
      return x !== a;
    case 'between':
      return x >= Math.min(a, b) && x <= Math.max(a, b);
    case 'not_between':
      return x < Math.min(a, b) || x > Math.max(a, b);
    default:
      return false;
  }
}

/** Style overrides for a cell from the table's conditional-format rules (later rules win). */
export function condStyle(meta: TableMeta, cellMap: Map<number, CellView> | undefined, r: number, c: number, cell: CellView | undefined, version: number): CondStyle | null {
  const rules = meta.cond_formats;
  if (!rules || !rules.length) return null;
  let out: CondStyle | null = null;
  for (let idx = 0; idx < rules.length; idx++) {
    const rule = rules[idx];
    if (r < rule.r0 || r > rule.r1 || c < rule.c0 || c > rule.c1) continue;
    const v = cell?.v ?? null;
    let matched = false;
    let fill = rule.fill;
    switch (rule.kind) {
      case 'cell_is': {
        const n = numberOf(v);
        const a = Number(rule.values[0]);
        const b = Number(rule.values[1]);
        if (n !== null && Number.isFinite(a)) matched = cmpNumber(n, rule.op ?? 'gt', a, Number.isFinite(b) ? b : a);
        else if (v && 's' in v && (rule.op === 'eq' || rule.op === 'ne')) matched = (v.s.toLowerCase() === String(rule.values[0] ?? '').toLowerCase()) === (rule.op === 'eq');
        break;
      }
      case 'text': {
        const hay = textOf(v).toLowerCase();
        const needle = String(rule.values[0] ?? '').toLowerCase();
        if (!needle) break;
        switch (rule.op ?? 'contains') {
          case 'contains':
            matched = hay.includes(needle);
            break;
          case 'not_contains':
            matched = !hay.includes(needle);
            break;
          case 'starts':
            matched = hay.startsWith(needle);
            break;
          case 'ends':
            matched = hay.endsWith(needle);
            break;
        }
        break;
      }
      case 'blank':
        matched = v === null;
        break;
      case 'not_blank':
        matched = v !== null;
        break;
      case 'duplicate': {
        if (v === null) break;
        const s = stats(meta, cellMap, idx, rule, version);
        matched = (s.counts.get(textOf(v).toLowerCase()) ?? 0) > 1;
        break;
      }
      case 'top':
      case 'bottom': {
        const n = numberOf(v);
        if (n === null) break;
        const s = stats(meta, cellMap, idx, rule, version);
        matched = rule.kind === 'top' ? s.topThreshold !== null && n >= s.topThreshold : s.bottomThreshold !== null && n <= s.bottomThreshold;
        break;
      }
      case 'color_scale': {
        const n = numberOf(v);
        if (n === null) break;
        const s = stats(meta, cellMap, idx, rule, version);
        const lo = parseColor(rule.min_color) ?? [248, 250, 252];
        const hi = parseColor(rule.max_color) ?? [12, 68, 124];
        const t = s.max > s.min ? (n - s.min) / (s.max - s.min) : 0.5;
        fill = toHex([lo[0] + (hi[0] - lo[0]) * t, lo[1] + (hi[1] - lo[1]) * t, lo[2] + (hi[2] - lo[2]) * t]);
        matched = true;
        break;
      }
      case 'formula': {
        const f = rule.values[0];
        if (!f) break;
        const area = (rule.r1 - rule.r0 + 1) * (rule.c1 - rule.c0 + 1);
        if (area > 200000) break;
        if (formulaVersion !== version) {
          formulaCache.clear();
          formulaVersion = version;
        }
        const key = `${meta.id}:${idx}:${r}:${c}`;
        const hit = formulaCache.get(key);
        if (hit !== undefined) {
          matched = hit;
          break;
        }
        try {
          const res = book.evalAt(meta.id, r, c, f);
          matched = !!res && (('b' in res && res.b) || ('n' in res && res.n !== 0));
        } catch {
          matched = false;
        }
        if (formulaCache.size > 200000) formulaCache.clear();
        formulaCache.set(key, matched);
        break;
      }
    }
    if (matched) {
      out = out ?? {};
      if (fill) out.fill = fill;
      if (rule.color) out.color = rule.color;
      if (rule.bold !== undefined) out.bold = rule.bold;
    }
  }
  return out;
}

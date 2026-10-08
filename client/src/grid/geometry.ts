// Table layout math and hit testing in world (canvas) coordinates.

import type { TableId, TableMeta } from '../engine/types';

export const TITLE_H = 22; // table title bar above the grid
export const TAB_SIZE = 18; // reference tabs (column letters / row numbers) shown when a table is selected
export const HANDLE = 12; // resize handle size
export const HANDLE_GAP = 6; // gap between the table edge and its handles
export const SNAP = 8; // move snapping grid

export interface Layout {
  colX: number[]; // cumulative x offsets, length cols + 1
  rowY: number[]; // cumulative y offsets, length rows + 1
  width: number;
  height: number;
}

const cache = new WeakMap<TableMeta, Layout>();

export function layoutOf(meta: TableMeta): Layout {
  let l = cache.get(meta);
  if (l) return l;
  const colX = new Array(meta.cols + 1);
  const rowY = new Array(meta.rows + 1);
  colX[0] = 0;
  for (let i = 0; i < meta.cols; i++) colX[i + 1] = colX[i] + (meta.col_widths[i] ?? 100);
  rowY[0] = 0;
  for (let i = 0; i < meta.rows; i++) rowY[i + 1] = rowY[i] + (meta.row_heights[i] ?? 24);
  l = { colX, rowY, width: colX[meta.cols], height: rowY[meta.rows] };
  cache.set(meta, l);
  return l;
}

/** Index i such that offsets[i] <= v < offsets[i+1]; -1 outside. */
export function indexAt(offsets: number[], v: number): number {
  if (v < 0 || v >= offsets[offsets.length - 1]) return -1;
  let lo = 0;
  let hi = offsets.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export type Hit =
  | { kind: 'none' }
  | { kind: 'cell'; table: TableId; r: number; c: number }
  | { kind: 'title'; table: TableId }
  | { kind: 'corner'; table: TableId }
  | { kind: 'right'; table: TableId }
  | { kind: 'bottom'; table: TableId }
  | { kind: 'col-resize'; table: TableId; c: number }
  | { kind: 'row-resize'; table: TableId; r: number }
  | { kind: 'col-tab'; table: TableId; c: number }
  | { kind: 'row-tab'; table: TableId; r: number }
  | { kind: 'select-all'; table: TableId };

export function hitTest(
  tables: Map<TableId, TableMeta>,
  order: TableId[],
  wx: number,
  wy: number,
  selected: TableId | null,
  zoom: number,
): Hit {
  const tol = 5 / zoom;
  // topmost first
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const t = tables.get(id);
    if (!t) continue;
    const L = layoutOf(t);
    const lx = wx - t.x;
    const ly = wy - t.y;
    const isSel = selected === id;
    // handles (only for the selected table)
    if (isSel) {
      const hx = L.width + HANDLE_GAP;
      const hy = L.height + HANDLE_GAP;
      if (within(lx, ly, hx, hy, HANDLE + tol)) return { kind: 'corner', table: id };
      if (lx >= hx - tol && lx <= hx + HANDLE + tol && Math.abs(ly - L.height / 2) <= 14 + tol) return { kind: 'right', table: id };
      if (ly >= hy - tol && ly <= hy + HANDLE + tol && Math.abs(lx - L.width / 2) <= 14 + tol) return { kind: 'bottom', table: id };
    }
    // title bar (sits above the reference tabs when the table is selected)
    const tabW = isSel ? TAB_SIZE : 0;
    if (lx >= -tabW && lx <= L.width && ly >= -TITLE_H - tabW && ly < -tabW) return { kind: 'title', table: id };
    // reference tabs
    if (isSel && lx >= -tabW && lx < 0 && ly >= -tabW && ly < 0) return { kind: 'select-all', table: id };
    if (isSel && ly >= -tabW && ly < 0 && lx >= 0 && lx <= L.width) {
      for (let c = 1; c < L.colX.length; c++) if (Math.abs(lx - L.colX[c]) <= tol) return { kind: 'col-resize', table: id, c: c - 1 };
      const c = indexAt(L.colX, lx);
      if (c >= 0) return { kind: 'col-tab', table: id, c };
    }
    if (isSel && lx >= -tabW && lx < 0 && ly >= 0 && ly <= L.height) {
      for (let r = 1; r < L.rowY.length; r++) if (Math.abs(ly - L.rowY[r]) <= tol) return { kind: 'row-resize', table: id, r: r - 1 };
      const r = indexAt(L.rowY, ly);
      if (r >= 0) return { kind: 'row-tab', table: id, r };
    }
    // inside the grid
    if (lx >= 0 && lx < L.width && ly >= 0 && ly < L.height) {
      // column boundaries inside the header row double as resize grips
      const headerBottom = L.rowY[Math.max(1, t.header_rows)] ?? 0;
      if (ly < headerBottom) {
        for (let c = 1; c < L.colX.length; c++) if (Math.abs(lx - L.colX[c]) <= tol) return { kind: 'col-resize', table: id, c: c - 1 };
      }
      const c = indexAt(L.colX, lx);
      const r = indexAt(L.rowY, ly);
      if (c >= 0 && r >= 0) return { kind: 'cell', table: id, r, c };
    }
  }
  return { kind: 'none' };
}

function within(x: number, y: number, x0: number, y0: number, size: number) {
  return x >= x0 - 2 && x <= x0 + size && y >= y0 - 2 && y <= y0 + size;
}

export function cursorFor(h: Hit): string {
  switch (h.kind) {
    case 'cell':
      return 'cell';
    case 'title':
      return 'move';
    case 'corner':
      return 'nwse-resize';
    case 'right':
      return 'ew-resize';
    case 'bottom':
      return 'ns-resize';
    case 'col-resize':
      return 'col-resize';
    case 'row-resize':
      return 'row-resize';
    case 'col-tab':
      return 's-resize';
    case 'row-tab':
      return 'e-resize';
    case 'select-all':
      return 'pointer';
    default:
      return 'default';
  }
}

/** Rows/cols a table would have if its corner handle were dragged to (lx, ly) in table-local coords. */
export function sizeForCorner(meta: TableMeta, lx: number, ly: number): { rows: number; cols: number } {
  const L = layoutOf(meta);
  const avgW = meta.cols ? L.width / meta.cols : 100;
  const avgH = meta.rows ? L.height / meta.rows : 24;
  let cols = meta.cols;
  if (lx > L.width) cols = meta.cols + Math.max(0, Math.round((lx - L.width) / avgW));
  else {
    const c = indexAt(L.colX, Math.max(0, lx));
    cols = Math.max(1, c + 1);
  }
  let rows = meta.rows;
  if (ly > L.height) rows = meta.rows + Math.max(0, Math.round((ly - L.height) / avgH));
  else {
    const r = indexAt(L.rowY, Math.max(0, ly));
    rows = Math.max(1, r + 1);
  }
  return { rows: Math.min(rows, 100000), cols: Math.min(cols, 2000) };
}

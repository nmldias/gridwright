// Table layout math and hit testing in world (canvas) coordinates.

import type { Chart, TableId, TableMeta } from '../engine/types';

export const TITLE_H = 22; // table title bar above the grid
export const TAB_SIZE = 18; // reference tabs (column letters / row numbers) shown when a table is selected
export const HANDLE = 12; // resize handle size
export const HANDLE_GAP = 6; // gap between the table edge and its handles
export const SNAP = 8; // move snapping grid
export const FILTER_BTN = 14; // header filter button size
export const CHART_HANDLE = 12; // chart resize handle size

export interface Layout {
  colX: number[]; // cumulative x offsets, length cols + 1
  rowY: number[]; // cumulative y offsets, length rows + 1
  width: number;
  height: number;
  hidden: Set<number>;
}

const cache = new WeakMap<TableMeta, Layout>();

export function layoutOf(meta: TableMeta): Layout {
  let l = cache.get(meta);
  if (l) return l;
  const hidden = new Set<number>(meta.hidden_rows ?? []);
  const colX = new Array(meta.cols + 1);
  const rowY = new Array(meta.rows + 1);
  colX[0] = 0;
  for (let i = 0; i < meta.cols; i++) colX[i + 1] = colX[i] + (meta.col_widths[i] ?? 100);
  rowY[0] = 0;
  for (let i = 0; i < meta.rows; i++) rowY[i + 1] = rowY[i] + (hidden.has(i) ? 0 : (meta.row_heights[i] ?? 24));
  l = { colX, rowY, width: colX[meta.cols], height: rowY[meta.rows], hidden };
  cache.set(meta, l);
  return l;
}

/** Index i such that offsets[i] <= v < offsets[i+1]; -1 outside. Zero-height entries are skipped. */
export function indexAt(offsets: number[], v: number): number {
  if (v < 0 || v >= offsets[offsets.length - 1]) return -1;
  let lo = 0;
  let hi = offsets.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= v) lo = mid;
    else hi = mid - 1;
  }
  while (lo < offsets.length - 2 && offsets[lo] === offsets[lo + 1]) lo++;
  return lo;
}

/** Next visible row at or after `r` in the given direction (null when none). */
export function nextVisibleRow(meta: TableMeta, r: number, dir: 1 | -1): number | null {
  const hidden = layoutOf(meta).hidden;
  let x = r;
  while (x >= 0 && x < meta.rows) {
    if (!hidden.has(x)) return x;
    x += dir;
  }
  return null;
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
  | { kind: 'select-all'; table: TableId }
  | { kind: 'fill'; table: TableId }
  | { kind: 'filter'; table: TableId; c: number }
  | { kind: 'chart'; id: number }
  | { kind: 'chart-resize'; id: number };

/** Charts float above tables: the topmost chart under the pointer wins. */
export function hitChart(charts: Chart[], wx: number, wy: number, selected: number | null, zoom: number, touch = false): Hit | null {
  const tol = (touch ? 12 : 6) / zoom;
  for (let i = charts.length - 1; i >= 0; i--) {
    const c = charts[i];
    if (selected === c.id && Math.abs(wx - (c.x + c.w)) <= CHART_HANDLE / 2 + tol && Math.abs(wy - (c.y + c.h)) <= CHART_HANDLE / 2 + tol) return { kind: 'chart-resize', id: c.id };
    if (wx >= c.x && wx <= c.x + c.w && wy >= c.y && wy <= c.y + c.h) return { kind: 'chart', id: c.id };
  }
  return null;
}

export function hitTest(
  tables: Map<TableId, TableMeta>,
  order: TableId[],
  wx: number,
  wy: number,
  selected: TableId | null,
  zoom: number,
  selection?: { table: TableId; r1: number; c1: number } | null,
  touch = false,
): Hit {
  const tol = (touch ? 12 : 5) / zoom;
  const handleTol = touch ? 10 : 0;
  // fill handle at the bottom-right corner of the selection
  if (selection) {
    const t = tables.get(selection.table);
    if (t) {
      const L = layoutOf(t);
      const fx = t.x + L.colX[Math.min(selection.c1, t.cols - 1) + 1];
      const fy = t.y + L.rowY[Math.min(selection.r1, t.rows - 1) + 1];
      if (Math.abs(wx - fx) <= tol && Math.abs(wy - fy) <= tol) return { kind: 'fill', table: t.id };
    }
  }
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
      if (within(lx, ly, hx - handleTol, hy - handleTol, HANDLE + tol + handleTol)) return { kind: 'corner', table: id };
      if (lx >= hx - tol && lx <= hx + HANDLE + tol + handleTol && Math.abs(ly - L.height / 2) <= 14 + tol) return { kind: 'right', table: id };
      if (ly >= hy - tol && ly <= hy + HANDLE + tol + handleTol && Math.abs(lx - L.width / 2) <= 14 + tol) return { kind: 'bottom', table: id };
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
      for (let r = 1; r < L.rowY.length; r++) if (L.rowY[r] !== L.rowY[r - 1] && Math.abs(ly - L.rowY[r]) <= tol) return { kind: 'row-resize', table: id, r: r - 1 };
      const r = indexAt(L.rowY, ly);
      if (r >= 0) return { kind: 'row-tab', table: id, r };
    }
    // inside the grid
    if (lx >= 0 && lx < L.width && ly >= 0 && ly < L.height) {
      // column boundaries inside the header row double as resize grips; header filter buttons
      const headerBottom = L.rowY[Math.max(1, t.header_rows)] ?? 0;
      if (ly < headerBottom && t.header_rows > 0) {
        for (let c = 1; c < L.colX.length; c++) if (Math.abs(lx - L.colX[c]) <= tol) return { kind: 'col-resize', table: id, c: c - 1 };
        const c = indexAt(L.colX, lx);
        if (c >= 0 && (isSel || t.filters.length > 0)) {
          const bx = L.colX[c + 1] - FILTER_BTN - 2;
          const by = L.rowY[1] - FILTER_BTN - 2;
          if (lx >= bx - tol && ly >= by - tol && lx <= L.colX[c + 1] && ly <= L.rowY[1]) return { kind: 'filter', table: id, c };
        }
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
  if (h.kind === 'chart') return 'move';
  if (h.kind === 'chart-resize') return 'nwse-resize';
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
    case 'filter':
      return 'pointer';
    case 'fill':
      return 'crosshair';
    default:
      return 'default';
  }
}

/** Rows/cols a table would have if its corner handle were dragged to (lx, ly) in table-local coords. */
export function sizeForCorner(meta: TableMeta, lx: number, ly: number): { rows: number; cols: number } {
  const L = layoutOf(meta);
  const avgW = meta.cols ? L.width / meta.cols : 100;
  const visibleRows = meta.rows - L.hidden.size;
  const avgH = visibleRows ? L.height / visibleRows : 24;
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

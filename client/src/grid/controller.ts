// Pointer and keyboard interaction for the canvas: selection drags, table
// moving, Numbers-style resize handles, column/row resizing, pan/zoom, and
// touch gestures (one finger pans, tap selects, long-press selects a range,
// double-tap edits, two fingers pinch-zoom).

import * as book from '../engine/book';
import type { TableId } from '../engine/types';
import { getState, useStore } from '../state/store';
import {
  autoFitColumn,
  cancelEdit,
  clearSelection,
  commitEdit,
  copySelection,
  fillDown,
  fillFromSource,
  moveActive,
  pasteFromClipboard,
  selectCell,
  selectRange,
  startEdit,
  toggleBold,
} from './actions';
import { SNAP, cursorFor, hitChart, hitTest, indexAt, layoutOf, sizeForCorner, type Hit } from './geometry';
import { traceStep } from '../ui/review';
import type { GridRenderer } from './renderer';

type Mode =
  | { kind: 'idle' }
  | { kind: 'pan'; sx: number; sy: number; px: number; py: number }
  | { kind: 'select'; table: TableId }
  | { kind: 'move'; table: TableId; ox: number; oy: number; moved: boolean }
  | { kind: 'corner' | 'right' | 'bottom'; table: TableId; dx: number; dy: number }
  | { kind: 'col-resize'; table: TableId; c: number; startX: number; startW: number }
  | { kind: 'row-resize'; table: TableId; r: number; startY: number; startH: number }
  | { kind: 'col-select'; table: TableId; c: number }
  | { kind: 'row-select'; table: TableId; r: number }
  | { kind: 'fill'; table: TableId; r0: number; c0: number; r1: number; c1: number }
  | { kind: 'chart-move'; id: number; ox: number; oy: number; moved: boolean }
  | { kind: 'chart-resize'; id: number; dx: number; dy: number }
  /** touch: undecided between tap, pan and long-press selection */
  | { kind: 'touch-wait'; hit: Hit; sx: number; sy: number; px: number; py: number; timer: number }
  | { kind: 'pinch'; d0: number; z0: number; cx: number; cy: number; wx: number; wy: number };

const TAP_SLOP = 8;
const LONG_PRESS_MS = 420;

export class GridController {
  private mode: Mode = { kind: 'idle' };
  private spaceDown = false;
  private lastClick = { t: 0, table: -1, r: -1, c: -1 };
  private detach: (() => void)[] = [];
  private pointers = new Map<number, { x: number; y: number }>();

  constructor(
    private host: HTMLElement,
    private renderer: GridRenderer,
  ) {
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, ev: K, fn: (e: any) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(ev, fn as any, opts);
      this.detach.push(() => el.removeEventListener(ev, fn as any, opts));
    };
    on(host, 'pointerdown', (e) => this.onPointerDown(e));
    on(host, 'pointermove', (e) => this.onPointerMove(e));
    on(host, 'pointerup', (e) => this.onPointerUp(e));
    on(host, 'pointercancel', (e) => this.onPointerUp(e));
    on(host, 'wheel', (e) => this.onWheel(e), { passive: false });
    on(host, 'contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      this.openContextMenu(e.clientX, e.clientY);
    });
    on(window, 'keydown', (e) => this.onKeyDown(e));
    on(window, 'keyup', (e) => {
      if (e.code === 'Space') this.spaceDown = false;
    });
    on(window, 'paste', (e: ClipboardEvent) => {
      if (this.inputFocused()) return;
      const text = e.clipboardData?.getData('text/plain');
      if (text !== undefined) {
        e.preventDefault();
        void pasteFromClipboard(text);
      }
    });
  }

  dispose() {
    this.detach.forEach((f) => f());
  }

  private openContextMenu(clientX: number, clientY: number) {
    const rect = this.host.getBoundingClientRect();
    const w = this.renderer.screenToWorld(clientX - rect.left, clientY - rect.top);
    const h = this.hit(w.x, w.y);
    if (h.kind === 'cell') {
      const sel = getState().selection;
      const inside = sel && sel.table === h.table && h.r >= sel.r0 && h.r <= sel.r1 && h.c >= sel.c0 && h.c <= sel.c1;
      if (!inside) selectCell(h.table, h.r, h.c);
    }
    this.host.dispatchEvent(new CustomEvent('gw-contextmenu', { detail: { x: clientX, y: clientY, hit: h } }));
  }

  private inputFocused(): boolean {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable || !!el.closest('.cm-editor');
  }

  private pointerWorld(e: PointerEvent | WheelEvent) {
    const rect = this.host.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    return { sx, sy, ...this.renderer.screenToWorld(sx, sy) };
  }

  private hit(wx: number, wy: number, touch = false): Hit {
    const st = getState();
    const ch = hitChart(st.charts, wx, wy, st.selectedChart, this.renderer.zoom, touch);
    if (ch) return ch;
    return hitTest(st.tables, Array.from(st.tables.keys()), wx, wy, st.selectedTable, this.renderer.zoom, st.selection, touch);
  }

  // ------------------------------------------------------------------
  private onPointerDown(e: PointerEvent) {
    // overlays (context menu, cell editor) handle their own pointer events
    const target = e.target as HTMLElement | null;
    if (target && target !== this.host && !(target instanceof HTMLCanvasElement)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (e.pointerType === 'touch') {
      this.onTouchDown(e);
      return;
    }
    if (e.button === 1 || this.spaceDown) {
      this.beginPan(e);
      return;
    }
    if (e.button !== 0) return;
    this.host.focus();
    const { x, y } = this.pointerWorld(e);
    const st = getState();
    if (st.editing) {
      // clicking elsewhere commits the current edit
      const ed = st.editing;
      const h = this.hit(x, y);
      if (!(h.kind === 'cell' && h.table === ed.table && h.r === ed.r && h.c === ed.c)) commitEdit(st.editorText, null);
    }
    const h = this.hit(x, y);
    this.capture(e);
    this.beginHit(h, e, x, y, false);
  }

  private capture(e: PointerEvent) {
    try {
      this.host.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already-released pointer */
    }
  }

  /** Start the interaction for a hit (shared by mouse and touch). */
  private beginHit(h: Hit, e: PointerEvent, x: number, y: number, touch: boolean) {
    const st = getState();
    if (h.kind !== 'chart' && h.kind !== 'chart-resize' && st.selectedChart !== null) useStore.setState({ selectedChart: null });
    switch (h.kind) {
      case 'chart': {
        const id = h.id;
        const chart = st.charts.find((c) => c.id === id)!;
        const now = performance.now();
        const dbl = now - this.lastClick.t < 400 && this.lastClick.table === -2 && this.lastClick.r === id;
        this.lastClick = { t: now, table: -2, r: id, c: 0 };
        useStore.setState({ selectedChart: id, selectedTable: null });
        this.renderer.markDirty();
        if (dbl) {
          useStore.setState({ panel: 'chart' });
          this.mode = { kind: 'idle' };
          return;
        }
        this.mode = { kind: 'chart-move', id, ox: x - chart.x, oy: y - chart.y, moved: false };
        break;
      }
      case 'chart-resize': {
        const id = h.id;
        const chart = st.charts.find((c) => c.id === id)!;
        this.mode = { kind: 'chart-resize', id, dx: x - (chart.x + chart.w), dy: y - (chart.y + chart.h) };
        break;
      }
      case 'fill': {
        const sel = st.selection!;
        this.mode = { kind: 'fill', table: h.table, r0: sel.r0, c0: sel.c0, r1: sel.r1, c1: sel.c1 };
        break;
      }
      case 'filter': {
        useStore.setState({ filterPopover: { table: h.table, col: h.c, x: e.clientX, y: e.clientY } });
        this.mode = { kind: 'idle' };
        break;
      }
      case 'cell': {
        // inside a merged block the top-left cell is the one that is selected and edited
        const cellHit = h;
        const mg = st.tables.get(cellHit.table)?.merges?.find((m) => cellHit.r >= m.r0 && cellHit.r <= m.r1 && cellHit.c >= m.c0 && cellHit.c <= m.c1);
        if (mg) h = { kind: 'cell', table: cellHit.table, r: mg.r0, c: mg.c0 };
        if (h.kind !== 'cell') return;
        const now = performance.now();
        const dbl = now - this.lastClick.t < 400 && this.lastClick.table === h.table && this.lastClick.r === h.r && this.lastClick.c === h.c;
        this.lastClick = { t: now, table: h.table, r: h.r, c: h.c };
        if (getState().selectedTable !== null && getState().selectedTable !== h.table) useStore.setState({ selectedTable: null });
        if (dbl) {
          // keep the browser from moving focus to the canvas after the editor took it
          e.preventDefault();
          selectCell(h.table, h.r, h.c);
          startEdit();
          this.mode = { kind: 'idle' };
          return;
        }
        selectCell(h.table, h.r, h.c, e.shiftKey);
        this.mode = touch ? { kind: 'idle' } : { kind: 'select', table: h.table };
        break;
      }
      case 'title': {
        const meta = st.tables.get(h.table)!;
        useStore.setState({ selectedTable: h.table });
        if (!st.selection || st.selection.table !== h.table) selectCell(h.table, 0, 0);
        this.mode = { kind: 'move', table: h.table, ox: x - meta.x, oy: y - meta.y, moved: false };
        break;
      }
      case 'corner':
      case 'right':
      case 'bottom': {
        const meta = st.tables.get(h.table)!;
        const L = layoutOf(meta);
        // offset between the pointer and the table's bottom-right corner, so the
        // size follows the pointer movement exactly
        this.mode = { kind: h.kind, table: h.table, dx: x - (meta.x + L.width), dy: y - (meta.y + L.height) };
        break;
      }
      case 'col-resize': {
        const meta = st.tables.get(h.table)!;
        // a double-click on a column edge fits the column to its widest value (spreadsheet convention)
        const now = performance.now();
        const dbl = now - this.lastClick.t < 400 && this.lastClick.table === -3 - h.table && this.lastClick.c === h.c;
        this.lastClick = { t: now, table: -3 - h.table, r: -1, c: h.c };
        if (dbl) {
          autoFitColumn(h.table, h.c);
          this.mode = { kind: 'idle' };
          return;
        }
        this.mode = { kind: 'col-resize', table: h.table, c: h.c, startX: x, startW: meta.col_widths[h.c] };
        break;
      }
      case 'row-resize': {
        const meta = st.tables.get(h.table)!;
        this.mode = { kind: 'row-resize', table: h.table, r: h.r, startY: y, startH: meta.row_heights[h.r] };
        break;
      }
      case 'col-tab': {
        const meta = st.tables.get(h.table)!;
        selectRange(h.table, 0, h.c, meta.rows - 1, h.c);
        this.mode = { kind: 'col-select', table: h.table, c: h.c };
        break;
      }
      case 'row-tab': {
        const meta = st.tables.get(h.table)!;
        selectRange(h.table, h.r, 0, h.r, meta.cols - 1);
        this.mode = { kind: 'row-select', table: h.table, r: h.r };
        break;
      }
      case 'select-all': {
        const meta = st.tables.get(h.table)!;
        selectRange(h.table, 0, 0, meta.rows - 1, meta.cols - 1);
        break;
      }
      default:
        useStore.setState({ selectedTable: null });
        this.renderer.markDirty();
        this.beginPan(e);
    }
  }

  // ---- touch ----------------------------------------------------------------
  private onTouchDown(e: PointerEvent) {
    e.preventDefault(); // no synthetic mouse events / focus changes behind our back
    this.capture(e);
    if (this.pointers.size >= 2) {
      // second finger: pinch zoom
      if (this.mode.kind === 'touch-wait') clearTimeout(this.mode.timer);
      const pts = Array.from(this.pointers.values());
      const rect = this.host.getBoundingClientRect();
      const cx = (pts[0].x + pts[1].x) / 2 - rect.left;
      const cy = (pts[0].y + pts[1].y) / 2 - rect.top;
      const w = this.renderer.screenToWorld(cx, cy);
      this.mode = { kind: 'pinch', d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), z0: this.renderer.zoom, cx, cy, wx: w.x, wy: w.y };
      return;
    }
    const st = getState();
    const { x, y, sx, sy } = this.pointerWorld(e);
    if (st.editing) {
      const ed = st.editing;
      const h = this.hit(x, y, true);
      if (!(h.kind === 'cell' && h.table === ed.table && h.r === ed.r && h.c === ed.c)) commitEdit(st.editorText, null);
    }
    const h = this.hit(x, y, true);
    // handles, title and tabs react immediately; cells and empty canvas wait to see if it is a pan
    if (h.kind === 'cell' || h.kind === 'none') {
      const timer = window.setTimeout(() => {
        if (this.mode.kind !== 'touch-wait') return;
        // long press: start a range selection (cell) or open the context menu (cell)
        if (h.kind === 'cell') {
          selectCell(h.table, h.r, h.c);
          this.mode = { kind: 'select', table: h.table };
          this.openContextMenu(e.clientX, e.clientY);
        } else this.mode = { kind: 'idle' };
      }, LONG_PRESS_MS);
      this.mode = { kind: 'touch-wait', hit: h, sx, sy, px: this.renderer.pan.x, py: this.renderer.pan.y, timer };
      return;
    }
    this.beginHit(h, e, x, y, true);
  }

  private beginPan(e: PointerEvent) {
    const rect = this.host.getBoundingClientRect();
    this.mode = { kind: 'pan', sx: e.clientX - rect.left, sy: e.clientY - rect.top, px: this.renderer.pan.x, py: this.renderer.pan.y };
    this.capture(e);
    this.host.style.cursor = 'grabbing';
  }

  private onPointerMove(e: PointerEvent) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const { sx, sy, x, y } = this.pointerWorld(e);
    const st = getState();
    switch (this.mode.kind) {
      case 'idle': {
        if (e.pointerType === 'touch') return;
        const h = this.hit(x, y);
        this.host.style.cursor = this.spaceDown ? 'grab' : cursorFor(h);
        return;
      }
      case 'touch-wait': {
        const m = this.mode;
        if (Math.hypot(sx - m.sx, sy - m.sy) > TAP_SLOP) {
          clearTimeout(m.timer);
          this.mode = { kind: 'pan', sx: m.sx, sy: m.sy, px: m.px, py: m.py };
          this.renderer.setViewport(m.px + (sx - m.sx), m.py + (sy - m.sy), this.renderer.zoom);
        }
        return;
      }
      case 'pinch': {
        const pts = Array.from(this.pointers.values());
        if (pts.length < 2) return;
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const m = this.mode;
        const z = Math.min(4, Math.max(0.2, (m.z0 * d) / Math.max(1, m.d0)));
        const rect = this.host.getBoundingClientRect();
        const cx = (pts[0].x + pts[1].x) / 2 - rect.left;
        const cy = (pts[0].y + pts[1].y) / 2 - rect.top;
        // keep the world point under the fingers fixed
        this.renderer.setViewport(cx - m.wx * z, cy - m.wy * z, z);
        useStore.setState({ zoom: z });
        return;
      }
      case 'pan': {
        this.renderer.setViewport(this.mode.px + (sx - this.mode.sx), this.mode.py + (sy - this.mode.sy), this.renderer.zoom);
        return;
      }
      case 'select': {
        const meta = st.tables.get(this.mode.table);
        if (!meta) return;
        const L = layoutOf(meta);
        const lx = Math.max(0, Math.min(L.width - 0.01, x - meta.x));
        const ly = Math.max(0, Math.min(L.height - 0.01, y - meta.y));
        const c = indexAt(L.colX, lx);
        const r = indexAt(L.rowY, ly);
        if (r >= 0 && c >= 0) {
          const sel = st.selection;
          if (!sel || sel.table !== meta.id || r !== (sel.r1 === sel.ar ? sel.r0 : sel.r1) || c !== (sel.c1 === sel.ac ? sel.c0 : sel.c1)) selectCell(meta.id, r, c, true);
        }
        return;
      }
      case 'col-select': {
        const meta = st.tables.get(this.mode.table)!;
        const L = layoutOf(meta);
        const c = indexAt(L.colX, Math.max(0, Math.min(L.width - 0.01, x - meta.x)));
        if (c >= 0) selectRange(meta.id, 0, Math.min(this.mode.c, c), meta.rows - 1, Math.max(this.mode.c, c));
        return;
      }
      case 'fill': {
        const meta = st.tables.get(this.mode.table)!;
        const L = layoutOf(meta);
        const r = indexAt(L.rowY, Math.max(0, Math.min(L.height - 0.01, y - meta.y)));
        const c = indexAt(L.colX, Math.max(0, Math.min(L.width - 0.01, x - meta.x)));
        if (r < 0 || c < 0) return;
        const m = this.mode;
        // extend vertically or horizontally, whichever is dominant
        const dr = r > m.r1 ? r - m.r1 : r < m.r0 ? r - m.r0 : 0;
        const dc = c > m.c1 ? c - m.c1 : c < m.c0 ? c - m.c0 : 0;
        if (Math.abs(dr) >= Math.abs(dc)) selectRange(meta.id, Math.min(m.r0, r), m.c0, Math.max(m.r1, r), m.c1);
        else selectRange(meta.id, m.r0, Math.min(m.c0, c), m.r1, Math.max(m.c1, c));
        return;
      }
      case 'row-select': {
        const meta = st.tables.get(this.mode.table)!;
        const L = layoutOf(meta);
        const r = indexAt(L.rowY, Math.max(0, Math.min(L.height - 0.01, y - meta.y)));
        if (r >= 0) selectRange(meta.id, Math.min(this.mode.r, r), 0, Math.max(this.mode.r, r), meta.cols - 1);
        return;
      }
      case 'move': {
        const nx = Math.round((x - this.mode.ox) / SNAP) * SNAP;
        const ny = Math.round((y - this.mode.oy) / SNAP) * SNAP;
        this.mode.moved = true;
        this.renderer.movePreview = { table: this.mode.table, x: nx, y: ny };
        this.renderer.markDirty();
        return;
      }
      case 'chart-move': {
        const chart = st.charts.find((c) => c.id === (this.mode as { id: number }).id);
        if (!chart) return;
        const nx = Math.round((x - this.mode.ox) / SNAP) * SNAP;
        const ny = Math.round((y - this.mode.oy) / SNAP) * SNAP;
        if (!this.mode.moved && Math.hypot(nx - chart.x, ny - chart.y) < SNAP) return;
        this.mode.moved = true;
        this.renderer.chartPreview = { id: chart.id, x: nx, y: ny, w: chart.w, h: chart.h };
        this.renderer.markDirty();
        return;
      }
      case 'chart-resize': {
        const chart = st.charts.find((c) => c.id === (this.mode as { id: number }).id);
        if (!chart) return;
        const w = Math.max(240, Math.round((x - this.mode.dx - chart.x) / SNAP) * SNAP);
        const h = Math.max(180, Math.round((y - this.mode.dy - chart.y) / SNAP) * SNAP);
        this.renderer.chartPreview = { id: chart.id, x: chart.x, y: chart.y, w, h };
        this.renderer.markDirty();
        return;
      }
      case 'corner':
      case 'right':
      case 'bottom': {
        const meta = st.tables.get(this.mode.table);
        if (!meta) return;
        const size = sizeForCorner(meta, x - meta.x - this.mode.dx, y - meta.y - this.mode.dy);
        const rows = this.mode.kind === 'right' ? meta.rows : size.rows;
        const cols = this.mode.kind === 'bottom' ? meta.cols : size.cols;
        this.renderer.resizePreview = { table: meta.id, rows, cols };
        this.renderer.markDirty();
        return;
      }
      case 'col-resize': {
        const w = Math.max(24, this.mode.startW + (x - this.mode.startX));
        this.renderer.colPreview = { table: this.mode.table, c: this.mode.c, width: w };
        this.renderer.markDirty();
        return;
      }
      case 'row-resize': {
        const h = Math.max(14, this.mode.startH + (y - this.mode.startY));
        this.renderer.rowPreview = { table: this.mode.table, r: this.mode.r, height: h };
        this.renderer.markDirty();
        return;
      }
    }
  }

  private onPointerUp(e: PointerEvent) {
    this.pointers.delete(e.pointerId);
    const mode = this.mode;
    if (mode.kind === 'pinch') {
      if (this.pointers.size === 0) this.mode = { kind: 'idle' };
      return;
    }
    this.mode = { kind: 'idle' };
    try {
      this.host.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.host.style.cursor = 'default';
    switch (mode.kind) {
      case 'touch-wait': {
        clearTimeout(mode.timer);
        // a tap: select the cell (second tap on the same cell edits), or deselect on empty canvas
        const { x, y } = this.pointerWorld(e);
        const h = mode.hit;
        if (h.kind === 'cell') {
          const now = performance.now();
          const dbl = now - this.lastClick.t < 450 && this.lastClick.table === h.table && this.lastClick.r === h.r && this.lastClick.c === h.c;
          this.lastClick = { t: now, table: h.table, r: h.r, c: h.c };
          if (getState().selectedTable !== null && getState().selectedTable !== h.table) useStore.setState({ selectedTable: null });
          selectCell(h.table, h.r, h.c);
          if (dbl) startEdit();
        } else {
          void x;
          void y;
          useStore.setState({ selectedTable: null });
          this.renderer.markDirty();
        }
        return;
      }
      case 'fill': {
        fillFromSource(mode.table, mode, getState().selection);
        return;
      }
      case 'move': {
        const p = this.renderer.movePreview;
        this.renderer.movePreview = null;
        if (mode.moved && p) book.apply({ type: 'move_table', table: mode.table, x: p.x, y: p.y });
        else this.renderer.markDirty();
        return;
      }
      case 'chart-move':
      case 'chart-resize': {
        const p = this.renderer.chartPreview;
        this.renderer.chartPreview = null;
        const chart = getState().charts.find((c) => c.id === mode.id);
        if (p && chart && (p.x !== chart.x || p.y !== chart.y || p.w !== chart.w || p.h !== chart.h)) book.apply({ type: 'update_chart', chart: { ...chart, x: p.x, y: p.y, w: p.w, h: p.h } }, { note: 'chart moved' });
        else this.renderer.markDirty();
        return;
      }
      case 'corner':
      case 'right':
      case 'bottom': {
        const p = this.renderer.resizePreview;
        this.renderer.resizePreview = null;
        const meta = getState().tables.get(mode.table);
        if (p && meta && (p.rows !== meta.rows || p.cols !== meta.cols)) book.apply({ type: 'resize_table', table: mode.table, rows: p.rows, cols: p.cols });
        else this.renderer.markDirty();
        return;
      }
      case 'col-resize': {
        const p = this.renderer.colPreview;
        this.renderer.colPreview = null;
        if (p && Math.abs(p.width - mode.startW) >= 1) book.apply({ type: 'set_col_width', table: mode.table, col: mode.c, width: Math.round(p.width) });
        else this.renderer.markDirty();
        return;
      }
      case 'row-resize': {
        const p = this.renderer.rowPreview;
        this.renderer.rowPreview = null;
        if (p && Math.abs(p.height - mode.startH) >= 1) book.apply({ type: 'set_row_height', table: mode.table, row: mode.r, height: Math.round(p.height) });
        else this.renderer.markDirty();
        return;
      }
      default:
        return;
    }
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const { sx, sy } = this.pointerWorld(e);
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * 0.0015);
      this.renderer.zoomAt(sx, sy, factor);
      useStore.setState({ zoom: this.renderer.zoom });
    } else {
      const k = e.deltaMode === 1 ? 16 : 1;
      this.renderer.setViewport(this.renderer.pan.x - e.deltaX * k, this.renderer.pan.y - e.deltaY * k, this.renderer.zoom);
    }
  }

  // ------------------------------------------------------------------
  private onKeyDown(e: KeyboardEvent) {
    if (e.code === 'Space' && !this.inputFocused()) this.spaceDown = true;
    if (this.inputFocused()) return;
    const st = getState();
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) book.redo();
      else book.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      book.redo();
      return;
    }
    if (st.selectedChart !== null) {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        book.apply({ type: 'delete_chart', id: st.selectedChart }, { note: 'chart deleted' });
        useStore.setState({ selectedChart: null });
        return;
      }
      if (e.key === 'Escape') {
        useStore.setState({ selectedChart: null });
        this.renderer.markDirty();
        return;
      }
    }
    if (mod && (e.key === '[' || e.key === ']')) {
      // trace precedents (Ctrl+[) / dependents (Ctrl+]) of the active cell
      e.preventDefault();
      traceStep(e.key === '[' ? 'precedents' : 'dependents');
      return;
    }
    if (!st.selection) return;
    if (mod && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      void copySelection(false);
      return;
    }
    if (mod && e.key.toLowerCase() === 'x') {
      e.preventDefault();
      void copySelection(true);
      return;
    }
    if (mod && e.key.toLowerCase() === 'v') {
      // handled by the paste event when clipboard permission allows; fallback:
      return;
    }
    if (mod && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      toggleBold();
      return;
    }
    if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      fillDown();
      return;
    }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      const meta = st.tables.get(st.selection.table)!;
      selectRange(meta.id, 0, 0, meta.rows - 1, meta.cols - 1);
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      const sel = st.selection;
      const meta = st.tables.get(sel.table)!;
      if (meta.filters.length) book.apply({ type: 'set_filters', table: sel.table, filters: [] });
      else useStore.setState({ filterPopover: { table: sel.table, col: sel.ac, x: window.innerWidth / 2, y: 120 } });
      return;
    }
    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        moveActive(mod ? -1e9 : -1, 0, e.shiftKey);
        return;
      case 'ArrowDown':
        e.preventDefault();
        moveActive(mod ? 1e9 : 1, 0, e.shiftKey);
        return;
      case 'ArrowLeft':
        e.preventDefault();
        moveActive(0, mod ? -1e9 : -1, e.shiftKey);
        return;
      case 'ArrowRight':
        e.preventDefault();
        moveActive(0, mod ? 1e9 : 1, e.shiftKey);
        return;
      case 'Tab':
        e.preventDefault();
        moveActive(0, e.shiftKey ? -1 : 1);
        return;
      case 'Enter':
        e.preventDefault();
        if (e.altKey) moveActive(e.shiftKey ? -1 : 1, 0);
        else startEdit();
        return;
      case 'F2':
        e.preventDefault();
        startEdit();
        return;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        clearSelection();
        return;
      case 'Escape':
        useStore.setState({ selectedTable: null, filterPopover: null, trace: null });
        this.renderer.markDirty();
        return;
      case 'Home':
        e.preventDefault();
        moveActive(0, -1e9, e.shiftKey);
        return;
      case 'End':
        e.preventDefault();
        moveActive(0, 1e9, e.shiftKey);
        return;
      case 'PageDown':
        e.preventDefault();
        moveActive(20, 0, e.shiftKey);
        return;
      case 'PageUp':
        e.preventDefault();
        moveActive(-20, 0, e.shiftKey);
        return;
    }
    // printable character → start editing in replace mode
    if (!mod && !e.altKey && e.key.length === 1) {
      e.preventDefault();
      startEdit(e.key, true);
    }
  }
}

export function cancelEditing() {
  cancelEdit();
}

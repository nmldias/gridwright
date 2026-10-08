// Pointer and keyboard interaction for the canvas: selection drags, table
// moving, Numbers-style resize handles, column/row resizing, pan/zoom.

import * as book from '../engine/book';
import type { TableId } from '../engine/types';
import { getState, useStore } from '../state/store';
import {
  cancelEdit,
  clearSelection,
  commitEdit,
  copySelection,
  fillDown,
  moveActive,
  pasteFromClipboard,
  selectCell,
  selectRange,
  startEdit,
  toggleBold,
} from './actions';
import { SNAP, cursorFor, hitTest, indexAt, layoutOf, sizeForCorner, type Hit } from './geometry';
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
  | { kind: 'row-select'; table: TableId; r: number };

export class GridController {
  private mode: Mode = { kind: 'idle' };
  private spaceDown = false;
  private lastClick = { t: 0, table: -1, r: -1, c: -1 };
  private detach: (() => void)[] = [];

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
    on(host, 'contextmenu', (e) => e.preventDefault());
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

  private inputFocused(): boolean {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable || !!el.closest('.cm-editor');
  }

  private pointerWorld(e: PointerEvent | WheelEvent) {
    const rect = this.host.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    return { sx, sy, ...this.renderer.screenToWorld(sx, sy) };
  }

  private hit(wx: number, wy: number): Hit {
    const st = getState();
    return hitTest(st.tables, Array.from(st.tables.keys()), wx, wy, st.selectedTable, this.renderer.zoom);
  }

  // ------------------------------------------------------------------
  private onPointerDown(e: PointerEvent) {
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
    this.host.setPointerCapture(e.pointerId);
    switch (h.kind) {
      case 'cell': {
        const now = performance.now();
        const dbl = now - this.lastClick.t < 400 && this.lastClick.table === h.table && this.lastClick.r === h.r && this.lastClick.c === h.c;
        this.lastClick = { t: now, table: h.table, r: h.r, c: h.c };
        if (getState().selectedTable !== null && getState().selectedTable !== h.table) useStore.setState({ selectedTable: null });
        if (dbl) {
          selectCell(h.table, h.r, h.c);
          startEdit();
          this.mode = { kind: 'idle' };
          return;
        }
        selectCell(h.table, h.r, h.c, e.shiftKey);
        this.mode = { kind: 'select', table: h.table };
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

  private beginPan(e: PointerEvent) {
    const rect = this.host.getBoundingClientRect();
    this.mode = { kind: 'pan', sx: e.clientX - rect.left, sy: e.clientY - rect.top, px: this.renderer.pan.x, py: this.renderer.pan.y };
    this.host.setPointerCapture(e.pointerId);
    this.host.style.cursor = 'grabbing';
  }

  private onPointerMove(e: PointerEvent) {
    const { sx, sy, x, y } = this.pointerWorld(e);
    const st = getState();
    switch (this.mode.kind) {
      case 'idle': {
        const h = this.hit(x, y);
        this.host.style.cursor = this.spaceDown ? 'grab' : cursorFor(h);
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
    const mode = this.mode;
    this.mode = { kind: 'idle' };
    try {
      this.host.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.host.style.cursor = 'default';
    switch (mode.kind) {
      case 'move': {
        const p = this.renderer.movePreview;
        this.renderer.movePreview = null;
        if (mode.moved && p) book.apply({ type: 'move_table', table: mode.table, x: p.x, y: p.y });
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
        useStore.setState({ selectedTable: null });
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

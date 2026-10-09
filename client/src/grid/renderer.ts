// WebGL grid renderer built on PixiJS v8. Draws free-floating tables on an
// infinite canvas with viewport culling and pooled bitmap text.

import { Application, Assets, BitmapFontManager, BitmapText, Container, Graphics, Sprite, Texture } from 'pixi.js';
import type { CellView, TableId, TableMeta } from '../engine/types';
import { colToLetters } from '../engine/types';
import { getState, type Presence, type Selection } from '../state/store';
import { FILTER_BTN, HANDLE, HANDLE_GAP, TAB_SIZE, TITLE_H, indexAt, layoutOf } from './geometry';
import { alignOf, displayOf } from './format';
import { condStyle } from './condfmt';

export const FONT = 'Inter, "Segoe UI", Helvetica, Arial, sans-serif';
export const FONT_SIZE = 13;
const PAD = 6;

const COLORS = {
  canvas: 0xf3f4f6,
  tableBg: 0xffffff,
  headerBg: 0xf1f5f9,
  grid: 0xe5e7eb,
  border: 0x9ca3af,
  borderSelected: 0x2563eb,
  text: 0x111827,
  textMuted: 0x6b7280,
  error: 0xb91c1c,
  spill: 0x60a5fa,
  python: 0x2563eb,
  javascript: 0xd97706,
  sql: 0x0f766e,
  invalid: 0xdc2626,
  pivotBg: 0xf8fafc,
  filterBtn: 0x9ca3af,
  filterActive: 0x2563eb,
  selectionFill: 0x3b82f6,
  tab: 0xe5e7eb,
  tabText: 0x4b5563,
  handle: 0x2563eb,
};

const normalStyle = { fontFamily: FONT, fontSize: FONT_SIZE, fill: 0xffffff };
const boldStyle = { fontFamily: FONT, fontSize: FONT_SIZE, fill: 0xffffff, fontWeight: 'bold' as const };
const smallStyle = { fontFamily: FONT, fontSize: 11, fill: 0xffffff };
const titleStyle = { fontFamily: FONT, fontSize: 12, fill: 0xffffff, fontWeight: 'bold' as const };

// --- text measurement (canvas 2D, cached) ---------------------------------
const measureCtx = document.createElement('canvas').getContext('2d')!;
const widthCache = new Map<string, number>();
function textWidth(s: string, bold: boolean): number {
  const key = (bold ? 'b' : 'n') + s;
  let w = widthCache.get(key);
  if (w === undefined) {
    measureCtx.font = `${bold ? 'bold ' : ''}${FONT_SIZE}px ${FONT}`;
    w = measureCtx.measureText(s).width;
    if (widthCache.size > 20000) widthCache.clear();
    widthCache.set(key, w);
  }
  return w;
}
/** Truncate text to fit `maxW` pixels. */
function fit(s: string, maxW: number, bold: boolean): string {
  if (textWidth(s, bold) <= maxW) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textWidth(s.slice(0, mid), bold) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo);
}

function hexToNum(hex?: string): number | null {
  if (!hex) return null;
  const m = hex.trim().replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(m)) return null;
  return parseInt(m, 16);
}

class TextPool {
  private items: BitmapText[] = [];
  private used = 0;
  constructor(private parent: Container) {}
  acquire(style: typeof normalStyle): BitmapText {
    let t = this.items[this.used];
    if (!t) {
      t = new BitmapText({ text: '', style });
      this.parent.addChild(t);
      this.items.push(t);
    } else if (t.style.fontWeight !== (style as any).fontWeight || t.style.fontSize !== style.fontSize) {
      t.style = style as any;
    }
    t.visible = true;
    this.used++;
    return t;
  }
  reset() {
    this.used = 0;
  }
  finish() {
    for (let i = this.used; i < this.items.length; i++) this.items[i].visible = false;
    // trim the pool when it got very large
    if (this.items.length > this.used * 2 + 200) {
      for (let i = this.items.length - 1; i >= this.used + 100; i--) {
        this.items[i].destroy();
        this.items.pop();
      }
    }
  }
}

class TableView {
  container = new Container();
  bg = new Graphics();
  lines = new Graphics();
  imageLayer = new Container();
  textLayer = new Container();
  chrome = new Graphics();
  chromeText = new Container();
  pool: TextPool;
  chromePool: TextPool;
  sprites: Sprite[] = [];
  constructor() {
    this.container.addChild(this.chrome, this.bg, this.lines, this.imageLayer, this.textLayer, this.chromeText);
    this.pool = new TextPool(this.textLayer);
    this.chromePool = new TextPool(this.chromeText);
  }
  destroy() {
    this.container.destroy({ children: true });
  }
}

// --- image cells (data: URLs produced by code cells, e.g. matplotlib figures) ---
const textureCache = new Map<string, Texture | 'loading' | 'failed'>();
let onTextureLoaded: (() => void) | null = null;
function textureFor(url: string): Texture | null {
  const t = textureCache.get(url);
  if (t === 'loading' || t === 'failed') return null;
  if (t) return t;
  textureCache.set(url, 'loading');
  if (textureCache.size > 200) {
    const first = textureCache.keys().next().value;
    if (first) textureCache.delete(first);
  }
  Assets.load<Texture>({ src: url, loadParser: 'loadTextures' })
    .then((tex) => {
      textureCache.set(url, tex);
      onTextureLoaded?.();
    })
    .catch(() => textureCache.set(url, 'failed'));
  return null;
}
export function isImageValue(s: string): boolean {
  return s.startsWith('data:image/');
}

export interface ResizePreview {
  table: TableId;
  rows: number;
  cols: number;
}
export interface ColPreview {
  table: TableId;
  c: number;
  width: number;
}
export interface RowPreview {
  table: TableId;
  r: number;
  height: number;
}
export interface MovePreview {
  table: TableId;
  x: number;
  y: number;
}

export class GridRenderer {
  app = new Application();
  world = new Container();
  tablesLayer = new Container();
  overlay = new Container();
  overlayG = new Graphics();
  overlayText: TextPool;
  views = new Map<TableId, TableView>();
  pan = { x: 0, y: 0 };
  zoom = 1;
  dirty = true;
  resizePreview: ResizePreview | null = null;
  colPreview: ColPreview | null = null;
  rowPreview: RowPreview | null = null;
  movePreview: MovePreview | null = null;
  initialised = false;
  cellsVersion = 0;
  touch = false;
  private raf = 0;
  private host: HTMLElement | null = null;
  viewportListeners = new Set<() => void>();

  constructor() {
    this.overlay.addChild(this.overlayG);
    this.overlayText = new TextPool(this.overlay);
    this.world.addChild(this.tablesLayer, this.overlay);
  }

  async init(host: HTMLElement) {
    this.host = host;
    BitmapFontManager.defaultOptions.resolution = Math.min(2, window.devicePixelRatio || 1);
    await this.app.init({
      resizeTo: host,
      background: COLORS.canvas,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      preference: 'webgl',
    });
    host.appendChild(this.app.canvas);
    this.app.canvas.style.display = 'block';
    this.app.stage.addChild(this.world);
    // Render only when something changed (saves CPU/GPU when idle; Pixi's own
    // ticker would otherwise re-render every frame).
    this.app.ticker.stop();
    const loop = () => {
      if (!this.initialised) return;
      if (this.dirty) {
        this.dirty = false;
        this.draw();
        this.app.renderer.render(this.app.stage);
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    this.initialised = true;
    onTextureLoaded = () => this.markDirty();
    this.markDirty();
  }

  destroy() {
    this.initialised = false;
    cancelAnimationFrame(this.raf);
    this.app.destroy(true, { children: true });
  }

  markDirty() {
    this.dirty = true;
  }

  get viewWidth() {
    return this.app.screen?.width ?? this.host?.clientWidth ?? 0;
  }
  get viewHeight() {
    return this.app.screen?.height ?? this.host?.clientHeight ?? 0;
  }

  screenToWorld(sx: number, sy: number) {
    return { x: (sx - this.pan.x) / this.zoom, y: (sy - this.pan.y) / this.zoom };
  }
  worldToScreen(wx: number, wy: number) {
    return { x: wx * this.zoom + this.pan.x, y: wy * this.zoom + this.pan.y };
  }

  setViewport(panX: number, panY: number, zoom: number) {
    this.pan.x = panX;
    this.pan.y = panY;
    this.zoom = zoom;
    this.world.position.set(panX, panY);
    this.world.scale.set(zoom);
    this.markDirty();
    this.viewportListeners.forEach((l) => l());
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const z = Math.min(4, Math.max(0.2, this.zoom * factor));
    const before = this.screenToWorld(sx, sy);
    this.zoom = z;
    this.pan.x = sx - before.x * z;
    this.pan.y = sy - before.y * z;
    this.setViewport(this.pan.x, this.pan.y, z);
  }

  /** Scroll so the cell is visible (world coords of the cell rect). */
  ensureVisible(x0: number, y0: number, x1: number, y1: number) {
    const s0 = this.worldToScreen(x0, y0);
    const s1 = this.worldToScreen(x1, y1);
    const margin = 24;
    let dx = 0;
    let dy = 0;
    if (s0.x < margin) dx = margin - s0.x;
    else if (s1.x > this.viewWidth - margin) dx = this.viewWidth - margin - s1.x;
    if (s0.y < margin + TITLE_H) dy = margin + TITLE_H - s0.y;
    else if (s1.y > this.viewHeight - margin) dy = this.viewHeight - margin - s1.y;
    if (dx || dy) this.setViewport(this.pan.x + dx, this.pan.y + dy, this.zoom);
  }

  tableOrder(): TableId[] {
    return Array.from(getState().tables.keys());
  }

  // ------------------------------------------------------------------
  draw() {
    const st = getState();
    const { tables, cells, selection, selectedTable } = st;
    this.cellsVersion = st.cellsVersion;
    this.touch = st.touch;
    const vw = this.viewWidth;
    const vh = this.viewHeight;
    const w0 = this.screenToWorld(0, 0);
    const w1 = this.screenToWorld(vw, vh);
    const zoom = this.zoom;

    // remove views of deleted tables
    for (const [id, v] of this.views) {
      if (!tables.has(id)) {
        v.destroy();
        this.views.delete(id);
      }
    }

    for (const meta of tables.values()) {
      let view = this.views.get(meta.id);
      if (!view) {
        view = new TableView();
        this.views.set(meta.id, view);
        this.tablesLayer.addChild(view.container);
      }
      const effective = this.effectiveMeta(meta);
      const pos = this.movePreview?.table === meta.id ? this.movePreview : { x: meta.x, y: meta.y };
      view.container.position.set(pos.x, pos.y);
      const L = layoutOf(effective);
      const isSel = selectedTable === meta.id;
      const visible = pos.x < w1.x && pos.x + L.width + 40 > w0.x && pos.y - TITLE_H - TAB_SIZE < w1.y && pos.y + L.height + 40 > w0.y;
      view.container.visible = visible;
      if (!visible) continue;
      this.drawTable(view, effective, cells.get(meta.id), L, isSel, w0.x - pos.x, w0.y - pos.y, w1.x - pos.x, w1.y - pos.y, zoom);
      // keep selected table on top
      if (isSel) this.tablesLayer.setChildIndex(view.container, this.tablesLayer.children.length - 1);
    }
    this.drawOverlay(selection, selectedTable, tables, zoom, st.presence);
  }

  private effectiveMeta(meta: TableMeta): TableMeta {
    let m = meta;
    if (this.colPreview?.table === meta.id) {
      const cw = meta.col_widths.slice();
      cw[this.colPreview.c] = this.colPreview.width;
      m = { ...m, col_widths: cw };
    }
    if (this.rowPreview?.table === meta.id) {
      const rh = meta.row_heights.slice();
      rh[this.rowPreview.r] = this.rowPreview.height;
      m = { ...m, row_heights: rh };
    }
    return m;
  }

  private drawTable(
    view: TableView,
    meta: TableMeta,
    cellMap: Map<number, CellView> | undefined,
    L: ReturnType<typeof layoutOf>,
    isSel: boolean,
    vx0: number,
    vy0: number,
    vx1: number,
    vy1: number,
    zoom: number,
  ) {
    const { bg, lines, chrome } = view;
    bg.clear();
    lines.clear();
    chrome.clear();
    view.pool.reset();
    view.chromePool.reset();
    let spriteIdx = 0;

    // visible row/col window
    const c0 = Math.max(0, vx0 <= 0 ? 0 : indexAt(L.colX, Math.min(vx0, L.width - 0.01)));
    const c1 = vx1 >= L.width ? meta.cols - 1 : Math.max(c0, indexAt(L.colX, Math.max(0, vx1)));
    const r0 = Math.max(0, vy0 <= 0 ? 0 : indexAt(L.rowY, Math.min(vy0, L.height - 0.01)));
    const r1 = vy1 >= L.height ? meta.rows - 1 : Math.max(r0, indexAt(L.rowY, Math.max(0, vy1)));
    const hairline = 1 / zoom;

    // background + header
    bg.rect(0, 0, L.width, L.height).fill(meta.pivot ? COLORS.pivotBg : COLORS.tableBg);
    const headerH = meta.header_rows > 0 ? L.rowY[Math.min(meta.header_rows, meta.rows)] : 0;
    if (headerH > 0) bg.rect(0, 0, L.width, headerH).fill(COLORS.headerBg);
    const hasRules = meta.cond_formats && meta.cond_formats.length > 0;
    const invalidMarks: { x: number; y: number }[] = [];

    // cell fills, spill tints, code markers, text
    const spillRects: { x: number; y: number; w: number; h: number; color: number }[] = [];
    if (cellMap || hasRules) {
      for (let r = r0; r <= r1; r++) {
        if (L.hidden.has(r)) continue;
        for (let c = c0; c <= c1; c++) {
          const cell = cellMap?.get(r * 65536 + c);
          const cond = hasRules ? condStyle(meta, cellMap, r, c, cell, this.cellsVersion) : null;
          if (!cell && !cond) continue;
          const x0 = L.colX[c];
          const y0 = L.rowY[r];
          const w = L.colX[c + 1] - x0;
          const h = L.rowY[r + 1] - y0;
          const fill = hexToNum(cond?.fill ?? cell?.f?.fill);
          if (fill !== null) bg.rect(x0, y0, w, h).fill(fill);
          if (!cell) continue;
          if (cell.inv) invalidMarks.push({ x: x0 + w, y: y0 });
          if (cell.k === 'python' || cell.k === 'javascript' || cell.k === 'sql') {
            const color = cell.k === 'python' ? COLORS.python : cell.k === 'javascript' ? COLORS.javascript : COLORS.sql;
            bg.poly([x0, y0, x0 + 7, y0, x0, y0 + 7]).fill(color);
            if (cell.ss) {
              const sw = (L.colX[Math.min(meta.cols, c + cell.ss[1])] ?? L.width) - x0;
              const sh = (L.rowY[Math.min(meta.rows, r + cell.ss[0])] ?? L.height) - y0;
              spillRects.push({ x: x0, y: y0, w: sw, h: sh, color });
            }
          } else if (cell.k === 'formula' && cell.ss) {
            const sw = (L.colX[Math.min(meta.cols, c + cell.ss[1])] ?? L.width) - x0;
            const sh = (L.rowY[Math.min(meta.rows, r + cell.ss[0])] ?? L.height) - y0;
            spillRects.push({ x: x0, y: y0, w: sw, h: sh, color: COLORS.spill });
          }
          const text = displayOf(cell);
          if (!text) continue;
          if (cell.ss && cell.v && 's' in cell.v && isImageValue(cell.v.s)) {
            const tex = textureFor(cell.v.s);
            const sw = (L.colX[Math.min(meta.cols, c + cell.ss[1])] ?? L.width) - x0;
            const sh = (L.rowY[Math.min(meta.rows, r + cell.ss[0])] ?? L.height) - y0;
            if (tex) {
              let sp = view.sprites[spriteIdx];
              if (!sp) {
                sp = new Sprite(tex);
                view.imageLayer.addChild(sp);
                view.sprites.push(sp);
              }
              spriteIdx++;
              sp.texture = tex;
              sp.visible = true;
              const scale = Math.min((sw - 4) / tex.width, (sh - 4) / tex.height);
              sp.scale.set(scale);
              sp.position.set(x0 + 2, y0 + 2);
            }
            continue;
          }
          const bold = (cond?.bold ?? !!cell.f?.bold) || r < meta.header_rows;
          const t = view.pool.acquire(bold ? boldStyle : normalStyle);
          const align = alignOf(cell);
          // left-aligned text may overflow into empty cells to the right (spreadsheet convention)
          let avail = w;
          const headerReserve = r < meta.header_rows && (isSel || meta.filters.length > 0) ? FILTER_BTN + 2 : 0;
          if (align === 'left' && cellMap && textWidth(text, bold) > w - PAD * 2 - headerReserve) {
            let cc = c + 1;
            while (cc < meta.cols && avail < 2000) {
              const nb = cellMap.get(r * 65536 + cc);
              if (nb && (nb.i !== '' || nb.v !== null)) break;
              avail += L.colX[cc + 1] - L.colX[cc];
              cc++;
            }
          }
          const maxW = Math.max(4, avail - PAD * 2 - (avail === w ? headerReserve : 0));
          const fitted = fit(text, maxW, bold);
          if (t.text !== fitted) t.text = fitted;
          const isErr = !!cell.v && typeof cell.v === 'object' && 'e' in cell.v;
          const color = hexToNum(cond?.color ?? cell?.f?.color);
          t.tint = isErr ? COLORS.error : color !== null ? color : cell.s ? 0x1e3a8a : COLORS.text;
          const tw = Math.min(t.width, maxW);
          t.x = align === 'right' ? x0 + w - PAD - tw - (avail === w ? headerReserve : 0) : align === 'center' ? x0 + (w - tw) / 2 : x0 + PAD;
          t.y = y0 + (h - t.height) / 2 + 0.5;
        }
      }
    }
    view.pool.finish();
    for (let i = spriteIdx; i < view.sprites.length; i++) view.sprites[i].visible = false;

    // grid lines (only the visible window)
    for (let c = c0; c <= c1 + 1 && c <= meta.cols; c++) {
      lines.moveTo(L.colX[c], 0).lineTo(L.colX[c], L.height);
    }
    for (let r = r0; r <= r1 + 1 && r <= meta.rows; r++) {
      if (r > 0 && r < meta.rows && L.rowY[r] === L.rowY[r + 1]) continue;
      lines.moveTo(0, L.rowY[r]).lineTo(L.width, L.rowY[r]);
    }
    lines.stroke({ width: hairline, color: COLORS.grid });
    if (headerH > 0) lines.moveTo(0, headerH).lineTo(L.width, headerH).stroke({ width: hairline, color: COLORS.border });
    for (const s of spillRects) lines.rect(s.x, s.y, s.w, s.h).stroke({ width: hairline, color: s.color, alpha: 0.7 });
    // validation marks: small red triangle in the top-right corner
    for (const m of invalidMarks) lines.poly([m.x - 6, m.y, m.x, m.y, m.x, m.y + 6]).fill(COLORS.invalid);
    // header filter buttons
    if (meta.header_rows > 0 && (isSel || meta.filters.length > 0) && headerH > 0) {
      for (let c = c0; c <= c1; c++) {
        const active = meta.filters.some((f) => f.col === c);
        const bx = L.colX[c + 1] - FILTER_BTN - 2;
        const by = L.rowY[1] - FILTER_BTN - 2;
        const cx = bx + FILTER_BTN / 2;
        const cy = by + FILTER_BTN / 2;
        lines.roundRect(bx, by, FILTER_BTN, FILTER_BTN, 2).fill({ color: active ? COLORS.filterActive : 0xffffff, alpha: active ? 1 : 0.9 }).stroke({ width: hairline, color: active ? COLORS.filterActive : COLORS.filterBtn });
        lines.poly([cx - 3.5, cy - 2, cx + 3.5, cy - 2, cx, cy + 2.5]).fill(active ? 0xffffff : COLORS.tabText);
      }
    }
    // outer border
    lines.rect(0, 0, L.width, L.height).stroke({ width: isSel ? 1.5 / zoom : hairline, color: isSel ? COLORS.borderSelected : COLORS.border });

    // title bar
    const title = view.chromePool.acquire(titleStyle);
    title.text = fit(meta.pivot ? `${meta.name}  ·  pivot` : meta.name, Math.max(20, L.width - 8), true);
    title.tint = isSel ? COLORS.borderSelected : COLORS.textMuted;
    title.x = 2;
    title.y = -(isSel ? TAB_SIZE : 0) - TITLE_H + (TITLE_H - title.height) / 2;

    // reference tabs + handles when selected
    if (isSel) {
      chrome.rect(-TAB_SIZE, -TAB_SIZE, TAB_SIZE, TAB_SIZE).fill(COLORS.tab);
      chrome.rect(0, -TAB_SIZE, L.width, TAB_SIZE).fill(COLORS.tab);
      chrome.rect(-TAB_SIZE, 0, TAB_SIZE, L.height).fill(COLORS.tab);
      for (let c = c0; c <= c1; c++) {
        const t = view.chromePool.acquire(smallStyle);
        const letters = colToLetters(c);
        if (t.text !== letters) t.text = letters;
        t.tint = COLORS.tabText;
        const w = L.colX[c + 1] - L.colX[c];
        t.x = L.colX[c] + (w - t.width) / 2;
        t.y = -TAB_SIZE + (TAB_SIZE - t.height) / 2;
        chrome.moveTo(L.colX[c + 1], -TAB_SIZE).lineTo(L.colX[c + 1], 0);
      }
      for (let r = r0; r <= r1; r++) {
        if (L.hidden.has(r)) continue;
        const t = view.chromePool.acquire(smallStyle);
        const label = String(r + 1);
        if (t.text !== label) t.text = label;
        t.tint = COLORS.tabText;
        const h = L.rowY[r + 1] - L.rowY[r];
        t.x = -TAB_SIZE + (TAB_SIZE - t.width) / 2;
        t.y = L.rowY[r] + (h - t.height) / 2;
        chrome.moveTo(-TAB_SIZE, L.rowY[r + 1]).lineTo(0, L.rowY[r + 1]);
      }
      chrome.stroke({ width: hairline, color: 0xd1d5db });
      // handles (larger targets on touch screens)
      const hx = L.width + HANDLE_GAP;
      const hy = L.height + HANDLE_GAP;
      const HS = this.touch ? HANDLE + 8 : HANDLE;
      chrome.roundRect(hx, L.height / 2 - 12, HS - 2, 24, 3).fill(0xffffff).stroke({ width: 1.2 / zoom, color: COLORS.handle });
      chrome.roundRect(L.width / 2 - 12, hy, 24, HS - 2, 3).fill(0xffffff).stroke({ width: 1.2 / zoom, color: COLORS.handle });
      chrome.circle(hx + HANDLE / 2, hy + HANDLE / 2, HS / 2).fill(0xffffff).stroke({ width: 1.5 / zoom, color: COLORS.handle });
      // grip marks
      chrome.moveTo(hx + 3, L.height / 2 - 5).lineTo(hx + 3, L.height / 2 + 5).moveTo(hx + 6, L.height / 2 - 5).lineTo(hx + 6, L.height / 2 + 5);
      chrome.moveTo(L.width / 2 - 5, hy + 3).lineTo(L.width / 2 + 5, hy + 3).moveTo(L.width / 2 - 5, hy + 6).lineTo(L.width / 2 + 5, hy + 6);
      chrome.stroke({ width: 1 / zoom, color: COLORS.handle });
    }
    view.chromePool.finish();

    // resize preview outline
    if (this.resizePreview?.table === meta.id) {
      const p = this.resizePreview;
      const avgW = meta.cols ? L.width / meta.cols : 100;
      const avgH = meta.rows ? L.height / meta.rows : 24;
      const pw = p.cols <= meta.cols ? L.colX[p.cols] : L.width + (p.cols - meta.cols) * avgW;
      const ph = p.rows <= meta.rows ? L.rowY[p.rows] : L.height + (p.rows - meta.rows) * avgH;
      chrome.rect(0, 0, pw, ph).fill({ color: COLORS.selectionFill, alpha: 0.06 }).stroke({ width: 1.5 / zoom, color: COLORS.handle });
      const t = view.chromePool.acquire(smallStyle);
      t.visible = true;
      t.text = `${p.rows} × ${p.cols}`;
      t.tint = COLORS.handle;
      t.x = pw + 6;
      t.y = ph + 6;
    }
  }

  private drawOverlay(selection: Selection | null, selectedTable: TableId | null, tables: Map<TableId, TableMeta>, zoom: number, presence: Map<string, Presence>) {
    const g = this.overlayG;
    g.clear();
    this.overlayText.reset();
    if (selection && tables.has(selection.table)) {
      const meta = this.effectiveMeta(tables.get(selection.table)!);
      const pos = this.movePreview?.table === meta.id ? this.movePreview : { x: meta.x, y: meta.y };
      const L = layoutOf(meta);
      const r0 = Math.min(selection.r0, meta.rows - 1);
      const r1 = Math.min(selection.r1, meta.rows - 1);
      const c0 = Math.min(selection.c0, meta.cols - 1);
      const c1 = Math.min(selection.c1, meta.cols - 1);
      const x0 = pos.x + L.colX[c0];
      const y0 = pos.y + L.rowY[r0];
      const x1 = pos.x + L.colX[c1 + 1];
      const y1 = pos.y + L.rowY[r1 + 1];
      const multi = r0 !== r1 || c0 !== c1;
      if (multi) g.rect(x0, y0, x1 - x0, y1 - y0).fill({ color: COLORS.selectionFill, alpha: 0.12 });
      g.rect(x0, y0, x1 - x0, y1 - y0).stroke({ width: 1.5 / zoom, color: COLORS.borderSelected });
      // active cell
      const ar = Math.min(selection.ar, meta.rows - 1);
      const ac = Math.min(selection.ac, meta.cols - 1);
      const ax0 = pos.x + L.colX[ac];
      const ay0 = pos.y + L.rowY[ar];
      g.rect(ax0, ay0, L.colX[ac + 1] - L.colX[ac], L.rowY[ar + 1] - L.rowY[ar]).stroke({ width: 2 / zoom, color: COLORS.borderSelected });
      // fill handle
      g.rect(x1 - 3 / zoom, y1 - 3 / zoom, 6 / zoom, 6 / zoom).fill(COLORS.borderSelected).stroke({ width: 1 / zoom, color: 0xffffff });
      // column/row tabs highlight on the selected table
      if (selectedTable === meta.id) {
        g.rect(x0, pos.y - TAB_SIZE, x1 - x0, TAB_SIZE).fill({ color: COLORS.selectionFill, alpha: 0.18 });
        g.rect(pos.x - TAB_SIZE, y0, TAB_SIZE, y1 - y0).fill({ color: COLORS.selectionFill, alpha: 0.18 });
      }
    }
    // presence
    for (const p of presence.values()) {
      if (p.table === undefined || p.r === undefined || p.c === undefined) continue;
      const meta = tables.get(p.table);
      if (!meta) continue;
      const L = layoutOf(meta);
      if (p.r >= meta.rows || p.c >= meta.cols) continue;
      const color = hexToNum(p.color) ?? 0x10b981;
      const x0 = meta.x + L.colX[p.c];
      const y0 = meta.y + L.rowY[p.r];
      g.rect(x0, y0, L.colX[p.c + 1] - L.colX[p.c], L.rowY[p.r + 1] - L.rowY[p.r]).stroke({ width: 2 / zoom, color });
      const t = this.overlayText.acquire(smallStyle);
      t.text = p.name;
      t.tint = 0xffffff;
      const lw = t.width + 8;
      g.roundRect(x0, y0 - 16, lw, 15, 3).fill(color);
      t.x = x0 + 4;
      t.y = y0 - 15;
    }
    this.overlayText.finish();
  }
}

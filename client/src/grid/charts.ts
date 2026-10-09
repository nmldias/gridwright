// Charts as exhibits: a shared layout produces drawing primitives from a chart
// object and its data; the Pixi backend (renderer) and the SVG backend (print,
// export) both consume the same primitives, so a printed chart matches the canvas.
//
// Style: action title, grey subtitle with units, an uppercase "EXHIBIT N — TOPIC"
// tag, a restrained palette (navy for primary lines and labels, light navy for
// neutral bars, coral for the one highlighted observation, grey for axes and
// reference lines), faint gridlines, no legend (series are labelled directly),
// square bar corners, a dashed reference line with an inline label, a 3-column
// stat-card strip and a source footnote.

import type { Chart } from '../engine/types';
import * as book from '../engine/book';
import { getState } from '../state/store';

export const PALETTE = {
  navy: '#0C447C',
  lightNavy: '#85B7EB',
  coral: '#993C1D',
  grey: '#5F5E5A',
  text: '#1F1F1F',
  gridline: '#E6E6E3',
  card: '#F6F6F4',
  paper: '#FFFFFF',
};
const SERIES_COLORS = [PALETTE.navy, PALETTE.lightNavy, PALETTE.grey, '#C9D6E3', '#2F6FB0', '#A8A7A2'];

export interface ChartSeriesData {
  name: string;
  values: (number | null)[];
  color: string;
}
export interface ChartData {
  categories: string[];
  series: ChartSeriesData[];
  error?: string;
}

export type Prim =
  | { k: 'rect'; x: number; y: number; w: number; h: number; fill: string; alpha?: number }
  | { k: 'line'; pts: [number, number][]; stroke: string; width: number; dash?: boolean; alpha?: number }
  | { k: 'area'; pts: [number, number][]; fill: string; alpha: number }
  | { k: 'circle'; cx: number; cy: number; r: number; fill: string }
  | { k: 'text'; x: number; y: number; text: string; size: number; color: string; anchor: 'start' | 'middle' | 'end'; baseline: 'top' | 'middle' | 'bottom'; weight?: 400 | 500; spacing?: number };

export const CHART_FONT = 'Inter, "Segoe UI", Helvetica, Arial, sans-serif';

// --- text measurement -------------------------------------------------------------
const ctx = document.createElement('canvas').getContext('2d');
const widths = new Map<string, number>();
export function measure(text: string, size: number, weight: 400 | 500 = 400): number {
  const key = `${size}/${weight}/${text}`;
  const hit = widths.get(key);
  if (hit !== undefined) return hit;
  let w = text.length * size * 0.55;
  if (ctx) {
    ctx.font = `${weight} ${size}px ${CHART_FONT}`;
    w = ctx.measureText(text).width;
  }
  if (widths.size > 20000) widths.clear();
  widths.set(key, w);
  return w;
}
function clip(text: string, size: number, maxW: number): string {
  if (measure(text, size) <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(text.slice(0, mid) + '…', size) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? '' : text.slice(0, lo) + '…';
}
/** Greedy word wrap, at most `maxLines` lines. */
function wrap(text: string, size: number, maxW: number, maxLines: number, weight: 400 | 500 = 400): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const cand = cur ? `${cur} ${w}` : w;
    if (measure(cand, size, weight) <= maxW || !cur) cur = cand;
    else {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && words.join(' ') !== lines.join(' ')) lines[maxLines - 1] = clip(lines[maxLines - 1] + '…', size, maxW);
  return lines;
}

// --- numbers -----------------------------------------------------------------------
export function fmtNum(v: number, compact = true): string {
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(v);
  if (compact && a >= 1e9) return trim(v / 1e9, 1) + 'bn';
  if (compact && a >= 1e6) return trim(v / 1e6, 1) + 'M';
  if (compact && a >= 1e4) return trim(v / 1e3, 1) + 'k';
  if (a >= 100) return trim(v, 0);
  if (a >= 10) return trim(v, 1);
  return trim(v, 2);
}
function trim(v: number, d: number): string {
  const s = v.toFixed(d);
  return d > 0 ? s.replace(/\.?0+$/, '') : s;
}
function niceTicks(lo: number, hi: number, n = 4): number[] {
  if (hi <= lo) hi = lo + 1;
  const span = hi - lo;
  const raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e9) / 1e9);
  return out;
}

// --- data ---------------------------------------------------------------------------
function flatten(rows: (number | string | boolean | null | { e: string })[][] | null): (number | string | boolean | null | { e: string })[] {
  if (!rows) return [];
  if (rows.length === 1) return rows[0];
  return rows.map((r) => r[0] ?? null);
}

export function chartData(chart: Chart): ChartData {
  const st = getState();
  const first = st.tables.values().next().value;
  const ctxTable = first ? first.id : 0;
  const cats = flatten(book.resolveValues(ctxTable, chart.categories)).map((v) => (v === null ? '' : typeof v === 'object' ? ('e' in v ? v.e : '') : typeof v === 'number' ? fmtNum(v, false) : String(v)));
  const series: ChartSeriesData[] = chart.series.map((s, i) => {
    const vals = flatten(book.resolveValues(ctxTable, s.range)).map((v) => (typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : null));
    return { name: s.name || `Series ${i + 1}`, values: vals, color: s.color || SERIES_COLORS[i % SERIES_COLORS.length] };
  });
  const n = Math.max(cats.length, ...series.map((s) => s.values.length));
  while (cats.length < n) cats.push(String(cats.length + 1));
  for (const s of series) while (s.values.length < n) s.values.push(null);
  let error: string | undefined;
  if (!series.length) error = 'add a series';
  else if (series.every((s) => s.values.every((v) => v === null))) error = 'no numeric data in the series ranges';
  return { categories: cats, series, error };
}

// --- layout ---------------------------------------------------------------------------
const PAD = 16;

export function chartLayout(chart: Chart, data: ChartData, W: number, H: number): Prim[] {
  const P: Prim[] = [];
  P.push({ k: 'rect', x: 0, y: 0, w: W, h: H, fill: PALETTE.paper });
  let y = PAD;
  const innerW = W - PAD * 2;
  if (chart.exhibit) {
    P.push({ k: 'text', x: PAD, y, text: chart.exhibit.toUpperCase(), size: 9.5, color: PALETTE.grey, anchor: 'start', baseline: 'top', spacing: 0.8 });
    y += 16;
  }
  const titleLines = chart.title ? wrap(chart.title, 15, innerW, 2, 500) : [];
  for (const line of titleLines) {
    P.push({ k: 'text', x: PAD, y, text: line, size: 15, color: PALETTE.text, anchor: 'start', baseline: 'top', weight: 500 });
    y += 20;
  }
  if (chart.subtitle) {
    P.push({ k: 'text', x: PAD, y: y + 1, text: clip(chart.subtitle, 11, innerW), size: 11, color: PALETTE.grey, anchor: 'start', baseline: 'top' });
    y += 18;
  }
  y += 6;
  // reserve the bottom: footnote and stat cards
  let bottom = H - PAD;
  if (chart.source) {
    bottom -= 14;
    P.push({ k: 'text', x: PAD, y: bottom + 4, text: clip(chart.source.startsWith('Source') ? chart.source : `Source: ${chart.source}`, 9.5, innerW), size: 9.5, color: PALETTE.grey, anchor: 'start', baseline: 'top' });
    bottom -= 4;
  }
  const cards = chart.stat_cards ? statCards(chart, data) : [];
  if (cards.length) {
    const ch = 44;
    bottom -= ch;
    const gap = 10;
    const cw = (innerW - gap * (cards.length - 1)) / cards.length;
    cards.forEach((c, i) => {
      const x = PAD + i * (cw + gap);
      P.push({ k: 'rect', x, y: bottom, w: cw, h: ch, fill: PALETTE.card });
      P.push({ k: 'rect', x, y: bottom, w: cw, h: 1.5, fill: c.accent ?? PALETTE.navy });
      P.push({ k: 'text', x: x + 10, y: bottom + 9, text: clip(c.value, 16, cw - 20), size: 16, color: c.accent ?? PALETTE.navy, anchor: 'start', baseline: 'top', weight: 500 });
      P.push({ k: 'text', x: x + 10, y: bottom + 30, text: clip(c.label, 9.5, cw - 20), size: 9.5, color: PALETTE.grey, anchor: 'start', baseline: 'top' });
    });
    bottom -= 12;
  }
  if (data.error) {
    P.push({ k: 'text', x: W / 2, y: (y + bottom) / 2, text: data.error, size: 12, color: PALETTE.grey, anchor: 'middle', baseline: 'middle' });
    return P;
  }
  const plot = { x: PAD, y, w: innerW, h: Math.max(40, bottom - y) };
  switch (chart.kind) {
    case 'hbar':
      drawHBars(P, chart, data, plot);
      break;
    case 'line':
    case 'area':
      drawLines(P, chart, data, plot, chart.kind === 'area');
      break;
    case 'waterfall':
      drawWaterfall(P, chart, data, plot);
      break;
    case 'stacked':
      drawBars(P, chart, data, plot, true);
      break;
    default:
      drawBars(P, chart, data, plot, false);
  }
  return P;
}

interface Plot {
  x: number;
  y: number;
  w: number;
  h: number;
}

function statCards(chart: Chart, data: ChartData): { label: string; value: string; accent?: string }[] {
  const s = data.series[0];
  if (!s) return [];
  const vals = s.values.filter((v): v is number => v !== null);
  if (!vals.length) return [];
  const total = vals.reduce((a, b) => a + b, 0);
  // "Amount" → "total amount", but acronyms such as "In AOA" keep their case
  const name = /[A-Z]/.test(s.name.slice(1)) ? s.name : s.name.charAt(0).toLowerCase() + s.name.slice(1);
  const cards: { label: string; value: string; accent?: string }[] = [
    { label: `Total ${name}`, value: fmtNum(total) },
    { label: `Average per ${data.categories.length > 12 ? 'point' : 'category'}`, value: fmtNum(total / vals.length) },
  ];
  const hi = chart.highlight ?? null;
  if (hi !== null && hi >= 0 && hi < s.values.length && s.values[hi] !== null) {
    cards.push({ label: `${data.categories[hi]} (highlighted)`, value: fmtNum(s.values[hi] as number), accent: PALETTE.coral });
  } else {
    let best = 0;
    s.values.forEach((v, i) => {
      if (v !== null && (s.values[best] === null || v > (s.values[best] as number))) best = i;
    });
    cards.push({ label: `Highest: ${data.categories[best]}`, value: fmtNum(s.values[best] as number) });
  }
  return cards;
}

/** Vertical axis: gridlines + tick labels; returns the y mapper. */
function yAxis(P: Prim[], plot: Plot, lo: number, hi: number, labelW: number): (v: number) => number {
  const ticks = niceTicks(lo, hi);
  const tlo = Math.min(lo, ticks[0] ?? lo);
  const thi = Math.max(hi, ticks[ticks.length - 1] ?? hi);
  const map = (v: number) => plot.y + plot.h - ((v - tlo) / (thi - tlo || 1)) * plot.h;
  for (const t of ticks) {
    const yy = map(t);
    P.push({ k: 'line', pts: [[plot.x + labelW, yy], [plot.x + plot.w, yy]], stroke: t === 0 ? PALETTE.grey : PALETTE.gridline, width: t === 0 ? 1 : 0.8, alpha: t === 0 ? 0.7 : 1 });
    P.push({ k: 'text', x: plot.x + labelW - 6, y: yy, text: fmtNum(t), size: 10, color: PALETTE.grey, anchor: 'end', baseline: 'middle' });
  }
  return map;
}

function range(values: number[], zero = true): [number, number] {
  let lo = zero ? 0 : Infinity;
  let hi = zero ? 0 : -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (lo === hi) return lo === 0 ? [0, 1] : [Math.min(0, lo), Math.max(0, hi)];
  const pad = (hi - lo) * 0.08;
  return [lo < 0 ? lo - pad : lo, hi > 0 ? hi + pad : hi];
}

function referenceLine(P: Prim[], chart: Chart, plot: Plot, map: (v: number) => number, x0: number, x1: number) {
  const ref = chart.reference;
  if (!ref || !Number.isFinite(ref.value)) return;
  const yy = map(ref.value);
  if (yy < plot.y - 2 || yy > plot.y + plot.h + 2) return;
  P.push({ k: 'line', pts: [[x0, yy], [x1, yy]], stroke: PALETTE.grey, width: 1, dash: true });
  const label = ref.label ? `${ref.label} ${fmtNum(ref.value)}` : fmtNum(ref.value);
  P.push({ k: 'text', x: x1, y: yy - 3, text: label, size: 10, color: PALETTE.grey, anchor: 'end', baseline: 'bottom' });
}

function categoryLabels(P: Prim[], cats: string[], slot: (i: number) => number, slotW: number, y: number) {
  const size = 10;
  const every = Math.max(1, Math.ceil((measure('Mmmmmm', size) + 6) / Math.max(1, slotW)));
  cats.forEach((c, i) => {
    if (i % every !== 0 && i !== cats.length - 1) return;
    if (i === cats.length - 1 && i % every !== 0 && every > 1 && measure(c, size) > slotW * (every - 1)) return;
    P.push({ k: 'text', x: slot(i), y: y + 6, text: clip(c, size, Math.max(slotW * every - 4, 24)), size, color: PALETTE.grey, anchor: 'middle', baseline: 'top' });
  });
}

function drawBars(P: Prim[], chart: Chart, data: ChartData, plot: Plot, stacked: boolean) {
  const n = data.categories.length;
  const S = data.series;
  let vals: number[] = [];
  if (stacked) {
    for (let i = 0; i < n; i++) {
      let pos = 0;
      let neg = 0;
      for (const s of S) {
        const v = s.values[i] ?? 0;
        if (v >= 0) pos += v;
        else neg += v;
      }
      vals.push(pos, neg);
    }
  } else vals = S.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const [lo, hi] = range(vals);
  const labelW = Math.max(...niceTicks(lo, hi).map((t) => measure(fmtNum(t), 10))) + 10;
  const axisH = 20;
  // several series are labelled directly at the right edge of the plot (no legend)
  const endLabelW = S.length > 1 ? Math.min(plot.w * 0.3, Math.max(...S.map((s) => measure(s.name, 10))) + 14) : 0;
  const inner: Plot = { ...plot, h: plot.h - axisH, w: plot.w - endLabelW };
  const map = yAxis(P, inner, lo, hi, labelW);
  const x0 = inner.x + labelW;
  const pw = inner.w - labelW;
  const slotW = pw / Math.max(1, n);
  const groupW = slotW * 0.72;
  const barW = stacked ? groupW : groupW / Math.max(1, S.length);
  const zeroY = map(0);
  if (S.length > 1 && n > 0) {
    // anchor each label at the top of the series' last bar, nudged apart so they never overlap
    const last = n - 1;
    let stack = 0;
    const anchors = S.map((s, si) => {
      const v = s.values[last] ?? 0;
      let yy: number;
      if (stacked) {
        yy = map(stack + v / 2);
        stack += v;
      } else yy = map(Math.max(v, 0)) - 4;
      return { si, y: yy, name: s.name, color: S.length === 1 ? PALETTE.navy : s.color };
    });
    anchors.sort((a, b) => a.y - b.y);
    for (let i = 1; i < anchors.length; i++) if (anchors[i].y < anchors[i - 1].y + 12) anchors[i].y = anchors[i - 1].y + 12;
    for (const a of anchors) {
      P.push({ k: 'rect', x: inner.x + inner.w + 4, y: a.y - 3, w: 6, h: 6, fill: a.color });
      P.push({ k: 'text', x: inner.x + inner.w + 14, y: a.y, text: clip(a.name, 10, endLabelW - 16), size: 10, color: a.color === PALETTE.lightNavy ? PALETTE.navy : a.color, anchor: 'start', baseline: 'middle' });
    }
  }
  for (let i = 0; i < n; i++) {
    const gx = x0 + i * slotW + (slotW - groupW) / 2;
    let stackPos = 0;
    let stackNeg = 0;
    S.forEach((s, si) => {
      const v = s.values[i];
      if (v === null) return;
      let fill = S.length === 1 ? PALETTE.lightNavy : s.color;
      if (chart.highlight === i && (S.length === 1 || si === 0)) fill = PALETTE.coral;
      let yTop: number;
      let yBot: number;
      if (stacked) {
        if (v >= 0) {
          yTop = map(stackPos + v);
          yBot = map(stackPos);
          stackPos += v;
        } else {
          yTop = map(stackNeg);
          yBot = map(stackNeg + v);
          stackNeg += v;
        }
      } else {
        yTop = Math.min(map(v), zeroY);
        yBot = Math.max(map(v), zeroY);
      }
      const bx = stacked ? gx : gx + si * barW;
      P.push({ k: 'rect', x: bx, y: yTop, w: Math.max(1, barW - (stacked ? 0 : 2)), h: Math.max(0.5, yBot - yTop), fill });
      if (chart.show_values && !stacked && barW >= 18) {
        P.push({ k: 'text', x: bx + barW / 2 - 1, y: v >= 0 ? yTop - 3 : yBot + 3, text: fmtNum(v), size: 10, color: chart.highlight === i ? PALETTE.coral : PALETTE.navy, anchor: 'middle', baseline: v >= 0 ? 'bottom' : 'top' });
      }
    });
    if (chart.show_values && stacked && slotW >= 24) {
      P.push({ k: 'text', x: gx + groupW / 2, y: map(stackPos) - 3, text: fmtNum(stackPos + stackNeg), size: 10, color: PALETTE.navy, anchor: 'middle', baseline: 'bottom' });
    }
  }
  categoryLabels(P, data.categories, (i) => x0 + i * slotW + slotW / 2, slotW, inner.y + inner.h);
  referenceLine(P, chart, inner, map, x0, inner.x + inner.w);
}

function drawHBars(P: Prim[], chart: Chart, data: ChartData, plot: Plot) {
  const n = data.categories.length;
  const s = data.series[0];
  const vals = s.values.filter((v): v is number => v !== null);
  const [lo, hi] = range(vals);
  const labelW = Math.min(plot.w * 0.35, Math.max(...data.categories.map((c) => measure(c, 10))) + 12);
  const x0 = plot.x + labelW;
  const pw = plot.w - labelW - 40;
  const map = (v: number) => x0 + ((v - lo) / (hi - lo || 1)) * pw;
  const slotH = plot.h / Math.max(1, n);
  const barH = Math.min(28, slotH * 0.68);
  for (const t of niceTicks(lo, hi)) {
    const xx = map(t);
    P.push({ k: 'line', pts: [[xx, plot.y], [xx, plot.y + plot.h]], stroke: t === 0 ? PALETTE.grey : PALETTE.gridline, width: t === 0 ? 1 : 0.8, alpha: t === 0 ? 0.7 : 1 });
  }
  for (let i = 0; i < n; i++) {
    const v = s.values[i];
    const cy = plot.y + i * slotH + slotH / 2;
    P.push({ k: 'text', x: x0 - 8, y: cy, text: clip(data.categories[i], 10, labelW - 10), size: 10, color: PALETTE.grey, anchor: 'end', baseline: 'middle' });
    if (v === null) continue;
    const fill = chart.highlight === i ? PALETTE.coral : PALETTE.lightNavy;
    const xa = Math.min(map(v), map(0));
    const xb = Math.max(map(v), map(0));
    P.push({ k: 'rect', x: xa, y: cy - barH / 2, w: Math.max(0.5, xb - xa), h: barH, fill });
    if (chart.show_values) P.push({ k: 'text', x: v >= 0 ? xb + 5 : xa - 5, y: cy, text: fmtNum(v), size: 10, color: chart.highlight === i ? PALETTE.coral : PALETTE.navy, anchor: v >= 0 ? 'start' : 'end', baseline: 'middle' });
  }
  const ref = chart.reference;
  if (ref && Number.isFinite(ref.value)) {
    const xx = map(ref.value);
    if (xx >= x0 - 1 && xx <= x0 + pw + 1) {
      P.push({ k: 'line', pts: [[xx, plot.y], [xx, plot.y + plot.h]], stroke: PALETTE.grey, width: 1, dash: true });
      P.push({ k: 'text', x: xx + 4, y: plot.y + 2, text: ref.label ? `${ref.label} ${fmtNum(ref.value)}` : fmtNum(ref.value), size: 10, color: PALETTE.grey, anchor: 'start', baseline: 'top' });
    }
  }
}

function drawLines(P: Prim[], chart: Chart, data: ChartData, plot: Plot, area: boolean) {
  const n = data.categories.length;
  const S = data.series;
  const vals = S.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const [lo, hi] = range(vals, area);
  const labelW = Math.max(...niceTicks(lo, hi).map((t) => measure(fmtNum(t), 10))) + 10;
  const endLabelW = Math.min(plot.w * 0.3, Math.max(...S.map((s) => measure(s.name, 10))) + 10);
  const axisH = 20;
  const inner: Plot = { ...plot, h: plot.h - axisH };
  const map = yAxis(P, inner, lo, hi, labelW);
  const x0 = inner.x + labelW;
  const pw = inner.w - labelW - endLabelW;
  const xAt = (i: number) => x0 + (n <= 1 ? pw / 2 : (i / (n - 1)) * pw);
  S.forEach((s, si) => {
    const color = S.length === 1 ? PALETTE.navy : s.color;
    const pts: [number, number][] = [];
    s.values.forEach((v, i) => {
      if (v !== null) pts.push([xAt(i), map(v)]);
    });
    if (pts.length < 1) return;
    if (area) {
      const base = map(Math.max(lo, 0));
      P.push({ k: 'area', pts: [[pts[0][0], base], ...pts, [pts[pts.length - 1][0], base]], fill: color, alpha: si === 0 ? 0.16 : 0.1 });
    }
    P.push({ k: 'line', pts, stroke: color, width: si === 0 ? 2 : 1.5 });
    const last = pts[pts.length - 1];
    P.push({ k: 'text', x: last[0] + 6, y: last[1], text: clip(s.name, 10, endLabelW - 4), size: 10, color, anchor: 'start', baseline: 'middle' });
    if (chart.highlight !== null && chart.highlight !== undefined && si === 0) {
      const hv = s.values[chart.highlight];
      if (hv !== null && hv !== undefined) {
        P.push({ k: 'circle', cx: xAt(chart.highlight), cy: map(hv), r: 4, fill: PALETTE.coral });
        P.push({ k: 'text', x: xAt(chart.highlight), y: map(hv) - 7, text: fmtNum(hv), size: 10, color: PALETTE.coral, anchor: 'middle', baseline: 'bottom', weight: 500 });
      }
    } else if (chart.show_values && S.length === 1 && n <= 16) {
      s.values.forEach((v, i) => {
        if (v !== null) P.push({ k: 'text', x: xAt(i), y: map(v) - 5, text: fmtNum(v), size: 9.5, color: PALETTE.navy, anchor: 'middle', baseline: 'bottom' });
      });
    }
  });
  categoryLabels(P, data.categories, xAt, n > 1 ? pw / (n - 1) : pw, inner.y + inner.h);
  referenceLine(P, chart, inner, map, x0, x0 + pw);
}

function drawWaterfall(P: Prim[], chart: Chart, data: ChartData, plot: Plot) {
  const s = data.series[0];
  const deltas = s.values.map((v) => v ?? 0);
  const cats = [...data.categories, 'Total'];
  const cum: number[] = [];
  let run = 0;
  for (const d of deltas) {
    run += d;
    cum.push(run);
  }
  const vals = [0, ...cum];
  const [lo, hi] = range(vals);
  const labelW = Math.max(...niceTicks(lo, hi).map((t) => measure(fmtNum(t), 10))) + 10;
  const axisH = 20;
  const inner: Plot = { ...plot, h: plot.h - axisH };
  const map = yAxis(P, inner, lo, hi, labelW);
  const x0 = inner.x + labelW;
  const pw = inner.w - labelW;
  const n = cats.length;
  const slotW = pw / n;
  const barW = slotW * 0.64;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const bx = x0 + i * slotW + (slotW - barW) / 2;
    const isTotal = i === n - 1;
    const from = isTotal ? 0 : prev;
    const to = isTotal ? run : cum[i];
    const yA = Math.min(map(from), map(to));
    const yB = Math.max(map(from), map(to));
    const fill = isTotal ? PALETTE.navy : chart.highlight === i ? PALETTE.coral : to >= from ? PALETTE.lightNavy : PALETTE.grey;
    P.push({ k: 'rect', x: bx, y: yA, w: barW, h: Math.max(0.5, yB - yA), fill });
    if (i > 0 && !isTotal) P.push({ k: 'line', pts: [[bx - (slotW - barW), map(prev)], [bx, map(prev)]], stroke: PALETTE.grey, width: 0.8, dash: true });
    if (chart.show_values) {
      const v = isTotal ? run : deltas[i];
      P.push({ k: 'text', x: bx + barW / 2, y: yA - 3, text: isTotal ? fmtNum(v) : (v >= 0 ? '+' : '') + fmtNum(v), size: 10, color: isTotal ? PALETTE.navy : chart.highlight === i ? PALETTE.coral : PALETTE.grey, anchor: 'middle', baseline: 'bottom' });
    }
    prev = to;
  }
  categoryLabels(P, cats, (i) => x0 + i * slotW + slotW / 2, slotW, inner.y + inner.h);
  referenceLine(P, chart, inner, map, x0, inner.x + inner.w);
}

// --- SVG backend -----------------------------------------------------------------------
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function chartSvg(chart: Chart, data: ChartData, W = chart.w, H = chart.h): string {
  const prims = chartLayout(chart, data, W, H);
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${esc(CHART_FONT)}">`];
  for (const p of prims) {
    switch (p.k) {
      case 'rect':
        out.push(`<rect x="${r(p.x)}" y="${r(p.y)}" width="${r(p.w)}" height="${r(p.h)}" fill="${p.fill}"${p.alpha !== undefined ? ` fill-opacity="${p.alpha}"` : ''}/>`);
        break;
      case 'line':
        out.push(`<polyline points="${p.pts.map(([x, y]) => `${r(x)},${r(y)}`).join(' ')}" fill="none" stroke="${p.stroke}" stroke-width="${p.width}"${p.dash ? ' stroke-dasharray="4 3"' : ''}${p.alpha !== undefined ? ` stroke-opacity="${p.alpha}"` : ''} stroke-linejoin="round" stroke-linecap="round"/>`);
        break;
      case 'area':
        out.push(`<polygon points="${p.pts.map(([x, y]) => `${r(x)},${r(y)}`).join(' ')}" fill="${p.fill}" fill-opacity="${p.alpha}"/>`);
        break;
      case 'circle':
        out.push(`<circle cx="${r(p.cx)}" cy="${r(p.cy)}" r="${p.r}" fill="${p.fill}"/>`);
        break;
      case 'text': {
        const anchor = p.anchor === 'middle' ? 'middle' : p.anchor === 'end' ? 'end' : 'start';
        const baseline = p.baseline === 'top' ? 'hanging' : p.baseline === 'middle' ? 'middle' : 'auto';
        out.push(`<text x="${r(p.x)}" y="${r(p.y)}" font-size="${p.size}" fill="${p.color}" text-anchor="${anchor}" dominant-baseline="${baseline}"${p.weight === 500 ? ' font-weight="500"' : ''}${p.spacing ? ` letter-spacing="${p.spacing}"` : ''}>${esc(p.text)}</text>`);
        break;
      }
    }
  }
  out.push('</svg>');
  return out.join('');
}
const r = (v: number) => Math.round(v * 100) / 100;

/** Rasterise the SVG to a PNG blob (2× resolution). */
export async function chartPng(chart: Chart, data: ChartData, scale = 2): Promise<Blob> {
  const svg = chartSvg(chart, data);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('could not render the chart'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(chart.w * scale);
    canvas.height = Math.round(chart.h * scale);
    const c = canvas.getContext('2d')!;
    c.scale(scale, scale);
    c.drawImage(img, 0, 0);
    return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('png failed'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

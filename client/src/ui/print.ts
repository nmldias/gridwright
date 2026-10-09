// Print / PDF: tables as HTML (formats, merges, filters honoured) and charts as SVG in a new
// window that calls window.print(). "Save as PDF" in the browser's print dialog gives the file.

import { displayOf, alignOf } from '../grid/format';
import { chartData, chartSvg } from '../grid/charts';
import { getState } from '../state/store';
import type { TableId } from '../engine/types';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function tableHtml(id: TableId): string {
  const st = getState();
  const meta = st.tables.get(id);
  if (!meta) return '';
  const cells = st.cells.get(id);
  const hidden = new Set(meta.hidden_rows ?? []);
  const inner = new Set<number>();
  const mergeAt = new Map<number, { rs: number; cs: number }>();
  for (const m of meta.merges ?? []) {
    mergeAt.set(m.r0 * 65536 + m.c0, { rs: m.r1 - m.r0 + 1, cs: m.c1 - m.c0 + 1 });
    for (let r = m.r0; r <= m.r1; r++) for (let c = m.c0; c <= m.c1; c++) if (r !== m.r0 || c !== m.c0) inner.add(r * 65536 + c);
  }
  // trim trailing empty rows/columns
  let lastR = -1;
  let lastC = -1;
  for (const v of cells?.values() ?? []) {
    if (v.i === '' && v.v === null) continue;
    if (v.r > lastR) lastR = v.r;
    if (v.c > lastC) lastC = v.c;
  }
  if (lastR < 0) return `<section class="table"><h2>${esc(meta.name)}</h2><p class="muted">empty</p></section>`;
  const out: string[] = [`<section class="table"><h2>${esc(meta.name)}</h2><table>`];
  const widths = meta.col_widths.slice(0, lastC + 1);
  out.push('<colgroup>' + widths.map((w) => `<col style="width:${Math.round(w)}px">`).join('') + '</colgroup>');
  for (let r = 0; r <= lastR; r++) {
    if (hidden.has(r)) continue;
    const isHeader = r < meta.header_rows;
    out.push(isHeader ? '<tr class="h">' : '<tr>');
    for (let c = 0; c <= lastC; c++) {
      if (inner.has(r * 65536 + c)) continue;
      const cell = cells?.get(r * 65536 + c);
      const m = mergeAt.get(r * 65536 + c);
      const span = m ? ` rowspan="${m.rs}" colspan="${m.cs}"` : '';
      if (!cell) {
        out.push(`<td${span}></td>`);
        continue;
      }
      const styles: string[] = [];
      const align = m && !cell.f?.align ? 'center' : alignOf(cell);
      styles.push(`text-align:${align}`);
      if (cell.f?.bold) styles.push('font-weight:600');
      if (cell.f?.italic) styles.push('font-style:italic');
      if (cell.f?.fill) styles.push(`background:${cell.f.fill}`);
      if (cell.f?.color) styles.push(`color:${cell.f.color}`);
      if (cell.f?.wrap) styles.push('white-space:normal');
      const isErr = !!cell.v && typeof cell.v === 'object' && 'e' in cell.v;
      if (isErr) styles.push('color:#b91c1c');
      const text = displayOf(cell);
      const img = cell.v && 's' in cell.v && cell.v.s.startsWith('data:image/') ? `<img src="${cell.v.s}" alt="">` : esc(text);
      out.push(`<td${span} style="${styles.join(';')}">${img}</td>`);
    }
    out.push('</tr>');
  }
  out.push('</table></section>');
  return out.join('');
}

export function chartHtml(id: number): string {
  const chart = getState().charts.find((c) => c.id === id);
  if (!chart) return '';
  return `<section class="chart">${chartSvg(chart, chartData(chart))}</section>`;
}

export function printDocumentHtml(opts: { tables?: TableId[]; charts?: number[]; title?: string } = {}): string {
  const st = getState();
  const tables = opts.tables ?? Array.from(st.tables.keys());
  const charts = opts.charts ?? st.charts.map((c) => c.id);
  const title = opts.title ?? st.fileName;
  const when = new Date().toLocaleString();
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { margin: 14mm; }
  body { font-family: Inter, "Segoe UI", Helvetica, Arial, sans-serif; color: #1f1f1f; font-size: 11px; margin: 0; padding: 16px; }
  header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid #5f5e5a; padding-bottom: 6px; margin-bottom: 14px; }
  header h1 { font-size: 16px; font-weight: 500; margin: 0; }
  header .muted { color: #5f5e5a; font-size: 10px; }
  section { margin: 0 0 18px; break-inside: avoid; }
  section.table h2 { font-size: 12px; font-weight: 500; color: #0c447c; margin: 0 0 6px; }
  table { border-collapse: collapse; table-layout: fixed; }
  td { border: 1px solid #e5e5e3; padding: 3px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: top; }
  tr.h td { background: #f1f5f9; font-weight: 600; }
  td img { max-width: 100%; }
  section.chart svg { max-width: 100%; height: auto; }
  .muted { color: #5f5e5a; }
  @media print { body { padding: 0; } button { display: none; } }
</style></head><body>
<header><h1>${esc(title)}</h1><span class="muted">${esc(when)}</span></header>
${tables.map(tableHtml).join('\n')}
${charts.map(chartHtml).join('\n')}
</body></html>`;
}

/** Open the print view in a new window and trigger the print dialog. */
export function openPrintView(opts: { tables?: TableId[]; charts?: number[]; title?: string } = {}) {
  const html = printDocumentHtml(opts);
  const w = window.open('', '_blank');
  if (!w) {
    // popup blocked: download instead
    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(opts.title ?? getState().fileName).replace(/[^\w.-]+/g, '_')}.html`;
    a.click();
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}

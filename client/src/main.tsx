import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AuthGate } from './ui/AuthGate';
import './styles.css';
import { applyThemeCss } from './theme';
import { lastRecord, statusOf } from './workers/runs';
import { isTrusted } from './workers/trust';
import { getState, useStore } from './state/store';
import { getRenderer, selectCell } from './grid/actions';
import { displayOf } from './grid/format';
import { numberOverflows } from './grid/renderer';
import { condStyle } from './grid/condfmt';
import * as book from './engine/book';
import * as review from './ui/review';
import * as charts from './grid/charts';
import * as crossfilter from './grid/crossfilter';
import * as decomp from './grid/decomp';
import { printDocumentHtml } from './ui/print';
import { applyTemplate } from './ui/templates';
import { transformOp } from './api/ws';
import { diffDocuments } from './ui/compare';

applyThemeCss();

// Introspection hooks for tests and debugging (window.__gw)
(window as any).__gw = {
  getState,
  selectCell,
  book,
  review,
  charts,
  crossfilter,
  printDocumentHtml,
  applyTemplate,
  transformOp,
  diffDocuments,
  /** the last run record of a cell, and whether a code cell would run without review (tests) */
  lastRecord,
  isTrusted,
  /** numeric cells of a table whose display text does not fit their column (tests) */
  overflows: (table: number) => {
    const st = getState();
    const meta = st.tables.get(table);
    const map = st.cells.get(table);
    if (!meta || !map) return [];
    const out: string[] = [];
    for (const cell of map.values()) {
      if (!cell.v || !('n' in cell.v) || cell.s) continue;
      const text = displayOf(cell);
      const bold = !!cell.f?.bold || cell.r < meta.header_rows;
      if (numberOverflows(text, bold, meta.col_widths[cell.c] ?? 0)) out.push(`${cell.r},${cell.c}:${text}`);
    }
    return out;
  },
  /** the text a cell shows on the grid (tests) */
  display: (table: number, r: number, c: number) => {
    const cell = getState().cells.get(table)?.get(r * 65536 + c);
    return cell ? displayOf(cell) : '';
  },
  /** the conditional-format style a cell is drawn with (tests) */
  condStyle: (table: number, r: number, c: number) => {
    const st = getState();
    const meta = st.tables.get(table);
    const map = st.cells.get(table);
    return meta ? condStyle(meta, map, r, c, map?.get(r * 65536 + c), st.cellsVersion) ?? null : null;
  },
  /** execution-evidence status of a code cell (tests) */
  runStatus: (ref: { table: number; row: number; col: number }) => {
    const cell = getState().cells.get(ref.table)?.get(ref.row * 65536 + ref.col);
    return statusOf(ref, cell?.i ?? '').status;
  },
  /** open the Records panel (drill-through) for an analytical chart (tests) */
  openRecords: (id: number) => useStore.setState({ recordsChart: id, panel: 'records' }),
  /** the decomposition tree (roadmap 7.4): open it on a chart id, a table name or a tree state; the last tree shown */
  decomp,
  openDecomposition: decomp.openDecomposition,
  decompTree: decomp.decompTree,
  viewport: () => {
    const r = getRenderer();
    return r ? { x: r.pan.x, y: r.pan.y, zoom: r.zoom } : { x: 0, y: 0, zoom: 1 };
  },
};

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* with accounts on: sign-in, a changed temporary password and a client come first */}
    <AuthGate>
      <App />
    </AuthGate>
  </React.StrictMode>,
);

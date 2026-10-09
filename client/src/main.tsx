import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { getState } from './state/store';
import { getRenderer } from './grid/actions';
import * as book from './engine/book';
import * as review from './ui/review';
import * as charts from './grid/charts';
import { printDocumentHtml } from './ui/print';
import { applyTemplate } from './ui/templates';
import { transformOp } from './api/ws';
import { diffDocuments } from './ui/compare';

// Introspection hooks for tests and debugging (window.__gw)
(window as any).__gw = {
  getState,
  book,
  review,
  charts,
  printDocumentHtml,
  applyTemplate,
  transformOp,
  diffDocuments,
  viewport: () => {
    const r = getRenderer();
    return r ? { x: r.pan.x, y: r.pan.y, zoom: r.zoom } : { x: 0, y: 0, zoom: 1 };
  },
};

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

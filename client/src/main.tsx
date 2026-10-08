import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { getState } from './state/store';
import { getRenderer } from './grid/actions';
import * as book from './engine/book';

// Introspection hooks for tests and debugging (window.__gw)
(window as any).__gw = {
  getState,
  book,
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

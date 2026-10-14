// The frame browser code cells run in. JavaScript and Pyodide cells execute in a worker created
// inside this page, and the page is served with `sandbox allow-scripts` (no allow-same-origin): its
// origin is opaque, so the code carries no session cookie, cannot read the app's storage, and is
// refused by the server's origin check if it tries to write. The CSP takes the network away too:
// none at all for JavaScript; only the Pyodide distribution for Python.

import { createHash } from 'node:crypto';
import type { Express, Request, Response } from 'express';

/** The only script the page runs: it relays messages between the app and the worker it creates. */
const HOST_SCRIPT = `(function () {
  'use strict';
  var worker = null;
  function send(m) { parent.postMessage(m, '*'); }
  addEventListener('message', function (e) {
    if (e.source !== parent) return;
    var m = e.data || {};
    if (m.type === 'start' && !worker && typeof m.source === 'string') {
      try {
        var url = URL.createObjectURL(new Blob([m.source], { type: 'text/javascript' }));
        worker = new Worker(url, { type: m.module ? 'module' : 'classic' });
        worker.onmessage = function (ev) { send({ type: 'message', data: ev.data }); };
        worker.onerror = function (ev) { if (ev.preventDefault) ev.preventDefault(); send({ type: 'error', message: String(ev.message || 'worker error') }); };
        worker.onmessageerror = function () { send({ type: 'error', message: 'unreadable message from the worker' }); };
      } catch (err) { send({ type: 'error', message: String((err && err.message) || err) }); }
    } else if (m.type === 'post' && worker) {
      worker.postMessage(m.data);
    }
  });
  send({ type: 'loaded' });
})();`;
const HOST_HASH = `'sha256-${createHash('sha256').update(HOST_SCRIPT).digest('base64')}'`;
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Gridwright code sandbox</title></head><body><script>${HOST_SCRIPT}</script></body></html>`;

/** The default Pyodide distribution (the client's DEFAULT_PYODIDE_INDEX). */
const DEFAULT_INDEX = 'https://cdn.jsdelivr.net/pyodide/v0.27.5/full/';

/**
 * Where Pyodide may be loaded from: an https URL, or this server's own /pyodide/. The CSP allows
 * exactly that prefix (a CSP source with a path matches only below it).
 */
export function pyodideSource(raw: unknown, req: Request): string | null {
  const s = typeof raw === 'string' && raw ? raw : DEFAULT_INDEX;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash) return null;
  const own = `${req.protocol}://${req.headers.host ?? ''}`;
  const sameServer = u.origin === own && u.pathname.startsWith('/pyodide/');
  if (u.protocol !== 'https:' && !sameServer) return null;
  if (!/^[A-Za-z0-9._~\-/%]*$/.test(u.pathname)) return null;
  const path = u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
  return `${u.origin}${path}`;
}

function send(res: Response, csp: string) {
  res.set({
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  res.type('html').send(PAGE);
}

const COMMON = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts";

export function mountSandbox(app: Express) {
  app.get('/sandbox/js.html', (_req, res) => {
    send(res, `${COMMON}; script-src ${HOST_HASH} 'unsafe-eval' blob:; worker-src blob:; connect-src 'none'`);
  });
  app.get('/sandbox/py.html', (req, res) => {
    const index = pyodideSource(req.query.index, req);
    if (!index) {
      res.status(400).type('text').send('the Pyodide location must be an https URL or this server\'s /pyodide/');
      return;
    }
    send(res, `${COMMON}; script-src ${HOST_HASH} 'unsafe-eval' 'wasm-unsafe-eval' blob: ${index}; worker-src blob:; connect-src ${index}`);
  });
}

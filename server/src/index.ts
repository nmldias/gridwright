// Gridwright server: static client, document storage, SQL connections,
// AI proxy and the multiplayer WebSocket relay.

import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { chat } from './ai.js';
import { attachMultiplayer, notifySaved } from './multiplayer.js';
import { runQuery, testConnection } from './sql.js';
import {
  DATA_DIR,
  deleteFile,
  encrypt,
  ensureDirs,
  listConnections,
  listFiles,
  newId,
  readAiConfig,
  readFile,
  saveConnections,
  writeAiConfig,
  writeFile,
  type StoredConnection,
} from './storage.js';

const VERSION = '0.1.0';
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const TOKEN = process.env.GRIDWRIGHT_TOKEN ?? '';
const here = fileURLToPath(new URL('.', import.meta.url));
const CLIENT_DIR = process.env.CLIENT_DIR ?? [resolve(here, '../../client/dist'), resolve(here, '../client')].find((p) => existsSync(join(p, 'index.html'))) ?? resolve(here, '../../client/dist');

ensureDirs();
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64mb' }));

// Optional shared-token gate: GRIDWRIGHT_TOKEN=... then open /?token=... once.
const COOKIE = 'gridwright_token';
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!TOKEN) return next();
  const q = typeof req.query.token === 'string' ? req.query.token : '';
  if (q === TOKEN) {
    res.setHeader('set-cookie', `${COOKIE}=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
    return next();
  }
  const cookie = (req.headers.cookie ?? '').split(';').map((s) => s.trim()).find((s) => s.startsWith(COOKIE + '='));
  if (cookie && decodeURIComponent(cookie.slice(COOKIE.length + 1)) === TOKEN) return next();
  if (req.headers.authorization === `Bearer ${TOKEN}`) return next();
  if (req.path.startsWith('/api/') || req.path === '/ws') {
    res.status(401).json({ error: 'unauthorised — open the app with ?token=<GRIDWRIGHT_TOKEN> once' });
    return;
  }
  res.status(401).type('html').send('<h3>Gridwright</h3><p>This server requires a token: open <code>/?token=…</code> with the value of <code>GRIDWRIGHT_TOKEN</code>.</p>');
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: VERSION, multiplayer: true, dataDir: DATA_DIR });
});

// --- documents --------------------------------------------------------------------
app.get('/api/files', (_req, res) => res.json(listFiles()));
app.get('/api/files/:id', (req, res) => {
  const f = readFile(req.params.id);
  if (!f) return res.status(404).json({ error: 'not found' });
  res.json(f);
});
app.post('/api/files', (req, res) => {
  try {
    const { name, json } = req.body ?? {};
    if (typeof json !== 'string') return res.status(400).json({ error: 'json (string) required' });
    res.json(writeFile(null, String(name || 'Untitled').slice(0, 120), json));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
app.put('/api/files/:id', (req, res) => {
  try {
    const { name, json, client } = req.body ?? {};
    if (typeof json !== 'string') return res.status(400).json({ error: 'json (string) required' });
    const meta = writeFile(req.params.id, String(name || 'Untitled').slice(0, 120), json);
    notifySaved(req.params.id, typeof client === 'string' ? client : undefined);
    res.json(meta);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
app.delete('/api/files/:id', (req, res) => {
  if (!deleteFile(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// --- connections --------------------------------------------------------------------
const publicConn = (c: StoredConnection) => ({
  id: c.id,
  name: c.name,
  kind: c.kind,
  host: c.host,
  port: c.port,
  database: c.database,
  user: c.user,
  ssl: !!c.ssl,
  hasPassword: !!c.passwordEnc,
});
function validateConn(body: any, existing?: StoredConnection): StoredConnection {
  const kind = body.kind === 'mysql' ? 'mysql' : 'postgres';
  const c: StoredConnection = {
    id: existing?.id ?? newId(),
    name: String(body.name ?? existing?.name ?? '').slice(0, 80) || `${kind} connection`,
    kind,
    host: String(body.host ?? existing?.host ?? 'localhost').slice(0, 253),
    port: Number(body.port ?? existing?.port ?? (kind === 'mysql' ? 3306 : 5432)),
    database: String(body.database ?? existing?.database ?? '').slice(0, 128),
    user: String(body.user ?? existing?.user ?? '').slice(0, 128),
    ssl: !!(body.ssl ?? existing?.ssl),
    passwordEnc: existing?.passwordEnc,
  };
  if (typeof body.password === 'string' && body.password.length) c.passwordEnc = encrypt(body.password);
  if (!Number.isFinite(c.port) || c.port < 1 || c.port > 65535) throw new Error('bad port');
  return c;
}
app.get('/api/connections', (_req, res) => res.json(listConnections().map(publicConn)));
app.post('/api/connections', (req, res) => {
  try {
    const list = listConnections();
    const c = validateConn(req.body ?? {});
    list.push(c);
    saveConnections(list);
    res.json(publicConn(c));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
app.put('/api/connections/:id', (req, res) => {
  try {
    const list = listConnections();
    const idx = list.findIndex((c) => c.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'not found' });
    list[idx] = validateConn(req.body ?? {}, list[idx]);
    saveConnections(list);
    res.json(publicConn(list[idx]));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
app.delete('/api/connections/:id', (req, res) => {
  const list = listConnections();
  const next = list.filter((c) => c.id !== req.params.id);
  if (next.length === list.length) return res.status(404).json({ error: 'not found' });
  saveConnections(next);
  res.json({ ok: true });
});
app.post('/api/connections/:id/test', async (req, res) => {
  const c = listConnections().find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(await testConnection(c));
});
app.post('/api/connections/:id/query', async (req, res) => {
  const c = listConnections().find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const sql = String(req.body?.sql ?? '');
  if (!sql.trim()) return res.status(400).json({ error: 'sql required' });
  try {
    res.json(await runQuery(c, sql, Number(req.body?.limit ?? 5000)));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// --- AI -------------------------------------------------------------------------------
app.get('/api/ai/settings', (_req, res) => {
  const cfg = readAiConfig();
  const hasKey = !!cfg.apiKeyEnc || !!process.env.AI_API_KEY;
  res.json({ baseUrl: cfg.baseUrl, model: cfg.model, hasKey, configured: !!cfg.baseUrl && !!cfg.model });
});
app.put('/api/ai/settings', (req, res) => {
  const cfg = readAiConfig();
  const b = req.body ?? {};
  if (typeof b.baseUrl === 'string') cfg.baseUrl = b.baseUrl.trim().slice(0, 500);
  if (typeof b.model === 'string') cfg.model = b.model.trim().slice(0, 200);
  if (typeof b.apiKey === 'string') cfg.apiKeyEnc = b.apiKey ? encrypt(b.apiKey) : undefined;
  writeAiConfig(cfg);
  res.json({ baseUrl: cfg.baseUrl, model: cfg.model, hasKey: !!cfg.apiKeyEnc || !!process.env.AI_API_KEY, configured: !!cfg.baseUrl && !!cfg.model });
});
app.post('/api/ai/chat', chat);

// --- static client ------------------------------------------------------------------------
app.use(
  express.static(CLIENT_DIR, {
    setHeaders(res, path) {
      if (path.endsWith('.wasm')) res.setHeader('content-type', 'application/wasm');
      if (/\/assets\//.test(path)) res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    },
  }),
);
app.get(/^(?!\/api\/).*/, (_req, res) => {
  const index = join(CLIENT_DIR, 'index.html');
  if (!existsSync(index)) return res.status(503).type('text').send('client not built — run `npm run build` in client/');
  res.sendFile(index);
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
attachMultiplayer(wss);
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  if (TOKEN) {
    const cookie = (req.headers.cookie ?? '').split(';').map((s) => s.trim()).find((s) => s.startsWith(COOKIE + '='));
    const ok = (cookie && decodeURIComponent(cookie.slice(COOKIE.length + 1)) === TOKEN) || url.searchParams.get('token') === TOKEN;
    if (!ok) {
      socket.destroy();
      return;
    }
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

server.listen(PORT, HOST, () => {
  console.log(`gridwright ${VERSION} listening on http://${HOST}:${PORT}  data=${DATA_DIR}  client=${CLIENT_DIR}${TOKEN ? '  (token required)' : ''}`);
});

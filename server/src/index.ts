// Gridwright server: static client, document storage with an audit log, SQL
// connections, AI proxy, identity, backups and the multiplayer sequencer.

import express, { type NextFunction, type Request, type Response } from 'express';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { canEdit, canManage, canSign, canView, deleteAccess, normalise, permissionFor, readAccess, writeAccess, type FileAccess } from './access.js';
import { chat } from './ai.js';
import { appendEntry, checkpointSeqs, compactCheckpoints, currentSeq, deleteHistory, historyCsv, opTouchesCell, readAll, recentEntries, replayBundle, writeCheckpoint } from './history.js';
import { identityEnabled, identityOf } from './identity.js';
import { attachMultiplayer, notifyProposal as notifyProposalRoom, notifySaved } from './multiplayer.js';
import { handleMcp, setProposalNotifier } from './mcp.js';
import { engineAvailable, errorMessage } from './headless.js';
import { createProposal, decideProposal, getProposal, listProposals } from './proposals.js';
import { probeGpu, probePython, pythonStatus, runPython, type Snapshot } from './pyrun.js';
import { runQuery, testConnection, type Param } from './sql.js';
import { authorizeQuery, canSeeConnection, SqlRefused } from './sqlpolicy.js';
import {
  DATA_DIR,
  deleteFile,
  encrypt,
  ensureDirs,
  listConnections,
  listFiles,
  newId,
  pyodideDir,
  readAiConfig,
  readFile,
  saveConnections,
  writeAiConfig,
  writeFile,
  type StoredConnection,
} from './storage.js';

const VERSION = '0.5.0';
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const TOKEN = process.env.GRIDWRIGHT_TOKEN ?? '';
const here = fileURLToPath(new URL('.', import.meta.url));
/** Sharing level of a new document: GRIDWRIGHT_DEFAULT_SHARING=edit|view|none (private when identity is on). */
const DEFAULT_SHARING: 'edit' | 'view' | 'none' = (() => {
  const v = (process.env.GRIDWRIGHT_DEFAULT_SHARING ?? '').toLowerCase();
  if (v === 'edit' || v === 'view' || v === 'none' || v === 'private') return v === 'private' ? 'none' : v;
  return identityEnabled ? 'none' : 'edit';
})();
const CLIENT_DIR = process.env.CLIENT_DIR ?? [resolve(here, '../../client/dist'), resolve(here, '../client')].find((p) => existsSync(join(p, 'index.html'))) ?? resolve(here, '../../client/dist');

// a stray rejection or exception in one request must never take the whole server down
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e));
process.on('uncaughtException', (e) => console.error('uncaught exception:', e));

ensureDirs();
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64mb' }));

// Optional shared-token gate: GRIDWRIGHT_TOKEN=... then open /?token=... once.
const COOKIE = 'gridwright_token';
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!TOKEN) return next();
  if (req.path === '/api/health') return next(); // liveness probe stays reachable (it reveals nothing private)
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

// roles: viewers cannot write; only admins manage connections, AI settings and backups
const requireRole = (min: 'editor' | 'admin') => (req: Request, res: Response, next: NextFunction) => {
  const id = identityOf(req);
  const ok = min === 'editor' ? id.role !== 'viewer' : id.role === 'admin';
  if (!ok) {
    res.status(403).json({ error: min === 'editor' ? 'read-only access' : 'administrator access required' });
    return;
  }
  next();
};

const publicPython = () => {
  const p = pythonStatus();
  return p.available ? { version: p.version, sandbox: p.sandbox, gpu: p.gpu, timeoutMs: p.limits.timeoutMs, memoryMb: p.limits.memoryMb } : null;
};
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: VERSION, multiplayer: true, pyodide: !!pyodideDir(), identity: identityEnabled, token: !!TOKEN, tools: true, defaultSharing: DEFAULT_SHARING, mcp: engineAvailable(), python: publicPython() });
});

// --- server-side Python cells -------------------------------------------------------------
app.get('/api/python', (_req, res) => {
  const p = pythonStatus();
  res.json({ available: p.available, version: p.version, sandbox: p.sandbox, gpu: p.gpu, reason: p.reason, limits: p.limits, interpreter: p.interpreter });
});
// re-probe (after installing python, bubblewrap or cuDF) — administrators only
app.post('/api/python/probe', requireRole('admin'), async (_req, res) => {
  const p = await probePython(true);
  if (p.available) await probeGpu();
  res.json(pythonStatus());
});
// the client sends the code and a snapshot of the workbook (what the browser runtime would see)
app.post('/api/python/run', requireRole('editor'), async (req, res) => {
  const b = req.body ?? {};
  const code = typeof b.code === 'string' ? b.code : '';
  const snapshot = b.snapshot && Array.isArray(b.snapshot.tables) ? (b.snapshot as Snapshot) : { tables: [], current: { table: 0, row: 0, col: 0 } };
  const r = await runPython(code, snapshot, b.gpu === true);
  res.json(r);
});
app.get('/api/me', (req, res) => {
  const id = identityOf(req);
  res.json({ login: id.login, name: id.name, role: id.role, identity: identityEnabled });
});

// --- documents --------------------------------------------------------------------
/** Permission of the caller on a document, or a 403/404 already sent. */
function docPermission(req: Request, res: Response, need: 'view' | 'sign' | 'edit' | 'own'): { access: FileAccess; permission: ReturnType<typeof permissionFor> } | null {
  const id = req.params.id;
  if (!readFile(id)) {
    res.status(404).json({ error: 'not found' });
    return null;
  }
  const access = readAccess(id);
  const permission = permissionFor(access, identityOf(req));
  const ok = need === 'view' ? canView(permission) : need === 'sign' ? canSign(permission) : need === 'edit' ? canEdit(permission) : canManage(permission);
  if (!ok) {
    res.status(permission === 'none' ? 404 : 403).json({ error: permission === 'none' ? 'not found' : need === 'own' ? 'only the owner can do that' : 'read-only access to this document' });
    return null;
  }
  return { access, permission };
}

app.get('/api/files', (req, res) => {
  const id = identityOf(req);
  const out = [];
  for (const f of listFiles()) {
    const access = readAccess(f.id);
    const permission = permissionFor(access, id);
    if (!canView(permission)) continue;
    out.push({ ...f, folder: access.folder, owner: access.owner, ownerName: access.ownerName, public: access.public, shared: Object.keys(access.shares).length, permission });
  }
  res.json(out);
});
app.get('/api/files/:id', (req, res) => {
  const p = docPermission(req, res, 'view');
  if (!p) return;
  const f = readFile(req.params.id)!;
  res.json({ ...f, seq: currentSeq(req.params.id), permission: p.permission, folder: p.access.folder });
});
app.post('/api/files', requireRole('editor'), (req, res) => {
  try {
    const { name, json, client, folder } = req.body ?? {};
    if (typeof json !== 'string') return res.status(400).json({ error: 'json (string) required' });
    const meta = writeFile(null, String(name || 'Untitled').slice(0, 120), json);
    const id = identityOf(req);
    // with identity on, the creator owns the document (open to everyone on the server until restricted)
    writeAccess(meta.id, normalise({ owner: identityEnabled ? id.login : '', ownerName: id.name || undefined, public: DEFAULT_SHARING, shares: {}, folder: typeof folder === 'string' ? folder : '' }));
    const seq = appendEntry(meta.id, { author: { id: typeof client === 'string' ? client : 'api', name: id.name || 'Guest', login: id.login || undefined }, origin: 'user', checkpoint: true, note: 'created' });
    writeCheckpoint(meta.id, seq, json);
    res.json({ ...meta, seq, permission: 'own' });
  } catch (e) {
    res.status(400).json({ error: errorMessage(e) });
  }
});
app.put('/api/files/:id', requireRole('editor'), (req, res) => {
  try {
    const p = docPermission(req, res, 'sign');
    if (!p) return;
    const { name, json, client, seq } = req.body ?? {};
    if (typeof json !== 'string') return res.status(400).json({ error: 'json (string) required' });
    const current = readFile(req.params.id)!;
    // a sign-only peer may only persist sign-offs: keep the stored name
    const meta = writeFile(req.params.id, canEdit(p.permission) ? String(name || 'Untitled').slice(0, 120) : current.name, json);
    // checkpoint the saved state at the log position the client had applied (falls back to the current seq)
    const at = Number.isFinite(Number(seq)) && Number(seq) > 0 ? Number(seq) : currentSeq(req.params.id);
    if (!checkpointSeqs(req.params.id).includes(at)) {
      if (at === 0) {
        const id = identityOf(req);
        const s = appendEntry(req.params.id, { author: { id: typeof client === 'string' ? client : 'api', name: id.name || 'Guest', login: id.login || undefined }, origin: 'user', checkpoint: true, note: 'saved' });
        writeCheckpoint(req.params.id, s, json);
      } else {
        writeCheckpoint(req.params.id, at, json);
      }
    }
    notifySaved(req.params.id, typeof client === 'string' ? client : undefined);
    res.json({ ...meta, seq: currentSeq(req.params.id) });
  } catch (e) {
    res.status(400).json({ error: errorMessage(e) });
  }
});
app.delete('/api/files/:id', requireRole('editor'), (req, res) => {
  const p = docPermission(req, res, 'own');
  if (!p) return;
  if (!deleteFile(req.params.id)) return res.status(404).json({ error: 'not found' });
  deleteHistory(req.params.id);
  deleteAccess(req.params.id);
  res.json({ ok: true });
});
// sharing & folders: {public, shares, folder}; folder alone may be changed by editors
app.get('/api/files/:id/access', (req, res) => {
  const p = docPermission(req, res, 'view');
  if (!p) return;
  res.json({ ...p.access, permission: p.permission, identity: identityEnabled });
});
app.put('/api/files/:id/access', requireRole('editor'), (req, res) => {
  const p = docPermission(req, res, 'edit');
  if (!p) return;
  const b = req.body ?? {};
  const next: FileAccess = { ...p.access };
  if (typeof b.folder === 'string') next.folder = b.folder;
  const managing = b.public !== undefined || b.shares !== undefined || b.owner !== undefined;
  if (managing) {
    if (!canManage(p.permission)) return res.status(403).json({ error: 'only the owner can change sharing' });
    if (b.public !== undefined) next.public = b.public;
    if (b.shares !== undefined && typeof b.shares === 'object') next.shares = b.shares;
    if (typeof b.owner === 'string') {
      next.owner = b.owner;
      next.ownerName = typeof b.ownerName === 'string' ? b.ownerName : undefined;
    }
  }
  const saved = normalise(next);
  writeAccess(req.params.id, saved);
  res.json({ ...saved, permission: permissionFor(saved, identityOf(req)), identity: identityEnabled });
});

// --- history (audit trail) ---------------------------------------------------------------
app.get('/api/files/:id/history', (req, res) => {
  if (!docPermission(req, res, 'view')) return;
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 200)));
  const before = req.query.before ? Number(req.query.before) : undefined;
  res.json({ seq: currentSeq(req.params.id), entries: recentEntries(req.params.id, limit, before) });
});
app.get('/api/files/:id/history.csv', (req, res) => {
  if (!docPermission(req, res, 'view')) return;
  const name = (readFile(req.params.id)?.name ?? req.params.id).replace(/[^\w.-]+/g, '_');
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="${name}-audit.csv"`);
  res.send('\ufeff' + historyCsv(req.params.id));
});
app.get('/api/files/:id/history/cell', (req, res) => {
  if (!docPermission(req, res, 'view')) return;
  const table = Number(req.query.table);
  const row = Number(req.query.row);
  const col = Number(req.query.col);
  if (![table, row, col].every(Number.isFinite)) return res.status(400).json({ error: 'table, row, col required' });
  const entries = readAll(req.params.id)
    .filter((e) => e.op && opTouchesCell(e.op, table, row, col))
    .slice(-100)
    .reverse();
  res.json({ entries });
});
app.get('/api/files/:id/history/replay', (req, res) => {
  if (!docPermission(req, res, 'view')) return;
  const seq = Number(req.query.seq);
  if (!Number.isFinite(seq)) return res.status(400).json({ error: 'seq required' });
  const bundle = replayBundle(req.params.id, seq);
  if (!bundle) return res.status(404).json({ error: 'no history' });
  res.json(bundle);
});
app.post('/api/files/:id/history/compact', requireRole('admin'), (req, res) => {
  if (!docPermission(req, res, 'view')) return;
  res.json({ dropped: compactCheckpoints(req.params.id), kept: checkpointSeqs(req.params.id) });
});

// --- proposals (agent edits awaiting a person's decision) ----------------------------------
app.get('/api/files/:id/proposals', (req, res) => {
  if (!docPermission(req, res, 'view')) return;
  const status = req.query.status === 'pending' || req.query.status === 'applied' || req.query.status === 'rejected' ? req.query.status : undefined;
  res.json(listProposals(req.params.id, status));
});
app.get('/api/files/:id/proposals/:pid', (req, res) => {
  if (!docPermission(req, res, 'view')) return;
  const p = getProposal(req.params.id, req.params.pid);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json(p);
});
// anyone who may edit can file a proposal too (e.g. the assistant acting on someone's behalf)
app.post('/api/files/:id/proposals', requireRole('editor'), (req, res) => {
  if (!docPermission(req, res, 'edit')) return;
  try {
    const id = identityOf(req);
    const b = req.body ?? {};
    const actions = Array.isArray(b.actions) ? b.actions : [];
    const p = createProposal(req.params.id, { id: typeof b.client === 'string' ? b.client : 'api', name: id.name || 'Guest', login: id.login || undefined }, String(b.agent ?? 'api').slice(0, 60), String(b.title ?? 'Proposal'), String(b.rationale ?? ''), actions, currentSeq(req.params.id));
    notifyProposalRoom(req.params.id, p);
    res.json(p);
  } catch (e) {
    res.status(400).json({ error: errorMessage(e) });
  }
});
app.post('/api/files/:id/proposals/:pid/decide', requireRole('editor'), (req, res) => {
  if (!docPermission(req, res, 'edit')) return;
  try {
    const id = identityOf(req);
    const b = req.body ?? {};
    const decision = b.decision === 'applied' ? 'applied' : b.decision === 'rejected' ? 'rejected' : null;
    if (!decision) return res.status(400).json({ error: 'decision must be applied or rejected' });
    const p = decideProposal(req.params.id, req.params.pid, decision, { id: typeof b.client === 'string' ? b.client : 'api', name: id.name || 'Guest', login: id.login || undefined }, typeof b.note === 'string' ? b.note : undefined, Number.isFinite(Number(b.seq)) ? Number(b.seq) : undefined);
    notifyProposalRoom(req.params.id, p);
    res.json(p);
  } catch (e) {
    res.status(400).json({ error: errorMessage(e) });
  }
});

// --- MCP (agents) --------------------------------------------------------------------------
setProposalNotifier((doc, p) => notifyProposalRoom(doc, p));
app.all('/mcp', (req, res) => void handleMcp(req, res));

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
  readOnly: c.readOnly !== false,
  allowed: c.allowed ?? [],
  maxRows: c.maxRows ?? 5000,
  timeoutMs: c.timeoutMs ?? 30000,
});
function validateConn(body: any, existing?: StoredConnection): StoredConnection {
  const kind: StoredConnection['kind'] = body.kind === 'mysql' ? 'mysql' : body.kind === 'mssql' ? 'mssql' : 'postgres';
  const defaultPort = kind === 'mysql' ? 3306 : kind === 'mssql' ? 1433 : 5432;
  const c: StoredConnection = {
    id: existing?.id ?? newId(),
    name: String(body.name ?? existing?.name ?? '').slice(0, 80) || `${kind} connection`,
    kind,
    host: String(body.host ?? existing?.host ?? 'localhost').slice(0, 253),
    port: Number(body.port ?? existing?.port ?? defaultPort),
    database: String(body.database ?? existing?.database ?? '').slice(0, 128),
    user: String(body.user ?? existing?.user ?? '').slice(0, 128),
    ssl: !!(body.ssl ?? existing?.ssl),
    passwordEnc: existing?.passwordEnc,
  };
  if (typeof body.password === 'string' && body.password.length) c.passwordEnc = encrypt(body.password);
  if (!Number.isFinite(c.port) || c.port < 1 || c.port > 65535) throw new Error('bad port');
  // policy: read-only unless an administrator explicitly turns it off
  c.readOnly = body.readOnly === undefined ? (existing ? existing.readOnly !== false : true) : body.readOnly !== false && body.readOnly !== 'false';
  const allowedRaw = body.allowed !== undefined ? body.allowed : existing?.allowed;
  c.allowed = (Array.isArray(allowedRaw) ? allowedRaw : typeof allowedRaw === 'string' ? allowedRaw.split(/[,\s]+/) : []).map((x: unknown) => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 200);
  const maxRows = Number(body.maxRows ?? existing?.maxRows ?? 5000);
  c.maxRows = Number.isFinite(maxRows) ? Math.min(50000, Math.max(1, Math.round(maxRows))) : 5000;
  const timeoutMs = Number(body.timeoutMs ?? existing?.timeoutMs ?? 30000);
  c.timeoutMs = Number.isFinite(timeoutMs) ? Math.min(300000, Math.max(1000, Math.round(timeoutMs))) : 30000;
  return c;
}
app.get('/api/connections', (req, res) => {
  const who = identityOf(req);
  res.json(listConnections().filter((c) => canSeeConnection(c, who)).map(publicConn));
});
app.post('/api/connections', requireRole('admin'), (req, res) => {
  try {
    const list = listConnections();
    const c = validateConn(req.body ?? {});
    list.push(c);
    saveConnections(list);
    res.json(publicConn(c));
  } catch (e) {
    res.status(400).json({ error: errorMessage(e) });
  }
});
app.put('/api/connections/:id', requireRole('admin'), (req, res) => {
  try {
    const list = listConnections();
    const idx = list.findIndex((c) => c.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'not found' });
    list[idx] = validateConn(req.body ?? {}, list[idx]);
    saveConnections(list);
    res.json(publicConn(list[idx]));
  } catch (e) {
    res.status(400).json({ error: errorMessage(e) });
  }
});
app.delete('/api/connections/:id', requireRole('admin'), (req, res) => {
  const list = listConnections();
  const next = list.filter((c) => c.id !== req.params.id);
  if (next.length === list.length) return res.status(404).json({ error: 'not found' });
  saveConnections(next);
  res.json({ ok: true });
});
app.post('/api/connections/:id/test', requireRole('editor'), async (req, res) => {
  const who = identityOf(req);
  const c = listConnections().find((x) => x.id === req.params.id && canSeeConnection(x, who));
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(await testConnection(c));
});
// the single query endpoint behind the SQL panel and SQL cells: policy first, then bounded execution
app.post('/api/connections/:id/query', requireRole('editor'), async (req, res) => {
  const who = identityOf(req);
  const c = listConnections().find((x) => x.id === req.params.id && canSeeConnection(x, who));
  if (!c) return res.status(404).json({ error: 'not found' });
  const sql = String(req.body?.sql ?? '');
  if (!sql.trim()) return res.status(400).json({ error: 'sql required' });
  try {
    authorizeQuery(c, who, sql);
  } catch (e) {
    const status = e instanceof SqlRefused ? e.status : 403;
    return res.status(status).json({ error: errorMessage(e) });
  }
  const params: Param[] = Array.isArray(req.body?.params) ? req.body.params.map((p: unknown) => (p === null || ['string', 'number', 'boolean'].includes(typeof p) ? (p as Param) : String(p))) : [];
  try {
    res.json(await runQuery(c, sql, Number(req.body?.limit ?? 5000), params));
  } catch (e) {
    res.status(400).json({ error: errorMessage(e) });
  }
});

// --- AI -------------------------------------------------------------------------------
app.get('/api/ai/settings', (_req, res) => {
  const cfg = readAiConfig();
  const hasKey = !!cfg.apiKeyEnc || !!process.env.AI_API_KEY;
  res.json({ baseUrl: cfg.baseUrl, model: cfg.model, hasKey, configured: !!cfg.baseUrl && !!cfg.model });
});
app.put('/api/ai/settings', requireRole('admin'), (req, res) => {
  const cfg = readAiConfig();
  const b = req.body ?? {};
  if (typeof b.baseUrl === 'string') cfg.baseUrl = b.baseUrl.trim().slice(0, 500);
  if (typeof b.model === 'string') cfg.model = b.model.trim().slice(0, 200);
  if (typeof b.apiKey === 'string') cfg.apiKeyEnc = b.apiKey ? encrypt(b.apiKey) : undefined;
  writeAiConfig(cfg);
  res.json({ baseUrl: cfg.baseUrl, model: cfg.model, hasKey: !!cfg.apiKeyEnc || !!process.env.AI_API_KEY, configured: !!cfg.baseUrl && !!cfg.model });
});
app.get('/api/ai/models', async (_req, res) => {
  const cfg = readAiConfig();
  const baseUrl = (cfg.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) return res.json({ models: [] });
  try {
    const headers: Record<string, string> = {};
    const key = process.env.AI_API_KEY ?? '';
    if (key) headers.authorization = `Bearer ${key}`;
    const r = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(8000) });
    const body: any = await r.json();
    const models: string[] = Array.isArray(body?.data) ? body.data.map((m: any) => String(m.id)) : [];
    res.json({ models });
  } catch (e) {
    res.json({ models: [], error: errorMessage(e) });
  }
});
app.post('/api/ai/chat', chat);

// --- backup (tar.gz of the data directory, admins only) ---------------------------------
app.get('/api/backup', requireRole('admin'), (req, res) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('content-type', 'application/gzip');
  res.setHeader('content-disposition', `attachment; filename="gridwright-backup-${stamp}.tar.gz"`);
  const tar = spawn('tar', ['-czf', '-', '-C', DATA_DIR, '--exclude=./pyodide', '.']);
  tar.stdout.pipe(res);
  tar.stderr.on('data', (d) => console.warn('backup:', d.toString().trim()));
  tar.on('error', (e) => {
    if (!res.headersSent) res.status(500).json({ error: e.message });
    else res.end();
  });
  req.on('close', () => tar.kill());
});

// --- self-hosted Pyodide (optional) -----------------------------------------------------
const pyDir = pyodideDir();
if (pyDir) {
  app.use(
    '/pyodide',
    express.static(pyDir, {
      maxAge: '30d',
      immutable: true,
      setHeaders(res, path) {
        if (path.endsWith('.wasm')) res.setHeader('content-type', 'application/wasm');
        if (path.endsWith('.mjs')) res.setHeader('content-type', 'text/javascript');
      },
    }),
  );
}

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

void probePython().then((p) => console.log(p.available ? `server-side Python: ${p.interpreter} ${p.version}, sandbox ${p.sandbox}` : `server-side Python off: ${p.reason}`));
server.listen(PORT, HOST, () => {
  console.log(
    `gridwright ${VERSION} listening on http://${HOST}:${PORT}  data=${DATA_DIR}  client=${CLIENT_DIR}${TOKEN ? '  (token required)' : ''}${identityEnabled ? '  (trusting Tailscale identity headers)' : ''}${pyDir ? `  pyodide=${pyDir}` : ''}`,
  );
});

// Gridwright server: static client, document storage with an audit log, SQL
// connections, AI proxy, identity, backups and the multiplayer sequencer.

import express, { type NextFunction, type Request, type Response } from 'express';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { brief as companionBrief, interruptRunningInvestigations, setCompanionNotifier, startCompanion } from './companion.js';
import { probeStack, setAgentSocket, setInvestigationNotifier, stackStatus } from './investigate.js';
import { onJobChange, reconcileAfterRestart, startWorker, workerStatus } from './jobs.js';
import { openStore } from './store.js';
import { CONTRACT_VERSION } from './contracts.js';
import { registerCompanionRoutes } from './routes/companion.js';
import { registerConnectionRoutes } from './routes/connections.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerIntakeRoutes } from './routes/intake.js';
import { registerInvestigationRoutes } from './routes/investigation.js';
import { registerPythonRoutes } from './routes/python.js';
import { registerSourceRoutes } from './routes/sources.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerAiQuotaRoutes } from './aiquota.js';
import { requirePlatformAdmin } from './routes/common.js';
import { agentTokenValid, authMode, identityEnabled, identityOf, markAgentChannel, onAgentChannel } from './identity.js';
import { ACCOUNTS, initTenancy } from './tenancy.js';
import { attachMultiplayer, notifyCompanion, notifyJob, notifyProposal as notifyProposalRoom } from './multiplayer.js';
import { handleMcp, setProposalNotifier } from './mcp.js';
import { engineAvailable, errorMessage } from './headless.js';
import { probePython, pythonStatus } from './pyrun.js';
import { canRunPython, canUseGpu } from './execpolicy.js';
import { DATA_DIR, ensureDirs, pyodideDir } from './storage.js';
import { mountSandbox } from './sandboxpage.js';

const VERSION = '0.12.0';
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const TOKEN = process.env.GRIDWRIGHT_TOKEN ?? '';
const here = fileURLToPath(new URL('.', import.meta.url));
/**
 * Sharing level of a new document: GRIDWRIGHT_DEFAULT_SHARING=edit|view|none (private when identity
 * is on). With accounts the client is the boundary and "public" means everyone in the client, so a
 * new document is open to the client's members to edit unless the operator says otherwise.
 */
const DEFAULT_SHARING: 'edit' | 'view' | 'none' = (() => {
  const v = (process.env.GRIDWRIGHT_DEFAULT_SHARING ?? '').toLowerCase();
  if (v === 'edit' || v === 'view' || v === 'none' || v === 'private') return v === 'private' ? 'none' : v;
  if (ACCOUNTS) return 'edit';
  return identityEnabled ? 'none' : 'edit';
})();
const CLIENT_DIR = process.env.CLIENT_DIR ?? [resolve(here, '../../client/dist'), resolve(here, '../client')].find((p) => existsSync(join(p, 'index.html'))) ?? resolve(here, '../../client/dist');

// a stray rejection or exception in one request must never take the whole server down
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e));
process.on('uncaughtException', (e) => console.error('uncaught exception:', e));

ensureDirs();
// accounts (multi-tenant): the clients, people and sessions are open before the first request
await initTenancy();
if (ACCOUNTS && TOKEN) console.log('accounts: GRIDWRIGHT_TOKEN is not used with GRIDWRIGHT_AUTH=accounts — people sign in, scripts and MCP clients use API tokens');
const app = express();
app.disable('x-powered-by');
// Forwarded headers (X-Forwarded-For, -Proto, -Host) count only when they come from a configured
// proxy: GRIDWRIGHT_TRUST_PROXY=1 trusts a reverse proxy on this machine (loopback); any other value
// is handed to Express as is (e.g. "loopback, 10.0.0.0/8" or "uniquelocal").
const TRUST_PROXY_RAW = (process.env.GRIDWRIGHT_TRUST_PROXY ?? '').trim();
if (TRUST_PROXY_RAW && !['0', 'false', 'no'].includes(TRUST_PROXY_RAW.toLowerCase())) app.set('trust proxy', ['1', 'true', 'yes'].includes(TRUST_PROXY_RAW.toLowerCase()) ? 'loopback' : TRUST_PROXY_RAW);
const proxyTrusted = (addr: string | undefined) => !!addr && !!app.get('trust proxy') && (app.get('trust proxy fn') as (a: string, i: number) => boolean)(addr, 0);
// request bodies: documents, snapshots for code and uploads may be large; nothing else needs to be
// (a 64 MB JSON body is parsed on the server's thread — only where it is worth it)
const bigJson = express.json({ limit: '64mb' });
const aiJson = express.json({ limit: '16mb' });
const smallJson = express.json({ limit: '2mb' });
app.use((req: Request, res: Response, next: NextFunction) => {
  const p = req.path;
  if (p.startsWith('/api/files') || p.startsWith('/api/python/') || p.startsWith('/api/investigat') || p === '/mcp') return bigJson(req, res, next);
  if (p.startsWith('/api/ai/')) return aiJson(req, res, next);
  return smallJson(req, res, next);
});

// The frame browser code cells run in (opaque origin, no network for JavaScript): a static page that
// carries nothing private, so it is served ahead of every gate.
mountSandbox(app);

// Security headers on everything else (the sandbox pages above carry their own, stricter policy).
// The app needs WebAssembly for the engine, blob: workers for Pixi, data:/blob: images for charts,
// and its own WebSocket; nothing is loaded from another origin.
const hostForCsp = (h: string | undefined) => (h && /^[A-Za-z0-9.\-:\[\]]{1,300}$/.test(h) ? h : '');
app.use((req: Request, res: Response, next: NextFunction) => {
  const host = hostForCsp(req.headers.host);
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "worker-src 'self' blob:",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src 'self'${host ? ` ws://${host} wss://${host}` : ''}`,
      "frame-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()');
  // HSTS only over HTTPS (directly, or from a trusted proxy that says so)
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/api/') || req.path === '/mcp') res.setHeader('Cache-Control', 'no-store');
  next();
});

// The agent channel (a Unix socket bound into agent-cell sandboxes): the API and MCP only, and only
// with a live agent token — which then stands in for the shared token below.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!onAgentChannel(req)) return next();
  if (!(req.path.startsWith('/api/') || req.path === '/mcp') || req.path === '/api/backup') {
    res.status(404).json({ error: 'not available on the agent channel' });
    return;
  }
  if (!agentTokenValid(req.headers['x-gridwright-agent'])) {
    res.status(401).json({ error: 'the agent channel needs a live agent token' });
    return;
  }
  next();
});

// Optional shared-token gate: GRIDWRIGHT_TOKEN=... then open /?token=... once.
const COOKIE = 'gridwright_token';
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!TOKEN || ACCOUNTS || onAgentChannel(req)) return next();
  if (req.path === '/api/health') return next(); // liveness probe stays reachable (it reveals nothing private)
  // the self-hosted Pyodide distribution is public software, fetched without cookies from the code sandbox
  if (pyodideDir() && req.path.startsWith('/pyodide/') && (req.method === 'GET' || req.method === 'HEAD')) return next();
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

// Accounts gate (GRIDWRIGHT_AUTH=accounts): the API needs a signed-in person (session cookie or an
// API token), a changed temporary password, and a client they are a member of. The static client
// stays reachable — it shows the sign-in. Writes from another site are refused outright.
const ALLOWED_ORIGINS = (process.env.GRIDWRIGHT_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);
const originAllowed = (req: { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } }) => {
  const origin = String(req.headers.origin ?? '');
  if (!origin || origin === 'null') return !origin; // no Origin: not a browser page (curl, MCP clients)
  if (ALLOWED_ORIGINS.includes(origin.replace(/\/+$/, ''))) return true;
  try {
    const host = new URL(origin).host;
    // the forwarded host counts only from a trusted proxy (GRIDWRIGHT_TRUST_PROXY)
    const fwd = proxyTrusted(req.socket?.remoteAddress) ? String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim() : '';
    return host === String(req.headers.host ?? '') || (!!fwd && host === fwd);
  } catch {
    return false;
  }
};
const OPEN_PATHS = new Set(['/api/health', '/api/me', '/api/auth/login', '/api/auth/logout', '/api/auth/invitation', '/api/auth/invitation/accept']);
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!ACCOUNTS || onAgentChannel(req)) return next();
  const p = req.path;
  if (!(p.startsWith('/api/') || p === '/mcp')) return next();
  if (req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(req)) {
    res.status(403).json({ error: 'cross-site request refused' });
    return;
  }
  if (OPEN_PATHS.has(p)) return next();
  const id = identityOf(req);
  if (!id.login) {
    res.setHeader('x-gridwright-auth', 'signed-out');
    res.status(401).json({ error: 'sign in to use this server', auth: 'required' });
    return;
  }
  if (id.mustChangePassword && p !== '/api/auth/password') {
    res.setHeader('x-gridwright-auth', 'change-password');
    res.status(403).json({ error: 'change your temporary password first', mustChangePassword: true });
    return;
  }
  // one's own account and the platform console do not depend on a client
  if (p.startsWith('/api/auth/') || p.startsWith('/api/account') || p.startsWith('/api/platform/')) return next();
  if (!id.tenant) {
    const error = id.denied === 'suspended' ? 'this client account is suspended' : id.denied === 'not-a-member' ? 'you are not a member of this client' : id.denied === 'token-client' ? 'this API token belongs to another client: drop the x-gridwright-tenant header or use a token made in that client' : 'you are not a member of any client yet — ask an administrator to add you';
    res.setHeader('x-gridwright-auth', 'no-client');
    res.status(403).json({ error, denied: id.denied ?? 'no-client' });
    return;
  }
  next();
});

// roles: viewers cannot write; only admins manage connections, AI settings and backups

const publicPython = (req: Request) => {
  const p = pythonStatus();
  const who = identityOf(req);
  return p.available ? { version: p.version, sandbox: p.sandbox, gpu: p.gpu, timeoutMs: p.limits.timeoutMs, memoryMb: p.limits.memoryMb, can: { run: canRunPython(who), gpu: canUseGpu(who) } } : null;
};
app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: VERSION, contract: CONTRACT_VERSION, multiplayer: true, pyodide: !!pyodideDir(), identity: identityEnabled, auth: authMode, token: !!TOKEN && !ACCOUNTS, tools: true, defaultSharing: DEFAULT_SHARING, mcp: engineAvailable(), python: publicPython(req), investigation: stackStatus().available, worker: workerStatus() });
});

// --- routes: ./routes/*; the rules they call live in the services ---------------------------------
registerAccountRoutes(app);
registerAiQuotaRoutes(app);
registerPythonRoutes(app);
registerDocumentRoutes(app, { defaultSharing: DEFAULT_SHARING });
registerCompanionRoutes(app);
registerIntakeRoutes(app);
registerInvestigationRoutes(app, { token: TOKEN, selfUrl: () => process.env.GRIDWRIGHT_SELF_URL ?? `http://127.0.0.1:${PORT}` });
registerConnectionRoutes(app);
registerSourceRoutes(app);

// --- MCP (agents) --------------------------------------------------------------------------
setProposalNotifier((doc, p) => notifyProposalRoom(doc, p));
// the companion: re-check after every logged change, and on a timer for freshness; push to open sessions
setCompanionNotifier((doc, payload) => notifyCompanion(doc, payload));
setInvestigationNotifier((doc) => notifyCompanion(doc, { attention: companionBrief(doc).health.attention }));
startCompanion(Number(process.env.GRIDWRIGHT_COMPANION_INTERVAL_MS ?? 600_000));
// the store (jobs, sources, recipes, dataset versions) and the worker: what the previous process left running is
// interrupted before anything new is claimed
await openStore();
{
  const jobs = reconcileAfterRestart('the server restarted while it ran');
  const interrupted = interruptRunningInvestigations('the server restarted while it ran');
  if (jobs.length || interrupted) console.log(`interrupted by the restart: ${jobs.length} job${jobs.length === 1 ? '' : 's'}, ${interrupted} investigation${interrupted === 1 ? '' : 's'} (marked; nothing they proposed is current)`);
}
onJobChange((job) => notifyJob(job.doc, { id: job.id, type: job.type, status: job.status, error: job.error }));
startWorker();
void probeStack().then((st) => console.log(st.available ? `investigation stack: ${st.python} (${Object.entries(st.versions ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')})` : `investigation stack off: ${st.reason}`));
app.all('/mcp', (req, res) => void handleMcp(req, res));

// --- backup (tar.gz of the data directory — every client's: the platform's administrators only) ---
app.get('/api/backup', requirePlatformAdmin, (req, res) => {
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
        // loaded from the code sandbox, whose origin is opaque: a CORS request
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('cross-origin-resource-policy', 'cross-origin');
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
  if (ACCOUNTS) {
    // the same rules as the API: a signed-in member of the client the tab names (?tenant=), from this site
    const id = identityOf(req);
    if (!originAllowed(req) || !id.login || !id.tenant || id.mustChangePassword) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
  } else if (TOKEN) {
    const cookie = (req.headers.cookie ?? '').split(';').map((s) => s.trim()).find((s) => s.startsWith(COOKIE + '='));
    const ok = (cookie && decodeURIComponent(cookie.slice(COOKIE.length + 1)) === TOKEN) || url.searchParams.get('token') === TOKEN;
    if (!ok) {
      socket.destroy();
      return;
    }
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

void probePython().then((p) => console.log(p.available ? `server-side Python: ${p.interpreter} ${p.version}, sandbox ${p.sandbox}${p.fallbacks ? ` (stronger sandboxes unavailable — ${p.fallbacks})` : ''}` : `server-side Python off: ${p.reason}`));
// the agent channel: the same app on a Unix socket that agent-cell sandboxes reach through a bind mount
// (no network inside them); only the service user may connect, and only with a live agent token
{
  const wanted = process.env.GRIDWRIGHT_AGENT_SOCKET ?? join(DATA_DIR, 'agent.sock');
  const sock = wanted.length <= 100 ? wanted : join(tmpdir(), `gridwright-agent-${process.pid}.sock`);
  try {
    rmSync(sock, { force: true });
  } catch {
    /* not there */
  }
  const agentServer = createServer(app);
  agentServer.on('connection', (s) => markAgentChannel(s));
  agentServer.on('error', (e) => console.error(`agent channel off (${sock}): ${errorMessage(e)} — agent cells are unavailable`));
  agentServer.listen(sock, () => {
    try {
      chmodSync(sock, 0o600);
    } catch {
      /* best effort */
    }
    setAgentSocket(sock);
  });
}

server.listen(PORT, HOST, () => {
  console.log(
    `gridwright ${VERSION} listening on http://${HOST}:${PORT}  data=${DATA_DIR}  client=${CLIENT_DIR}${ACCOUNTS ? '  (accounts: multi-tenant, sign-in required)' : TOKEN ? '  (token required)' : ''}${identityEnabled && !ACCOUNTS ? '  (trusting Tailscale identity headers)' : ''}${pyDir ? `  pyodide=${pyDir}` : ''}`,
  );
});

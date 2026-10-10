// Server-side Python over HTTP: the runtime's status (sandbox level, GPU, limits, policy), a
// re-probe for administrators, and a run — the client sends the code and a snapshot of the workbook;
// when it names the cell of a saved document the server writes the run record itself, with hashes
// it computed from what it ran: evidence the client cannot forge.

import type { Express } from 'express';
import { canView, permissionFor, readAccess } from '../access.js';
import { fnv, inputsHashFromSnapshot, outputHashOf } from '../evidence.js';
import { canRunPython, canUseGpu, executionPolicy } from '../execpolicy.js';
import { appendEntry } from '../history.js';
import { authMode, identityEnabled, identityOf } from '../identity.js';
import { ACCOUNTS, membershipsOf } from '../tenancy.js';
import { admissionState, probeGpu, probePython, pythonStatus, QUEUE_MAX, runPython, type Snapshot } from '../pyrun.js';
import { readFile } from '../storage.js';
import { brief as companionBrief } from '../companion.js';
import { probeStack, runAgentCell } from '../investigate.js';
import { notifyCompanion } from '../multiplayer.js';
import { authorOf, docPermission, fail, noAgent, requirePlatformAdmin, requireRole } from './common.js';

export function registerPythonRoutes(app: Express) {
  app.get('/api/python', (req, res) => {
    const p = pythonStatus();
    const who = identityOf(req);
    res.json({ available: p.available, version: p.version, sandbox: p.sandbox, gpu: p.gpu, reason: p.reason, fallbacks: p.fallbacks, limits: { ...p.limits, queue: QUEUE_MAX }, interpreter: p.interpreter, policy: executionPolicy(), admission: admissionState(), can: { run: canRunPython(who), gpu: canUseGpu(who) } });
  });
  // re-probe (after installing python, bubblewrap or cuDF) — the host's administrators only
  app.post('/api/python/probe', requirePlatformAdmin, async (_req, res) => {
    const p = await probePython(true);
    if (p.available) await probeGpu();
    res.json(pythonStatus());
  });
  // the client sends the code and a snapshot of the workbook (what the browser runtime would see);
  // when it names the cell of a saved document, the server writes the run record itself, with hashes
  // it computed from what it ran — evidence the client cannot forge
    // an agent cell: the person's code with the companion's context, tools and model, acting for them through an agent token
  app.post('/api/files/:id/agent-cell', requireRole('editor'), async (req, res) => {
    if (!docPermission(req, res, 'edit') || !noAgent(req, res)) return;
    const who = identityOf(req);
    if (!canRunPython(who)) return res.status(403).json({ error: 'running code on the server is not permitted for your login (GRIDWRIGHT_PYTHON_USERS)' });
    const b = req.body ?? {};
    const code = typeof b.code === 'string' ? b.code : '';
    if (!code.trim()) return res.status(400).json({ error: 'code required' });
    const snapshot = b.snapshot && Array.isArray(b.snapshot.tables) ? (b.snapshot as Snapshot) : { tables: [], current: { table: 0, row: 0, col: 0 } };
    const startedAt = new Date().toISOString();
    try {
      await probeStack();
      const r = await runAgentCell(req.params.id, who, authorOf(req), code, snapshot);
      if (r.busy) return res.status(429).json(r);
      const cell = b.cell && typeof b.cell === 'object' ? (b.cell as { table?: unknown; row?: unknown; col?: unknown; startedAt?: unknown; client?: unknown }) : null;
      if (cell && [cell.table, cell.row, cell.col].every((x) => Number.isFinite(Number(x)))) {
        const run = {
          table: Number(cell.table),
          row: Number(cell.row),
          col: Number(cell.col),
          kind: 'python',
          codeHash: fnv(code),
          inputsHash: inputsHashFromSnapshot(snapshot, r.deps),
          deps: r.deps,
          outputHash: outputHashOf(r.ok ? r.output : null),
          ok: r.ok,
          error: r.error?.slice(0, 500),
          ms: r.ms,
          runtime: r.runtime,
          at: new Date().toISOString(),
          startedAt: typeof cell.startedAt === 'string' ? cell.startedAt.slice(0, 40) : startedAt,
          attested: 'server' as const,
        };
        const seq = appendEntry(req.params.id, { author: { id: typeof cell.client === 'string' ? cell.client : 'api', name: who.name || 'Guest', login: who.login || undefined }, origin: 'code', run });
        notifyCompanion(req.params.id, { attention: companionBrief(req.params.id).health.attention });
        return res.json({ ...r, record: { ...run, seq } });
      }
      notifyCompanion(req.params.id, { attention: companionBrief(req.params.id).health.attention });
      res.json(r);
    } catch (e) {
      fail(res, e);
    }
  });
app.post('/api/python/run', requireRole('editor'), async (req, res) => {
    const b = req.body ?? {};
    const requester = identityOf(req);
    if (!canRunPython(requester)) return res.status(403).json({ error: 'running code on the server is not permitted for your login (GRIDWRIGHT_PYTHON_USERS)' });
    if (b.gpu === true && !canUseGpu(requester)) return res.status(403).json({ error: 'GPU execution is not permitted for your login (GRIDWRIGHT_GPU_USERS)' });
    const code = typeof b.code === 'string' ? b.code : '';
    const snapshot = b.snapshot && Array.isArray(b.snapshot.tables) ? (b.snapshot as Snapshot) : { tables: [], current: { table: 0, row: 0, col: 0 } };
    const startedAt = new Date().toISOString();
    const r = await runPython(code, snapshot, b.gpu === true);
    if (r.busy) return res.status(429).json(r);
    const cell = b.cell && typeof b.cell === 'object' ? (b.cell as { file?: unknown; table?: unknown; row?: unknown; col?: unknown; kind?: unknown; startedAt?: unknown; client?: unknown }) : null;
    const fileId = cell && typeof cell.file === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(cell.file) ? cell.file : null;
    if (fileId && [cell!.table, cell!.row, cell!.col].every((x) => Number.isFinite(Number(x))) && readFile(fileId)) {
      const who = identityOf(req);
      if (canView(permissionFor(readAccess(fileId), who))) {
        const run = {
          table: Number(cell!.table),
          row: Number(cell!.row),
          col: Number(cell!.col),
          kind: 'python',
          codeHash: fnv(code),
          inputsHash: inputsHashFromSnapshot(snapshot, r.deps),
          deps: r.deps,
          outputHash: outputHashOf(r.ok ? r.output : null),
          ok: r.ok,
          error: r.error?.slice(0, 500),
          ms: r.ms,
          runtime: r.runtime,
          at: new Date().toISOString(),
          startedAt: typeof cell!.startedAt === 'string' ? cell!.startedAt.slice(0, 40) : startedAt,
          attested: 'server' as const,
        };
        const seq = appendEntry(fileId, { author: { id: typeof cell!.client === 'string' ? cell!.client : 'api', name: who.name || 'Guest', login: who.login || undefined }, origin: 'code', run });
        return res.json({ ...r, record: { ...run, seq } });
      }
    }
    res.json(r);
  });
  app.get('/api/me', (req, res) => {
    const id = identityOf(req);
    const base = { login: id.login, name: id.name, role: id.role, identity: identityEnabled, auth: authMode, can: { python: canRunPython(id), gpu: canUseGpu(id) } };
    if (!ACCOUNTS) return res.json(base);
    // accounts mode: the client this tab acts in, every client the person belongs to, and what they run
    res.json({
      ...base,
      authenticated: !!id.login,
      platformAdmin: !!id.platformAdmin,
      mustChangePassword: !!id.mustChangePassword,
      tenant: id.tenant ? { id: id.tenant, name: id.tenantName ?? '', slug: id.tenantSlug ?? '', role: id.role } : null,
      denied: id.denied,
      tenants: id.login ? membershipsOf(id.login).map((m) => ({ id: m.tenant.id, name: m.tenant.name, slug: m.tenant.slug, role: m.role, status: m.tenant.status })) : [],
    });
  });
}

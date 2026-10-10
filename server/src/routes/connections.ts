// Connections and the model endpoint over HTTP: SQL connections (administrators manage them, the
// policy decides who sees which and what may run — the single query endpoint behind the SQL panel
// and SQL cells goes through it first), and the assistant's settings, models and chat.

import type { Express } from 'express';
import { chat } from '../ai.js';
import { errorMessage } from '../headless.js';
import { identityOf } from '../identity.js';
import { runQuery, testConnection, type Param } from '../sql.js';
import { authorizeQuery, canSeeConnection, SqlRefused } from '../sqlpolicy.js';
import { Readable } from 'node:stream';
import { aiKeyOf, clearTenantAiConfig, encrypt, listConnections, newId, readAiConfig, readPlatformAiConfig, readTenantAiConfig, saveConnections, writeAiConfig, type AiConfig, type StoredConnection } from '../storage.js';
import { ACCOUNTS, audit } from '../tenancy.js';
import { requirePlatformAdmin, requireRole } from './common.js';

export function registerConnectionRoutes(app: Express) {
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
      // accounts mode: the connection belongs to the client of the administrator who made it
      if (ACCOUNTS) {
        const who = identityOf(req);
        if (!who.tenant) return res.status(403).json({ error: 'no client selected' });
        c.tenant = who.tenant;
      }
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
      const who = identityOf(req);
      const idx = list.findIndex((c) => c.id === req.params.id && canSeeConnection(c, who));
      if (idx < 0) return res.status(404).json({ error: 'not found' });
      list[idx] = { ...validateConn(req.body ?? {}, list[idx]), tenant: list[idx].tenant };
      saveConnections(list);
      res.json(publicConn(list[idx]));
    } catch (e) {
      res.status(400).json({ error: errorMessage(e) });
    }
  });
  app.delete('/api/connections/:id', requireRole('admin'), (req, res) => {
    const list = listConnections();
    const who = identityOf(req);
    const next = list.filter((c) => !(c.id === req.params.id && canSeeConnection(c, who)));
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
  // accounts mode: the settings in force for the caller's client — its own override, or the
  // platform default (the key is never shown; `scope` says which applies)
  const tenantOfReq = (req: import('express').Request) => (ACCOUNTS ? identityOf(req).tenant : undefined);
  const settingsView = (cfg: AiConfig) => ({ baseUrl: cfg.baseUrl, model: cfg.model, hasKey: !!aiKeyOf(cfg), configured: !!cfg.baseUrl && !!cfg.model, scope: ACCOUNTS ? cfg.scope ?? 'platform' : undefined });
  const applySettings = (cfg: AiConfig, b: Record<string, unknown>) => {
    if (typeof b.baseUrl === 'string') cfg.baseUrl = b.baseUrl.trim().slice(0, 500);
    if (typeof b.model === 'string') cfg.model = b.model.trim().slice(0, 200);
    if (typeof b.apiKey === 'string') cfg.apiKeyEnc = b.apiKey ? encrypt(b.apiKey) : undefined;
    if (cfg.baseUrl && !/^https?:\/\//i.test(cfg.baseUrl)) throw new Error('the endpoint is an http(s) URL');
    return cfg;
  };
  app.get('/api/ai/settings', (req, res) => {
    res.json(settingsView(readAiConfig(tenantOfReq(req))));
  });
  // without accounts: the server's settings; with accounts: the client's own override (a client
  // administrator decides for the client; `reset: true` returns it to the platform default)
  app.put('/api/ai/settings', requireRole('admin'), (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      if (!ACCOUNTS) {
        const cfg = applySettings(readPlatformAiConfig(), b);
        writeAiConfig(cfg);
        return res.json(settingsView(readAiConfig()));
      }
      const who = identityOf(req);
      if (!who.tenant) return res.status(403).json({ error: 'no client selected' });
      if (b.reset === true) {
        clearTenantAiConfig(who.tenant);
        audit(who.login, 'client.ai-settings', { tenant: who.tenant, detail: 'back to the platform default' });
        return res.json(settingsView(readAiConfig(who.tenant)));
      }
      // the override starts from what the client had (never from the platform's key)
      const own = readTenantAiConfig(who.tenant) ?? { baseUrl: '', model: '' };
      const cfg = applySettings({ baseUrl: own.baseUrl, model: own.model, apiKeyEnc: own.apiKeyEnc }, b);
      writeAiConfig(cfg, who.tenant);
      audit(who.login, 'client.ai-settings', { tenant: who.tenant, detail: `${cfg.baseUrl || '(platform endpoint)'} · ${cfg.model || '(platform model)'}${typeof b.apiKey === 'string' ? (b.apiKey ? ' · key set' : ' · key removed') : ''}` });
      res.json(settingsView(readAiConfig(who.tenant)));
    } catch (e) {
      res.status(400).json({ error: errorMessage(e) });
    }
  });
  // the platform default every client without an override uses (accounts mode)
  app.get('/api/platform/ai', requirePlatformAdmin, (_req, res) => res.json(settingsView(readPlatformAiConfig())));
  app.put('/api/platform/ai', requirePlatformAdmin, (req, res) => {
    try {
      const cfg = applySettings(readPlatformAiConfig(), (req.body ?? {}) as Record<string, unknown>);
      writeAiConfig(cfg);
      audit(identityOf(req).login, 'platform.ai-settings', { detail: `${cfg.baseUrl} · ${cfg.model}` });
      res.json(settingsView(readPlatformAiConfig()));
    } catch (e) {
      res.status(400).json({ error: errorMessage(e) });
    }
  });
  app.get('/api/ai/models', async (req, res) => {
    const cfg = readAiConfig(tenantOfReq(req));
    const baseUrl = (cfg.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) return res.json({ models: [] });
    try {
      const headers: Record<string, string> = {};
      const key = aiKeyOf(cfg);
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

  // An OpenAI-compatible pass-through to the configured model endpoint, for agent cells and agents:
  // the caller is identified as usual (an agent cell by its token on the agent channel), the key is
  // added here and never leaves the server, the body and the answer (streamed or not) pass unchanged.
  const upstreamOf = (req: import('express').Request) => {
    const cfg = readAiConfig(tenantOfReq(req));
    const key = aiKeyOf(cfg);
    return { base: (cfg.baseUrl || '').replace(/\/+$/, ''), model: cfg.model, headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) } as Record<string, string> };
  };
  app.post('/api/ai/v1/chat/completions', requireRole('editor'), async (req, res) => {
    const up = upstreamOf(req);
    if (!up.base) return res.status(503).json({ error: { message: 'no model endpoint is configured (Settings → model)', type: 'gridwright' } });
    const body = { ...(req.body ?? {}) } as Record<string, unknown>;
    if (!body.model || body.model === 'default') body.model = up.model;
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ac.abort();
    });
    try {
      const r = await fetch(`${up.base}/chat/completions`, { method: 'POST', headers: up.headers, body: JSON.stringify(body), signal: AbortSignal.any([ac.signal, AbortSignal.timeout(600_000)]) });
      res.status(r.status);
      res.setHeader('content-type', r.headers.get('content-type') ?? 'application/json');
      if (!r.body) return res.end();
      Readable.fromWeb(r.body as import('node:stream/web').ReadableStream).pipe(res);
    } catch (e) {
      if (!res.headersSent) res.status(502).json({ error: { message: `the model endpoint did not answer: ${errorMessage(e)}`, type: 'gridwright' } });
      else res.end();
    }
  });
  app.get('/api/ai/v1/models', requireRole('editor'), async (req, res) => {
    const up = upstreamOf(req);
    if (!up.base) return res.json({ object: 'list', data: [] });
    try {
      const r = await fetch(`${up.base}/models`, { headers: up.headers, signal: AbortSignal.timeout(8000) });
      res.status(r.status).json(await r.json());
    } catch (e) {
      res.status(502).json({ error: { message: errorMessage(e), type: 'gridwright' } });
    }
  });
}

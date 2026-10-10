// Accounts over HTTP (GRIDWRIGHT_AUTH=accounts): signing in and out, a person's own account (name,
// password, API tokens), the client a tab acts in, the members of a client (its administrators
// manage them), and the platform console (clients, people, the audit trail) for platform
// administrators. Every change is written to the accounts audit trail.

import type { Express, Request, Response } from 'express';
import { readAccess, tenantOf } from '../access.js';
import { errorMessage } from '../headless.js';
import { identityOf } from '../identity.js';
import { accessChangedEverywhere } from '../multiplayer.js';
import { connectionTenant, listConnections, listFiles } from '../storage.js';
import {
  ACCOUNTS,
  addMember,
  audit,
  clearFailures,
  clearSessionCookie,
  createApiToken,
  createSession,
  createTenant,
  createUser,
  deleteTenant,
  endSession,
  getTenant,
  getUser,
  isRole,
  listApiTokens,
  listAudit,
  listTenants,
  listUsers,
  membersOf,
  membershipsOf,
  noteFailure,
  normaliseLogin,
  onAccessChange,
  removeMember,
  resetPassword,
  revokeApiToken,
  roleIn,
  sessionCookie,
  sessionHash,
  sessionTokenOf,
  setMemberRole,
  setPassword,
  setSessionTenant,
  throttled,
  acceptInvitation,
  createInvitation,
  invitationByCode,
  listInvitations,
  revokeInvitation,
  waitText,
  updateTenant,
  updateUser,
  verifyLogin,
  type Role,
} from '../tenancy.js';
import { requirePlatformAdmin, requireRole } from './common.js';

// the client address and HTTPS come from Express, which reads X-Forwarded-For / -Proto only from a
// proxy named in GRIDWRIGHT_TRUST_PROXY (index.ts); otherwise the socket itself decides
const ipOf = (req: Request) => req.ip || req.socket.remoteAddress || '';
const secureOf = (req: Request) => ['1', 'true', 'yes'].includes((process.env.GRIDWRIGHT_COOKIE_SECURE ?? '').toLowerCase()) || req.secure;
const fail = (res: Response, e: unknown, status = 400) => res.status(status).json({ error: errorMessage(e) });

/** Documents and connections per client (from the access metadata only — no document is read). */
function usageByTenant(): Map<string, { documents: number; connections: number }> {
  const out = new Map<string, { documents: number; connections: number }>();
  const at = (t: string) => out.get(t) ?? (out.set(t, { documents: 0, connections: 0 }), out.get(t)!);
  listFiles((id) => {
    at(tenantOf(readAccess(id))).documents++;
    return false;
  });
  for (const c of listConnections()) at(connectionTenant(c)).connections++;
  return out;
}

/** Add someone to a client, making their account first when they have none (a temporary password, returned once). */
function addPerson(tenant: string, b: Record<string, unknown>, actor: string): { login: string; role: Role; created: boolean; temporaryPassword?: string } {
  const login = normaliseLogin(b.login);
  const role: Role = isRole(b.role) ? b.role : 'editor';
  let created = false;
  let temporaryPassword: string | undefined;
  if (!getUser(login)) {
    const r = createUser({ login, name: typeof b.name === 'string' ? b.name : undefined, password: typeof b.password === 'string' && b.password ? b.password : undefined }, actor);
    created = true;
    temporaryPassword = r.temporaryPassword;
  }
  addMember(tenant, login, role, actor);
  return { login, role, created, temporaryPassword };
}

export function registerAccountRoutes(app: Express) {
  if (!ACCOUNTS) return;
  // open sessions follow a membership, role or client-status change at once
  onAccessChange(() => accessChangedEverywhere());

  // --- signing in --------------------------------------------------------------------------
  app.post('/api/auth/login', (req, res) => {
    const b = req.body ?? {};
    const login = normaliseLogin(b.login);
    const ip = ipOf(req);
    const wait = throttled(ip, login);
    if (wait) {
      res.setHeader('retry-after', String(wait));
      return res.status(429).json({ error: `too many attempts — try again in ${waitText(wait)}` });
    }
    const user = verifyLogin(login, String(b.password ?? ''));
    if (!user) {
      noteFailure(ip, login);
      audit(login || '(empty)', 'auth.failed', { detail: ip });
      return res.status(401).json({ error: 'wrong e-mail or password' });
    }
    clearFailures(ip, login);
    const memberships = membershipsOf(user.login);
    const asked = typeof b.tenant === 'string' ? b.tenant : '';
    const first = memberships.find((m) => m.tenant.id === asked || m.tenant.slug === asked) ?? memberships.find((m) => m.tenant.status === 'active') ?? memberships[0];
    const token = createSession(user.login, first?.tenant.id ?? null);
    res.setHeader('set-cookie', sessionCookie(token, secureOf(req)));
    audit(user.login, 'auth.signed-in', { tenant: first?.tenant.id, detail: ip });
    res.json({ ok: true, mustChangePassword: user.mustChangePassword, tenant: first ? { id: first.tenant.id, slug: first.tenant.slug, name: first.tenant.name } : null });
  });
  app.post('/api/auth/logout', (req, res) => {
    const token = sessionTokenOf(req);
    const who = identityOf(req);
    if (token) endSession(token);
    if (who.login) audit(who.login, 'auth.signed-out');
    res.setHeader('set-cookie', clearSessionCookie(secureOf(req)));
    res.json({ ok: true });
  });
  app.post('/api/auth/password', (req, res) => {
    const who = identityOf(req);
    const token = sessionTokenOf(req);
    if (!who.login || !token) return res.status(401).json({ error: 'sign in first' });
    const b = req.body ?? {};
    if (!verifyLogin(who.login, String(b.current ?? ''))) return res.status(403).json({ error: 'the current password is wrong' });
    try {
      setPassword(who.login, String(b.next ?? ''), { mustChange: false, actor: who.login, keepSession: sessionHash(token) });
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });
  // invitations: anyone holding the code sees what it is for, and accepts it with the password of
  // their existing account or the one they choose now (the same form either way)
  app.get('/api/auth/invitation', (req, res) => {
    const inv = invitationByCode(String(req.query.code ?? ''));
    if (!inv) return res.status(404).json({ error: 'this invitation is no longer valid — ask for a new one' });
    res.json({ tenant: inv.tenantName, login: inv.login, role: inv.role, expiresAt: inv.expiresAt });
  });
  app.post('/api/auth/invitation/accept', (req, res) => {
    const b = req.body ?? {};
    const inv = invitationByCode(String(b.code ?? ''));
    if (!inv) return res.status(404).json({ error: 'this invitation is no longer valid — ask for a new one' });
    const ip = ipOf(req);
    const wait = throttled(ip, inv.login);
    if (wait) {
      res.setHeader('retry-after', String(wait));
      return res.status(429).json({ error: `too many attempts — try again in ${waitText(wait)}` });
    }
    try {
      const r = acceptInvitation(String(b.code), String(b.password ?? ''), typeof b.name === 'string' ? b.name : undefined);
      clearFailures(ip, r.login);
      const token = createSession(r.login, r.tenant.id);
      res.setHeader('set-cookie', sessionCookie(token, secureOf(req)));
      audit(r.login, 'auth.signed-in', { tenant: r.tenant.id, detail: ip });
      res.json({ ok: true, tenant: { id: r.tenant.id, slug: r.tenant.slug, name: r.tenant.name }, role: r.role });
    } catch (e) {
      const msg = errorMessage(e);
      if (/wrong password/.test(msg)) {
        noteFailure(ip, inv.login);
        audit(inv.login, 'auth.failed', { detail: `${ip} (invitation)` });
        return res.status(401).json({ error: 'wrong password — if you already have an account, use its password' });
      }
      fail(res, e);
    }
  });

  // the client a new tab opens in (each tab names its own with the x-gridwright-tenant header)
  app.post('/api/auth/switch', (req, res) => {
    const who = identityOf(req);
    const token = sessionTokenOf(req);
    if (!who.login || !token) return res.status(401).json({ error: 'sign in first' });
    const t = getTenant(String(req.body?.tenant ?? ''));
    if (!t || !roleIn(t.id, who.login)) return res.status(404).json({ error: 'no such client' });
    if (t.status === 'suspended' && !who.platformAdmin) return res.status(403).json({ error: 'this client account is suspended' });
    setSessionTenant(token, t.id);
    res.json({ ok: true, tenant: { id: t.id, slug: t.slug, name: t.name } });
  });

  // --- one's own account -------------------------------------------------------------------
  app.put('/api/account', (req, res) => {
    const who = identityOf(req);
    try {
      const u = updateUser(who.login, { name: typeof req.body?.name === 'string' ? req.body.name : undefined }, who.login);
      res.json({ login: u.login, name: u.name });
    } catch (e) {
      fail(res, e);
    }
  });
  app.get('/api/account/tokens', (req, res) => res.json(listApiTokens(identityOf(req).login)));
  // an API token for MCP clients and scripts: bound to the client it is made in, shown once
  app.post('/api/account/tokens', (req, res) => {
    const who = identityOf(req);
    if (who.agent) return res.status(403).json({ error: 'an agent cannot make tokens' });
    if (!who.tenant) return res.status(403).json({ error: 'open a client first: a token belongs to one client' });
    try {
      const t = createApiToken(who.login, who.tenant, String(req.body?.label ?? 'API token'), who.login);
      res.json({ id: t.id, token: t.token, tenant: who.tenant });
    } catch (e) {
      fail(res, e);
    }
  });
  app.delete('/api/account/tokens/:id', (req, res) => {
    const who = identityOf(req);
    res.json({ ok: revokeApiToken(who.login, req.params.id, who.login) });
  });

  // --- the current client and its members ---------------------------------------------------
  const currentTenant = (req: Request) => {
    const who = identityOf(req);
    return { who, tenant: who.tenant ? getTenant(who.tenant) : null };
  };
  app.get('/api/tenant', (req, res) => {
    const { who, tenant } = currentTenant(req);
    if (!tenant) return res.status(404).json({ error: 'no client' });
    res.json({ ...tenant, role: who.role, members: membersOf(tenant.id).length });
  });
  app.put('/api/tenant', requireRole('admin'), (req, res) => {
    const { who, tenant } = currentTenant(req);
    if (!tenant) return res.status(404).json({ error: 'no client' });
    try {
      // a client administrator renames the client; plan, seats and status are the platform's
      res.json(updateTenant(tenant.id, { name: typeof req.body?.name === 'string' ? req.body.name : undefined }, who.login));
    } catch (e) {
      fail(res, e);
    }
  });
  // everyone in the client sees who is in it (for sharing); administrators manage it
  app.get('/api/tenant/members', (req, res) => {
    const { tenant } = currentTenant(req);
    if (!tenant) return res.status(404).json({ error: 'no client' });
    res.json(membersOf(tenant.id));
  });
  // adding someone is an invitation they accept — the same answer whether or not they have an
  // account (no probing which e-mails exist), and nobody is put into a client without consenting
  app.post('/api/tenant/members', requireRole('admin'), (req, res) => {
    const { who, tenant } = currentTenant(req);
    if (!tenant || who.agent) return res.status(403).json({ error: 'not allowed' });
    try {
      const b = req.body ?? {};
      const inv = createInvitation(tenant.id, normaliseLogin(b.login), isRole(b.role) ? b.role : 'editor', who.login);
      res.json({ invited: true, id: inv.id, login: inv.login, role: inv.role, code: inv.code, link: `/?invite=${encodeURIComponent(inv.code)}`, expiresAt: inv.expiresAt });
    } catch (e) {
      fail(res, e);
    }
  });
  app.get('/api/tenant/invitations', requireRole('admin'), (req, res) => {
    const { tenant } = currentTenant(req);
    if (!tenant) return res.status(404).json({ error: 'no client' });
    res.json(listInvitations(tenant.id));
  });
  app.delete('/api/tenant/invitations/:id', requireRole('admin'), (req, res) => {
    const { who, tenant } = currentTenant(req);
    if (!tenant || who.agent) return res.status(403).json({ error: 'not allowed' });
    if (!revokeInvitation(tenant.id, req.params.id, who.login)) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });
  app.put('/api/tenant/members/:login', requireRole('admin'), (req, res) => {
    const { who, tenant } = currentTenant(req);
    if (!tenant || who.agent) return res.status(403).json({ error: 'not allowed' });
    try {
      setMemberRole(tenant.id, req.params.login, req.body?.role, who.login);
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });
  app.delete('/api/tenant/members/:login', requireRole('admin'), (req, res) => {
    const { who, tenant } = currentTenant(req);
    if (!tenant || who.agent) return res.status(403).json({ error: 'not allowed' });
    try {
      removeMember(tenant.id, req.params.login, who.login);
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });
  // a client administrator resets the password of someone who belongs to that client alone (anyone
  // else — a member of other clients too, a platform administrator — is the platform's to reset)
  app.post('/api/tenant/members/:login/reset-password', requireRole('admin'), (req, res) => {
    const { who, tenant } = currentTenant(req);
    if (!tenant || who.agent) return res.status(403).json({ error: 'not allowed' });
    const login = normaliseLogin(req.params.login);
    const user = getUser(login);
    if (!user || !roleIn(tenant.id, login)) return res.status(404).json({ error: 'not a member of this client' });
    const elsewhere = membershipsOf(login).some((m) => m.tenant.id !== tenant.id);
    if ((user.platformAdmin || elsewhere) && !who.platformAdmin) return res.status(403).json({ error: `${login} also belongs to other clients: a platform administrator resets that password` });
    try {
      res.json({ login, temporaryPassword: resetPassword(login, who.login) });
    } catch (e) {
      fail(res, e);
    }
  });
  app.get('/api/tenant/audit', requireRole('admin'), (req, res) => {
    const { tenant } = currentTenant(req);
    if (!tenant) return res.status(404).json({ error: 'no client' });
    res.json(listAudit({ tenant: tenant.id, limit: Number(req.query.limit ?? 200), before: req.query.before ? Number(req.query.before) : undefined }));
  });

  // --- the platform console ------------------------------------------------------------------
  app.get('/api/platform/tenants', requirePlatformAdmin, (_req, res) => {
    const usage = usageByTenant();
    res.json(listTenants().map((t) => ({ ...t, ...(usage.get(t.id) ?? { documents: 0, connections: 0 }) })));
  });
  // a new client; whoever makes it joins as its administrator unless `join: false`, and a first
  // client administrator can be named (made with a temporary password when they have no account)
  app.post('/api/platform/tenants', requirePlatformAdmin, (req, res) => {
    const who = identityOf(req);
    const b = req.body ?? {};
    try {
      const t = createTenant({ name: String(b.name ?? ''), slug: typeof b.slug === 'string' ? b.slug : undefined, plan: typeof b.plan === 'string' ? b.plan : undefined, seats: b.seats === undefined || b.seats === null || b.seats === '' ? null : Number(b.seats) }, who.login);
      if (b.join !== false) addMember(t.id, who.login, 'admin', who.login);
      const admin = b.admin && typeof b.admin === 'object' && (b.admin as { login?: unknown }).login ? addPerson(t.id, { ...(b.admin as Record<string, unknown>), role: 'admin' }, who.login) : undefined;
      res.json({ tenant: t, admin });
    } catch (e) {
      fail(res, e);
    }
  });
  app.put('/api/platform/tenants/:id', requirePlatformAdmin, (req, res) => {
    try {
      const b = req.body ?? {};
      res.json(updateTenant(req.params.id, { name: b.name, status: b.status, plan: b.plan, seats: b.seats === '' ? null : b.seats }, identityOf(req).login));
    } catch (e) {
      fail(res, e);
    }
  });
  // only an empty client is deleted: its documents and connections go first (suspend it otherwise)
  app.delete('/api/platform/tenants/:id', requirePlatformAdmin, (req, res) => {
    const t = getTenant(req.params.id);
    if (!t) return res.status(404).json({ error: 'no such client' });
    const u = usageByTenant().get(t.id);
    if (u && (u.documents || u.connections)) return res.status(409).json({ error: `${t.name} still has ${u.documents} document(s) and ${u.connections} connection(s): delete them first, or suspend the client` });
    try {
      deleteTenant(t.id, identityOf(req).login);
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });
  app.get('/api/platform/tenants/:id/members', requirePlatformAdmin, (req, res) => {
    const t = getTenant(req.params.id);
    if (!t) return res.status(404).json({ error: 'no such client' });
    res.json(membersOf(t.id));
  });
  app.post('/api/platform/tenants/:id/members', requirePlatformAdmin, (req, res) => {
    const t = getTenant(req.params.id);
    if (!t) return res.status(404).json({ error: 'no such client' });
    try {
      res.json(addPerson(t.id, req.body ?? {}, identityOf(req).login));
    } catch (e) {
      fail(res, e);
    }
  });
  app.put('/api/platform/tenants/:id/members/:login', requirePlatformAdmin, (req, res) => {
    try {
      setMemberRole(req.params.id, req.params.login, req.body?.role, identityOf(req).login);
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });
  app.delete('/api/platform/tenants/:id/members/:login', requirePlatformAdmin, (req, res) => {
    try {
      removeMember(req.params.id, req.params.login, identityOf(req).login);
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });
  app.get('/api/platform/users', requirePlatformAdmin, (_req, res) => {
    res.json(listUsers().map((u) => ({ ...u, memberships: membershipsOf(u.login).map((m) => ({ id: m.tenant.id, name: m.tenant.name, role: m.role })) })));
  });
  app.post('/api/platform/users', requirePlatformAdmin, (req, res) => {
    const b = req.body ?? {};
    try {
      const r = createUser({ login: String(b.login ?? ''), name: typeof b.name === 'string' ? b.name : undefined, password: typeof b.password === 'string' && b.password ? b.password : undefined, platformAdmin: b.platformAdmin === true }, identityOf(req).login);
      res.json({ ...r.user, temporaryPassword: r.temporaryPassword });
    } catch (e) {
      fail(res, e);
    }
  });
  app.put('/api/platform/users/:login', requirePlatformAdmin, (req, res) => {
    const b = req.body ?? {};
    try {
      res.json(updateUser(req.params.login, { name: b.name, status: b.status, platformAdmin: typeof b.platformAdmin === 'boolean' ? b.platformAdmin : undefined }, identityOf(req).login));
    } catch (e) {
      fail(res, e);
    }
  });
  app.post('/api/platform/users/:login/reset-password', requirePlatformAdmin, (req, res) => {
    try {
      const login = normaliseLogin(req.params.login);
      res.json({ login, temporaryPassword: resetPassword(login, identityOf(req).login) });
    } catch (e) {
      fail(res, e);
    }
  });
  app.get('/api/platform/audit', requirePlatformAdmin, (req, res) => {
    res.json(listAudit({ tenant: typeof req.query.tenant === 'string' && req.query.tenant ? req.query.tenant : undefined, limit: Number(req.query.limit ?? 200), before: req.query.before ? Number(req.query.before) : undefined }));
  });
}

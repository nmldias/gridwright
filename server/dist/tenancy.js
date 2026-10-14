// Multi-tenancy: clients (tenants), the people who use them (users), who belongs where with which
// role (memberships), how they sign in (a password and a session cookie, or an API token for MCP
// and scripts), and an audit trail of every account change. On with GRIDWRIGHT_AUTH=accounts;
// without it nothing here is consulted and the server is the single shared workspace it was.
//
// Isolation is logical and enforced where every other decision is already made: a document carries
// its client (access.ts), so does a connection (sqlpolicy.ts); the model settings and the inbox are
// per client; an identity carries the client it acts in, and every permission is checked against a
// live membership — removing someone, or suspending a client, takes effect on the next request and
// on open sessions at once. Platform administrators manage clients and people; reading a client's
// documents still takes a membership (added explicitly, and audited).
//
// The store is SQLite next to the data (platform.sqlite): one file, WAL, part of the same backup.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR, DEFAULT_TENANT } from './storage.js';
export { DEFAULT_TENANT };
export const ACCOUNTS = (process.env.GRIDWRIGHT_AUTH ?? '').trim().toLowerCase() === 'accounts';
export const ROLES = ['admin', 'editor', 'viewer'];
export const isRole = (v) => v === 'admin' || v === 'editor' || v === 'viewer';
const SESSION_COOKIE = 'gw_session';
const SESSION_TTL_MS = Number(process.env.GRIDWRIGHT_SESSION_HOURS ?? 24 * 14) * 3600_000;
const TENANT_HEADER = 'x-gridwright-tenant';
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  plan TEXT NOT NULL DEFAULT 'standard', seats INTEGER, created_at TEXT NOT NULL, created_by TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS users (
  login TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', password TEXT, platform_admin INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', must_change INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS memberships (
  tenant TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, login TEXT NOT NULL REFERENCES users(login) ON DELETE CASCADE,
  role TEXT NOT NULL, created_at TEXT NOT NULL, added_by TEXT NOT NULL DEFAULT '', PRIMARY KEY (tenant, login)
);
CREATE INDEX IF NOT EXISTS memberships_login ON memberships(login);
CREATE TABLE IF NOT EXISTS credentials (
  hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, login TEXT NOT NULL REFERENCES users(login) ON DELETE CASCADE,
  kind TEXT NOT NULL, tenant TEXT, label TEXT, created_at TEXT NOT NULL, expires_at TEXT, last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS credentials_login ON credentials(login, kind);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
  tenant TEXT, target TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_tenant ON audit(tenant, seq);
CREATE TABLE IF NOT EXISTS invitations (
  code_hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, tenant TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  login TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL, accepted_at TEXT
);
CREATE INDEX IF NOT EXISTS invitations_tenant ON invitations(tenant, login);
CREATE TABLE IF NOT EXISTS ai_usage (
  tenant TEXT NOT NULL, month TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0, estimated INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant, month)
);
CREATE TABLE IF NOT EXISTS ai_budgets (tenant TEXT PRIMARY KEY, monthly_tokens INTEGER);
CREATE TABLE IF NOT EXISTS signin_failures (
  key TEXT PRIMARY KEY, count INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL
);
`;
let db = null;
const now = () => new Date().toISOString();
const s = (v) => (v === null || v === undefined ? undefined : String(v));
/** The accounts store, for modules that keep their own platform tables in it (aiquota.ts). */
export const platformDb = () => theDb();
function theDb() {
    if (!db)
        throw new Error('accounts are not initialised (GRIDWRIGHT_AUTH=accounts needs Node ≥ 22.13 for node:sqlite)');
    return db;
}
const tenantOf = (r) => ({ id: String(r.id), slug: String(r.slug), name: String(r.name), status: r.status === 'suspended' ? 'suspended' : 'active', plan: String(r.plan ?? 'standard'), seats: r.seats === null || r.seats === undefined ? null : Number(r.seats), createdAt: String(r.created_at), createdBy: String(r.created_by ?? '') });
const userOf = (r) => ({ login: String(r.login), name: String(r.name ?? ''), platformAdmin: Number(r.platform_admin) === 1, status: r.status === 'disabled' ? 'disabled' : 'active', mustChangePassword: Number(r.must_change) === 1, hasPassword: !!r.password, createdAt: String(r.created_at), lastLoginAt: s(r.last_login_at) });
// ------------------------------------------------------------------ validation
export const normaliseLogin = (v) => String(v ?? '').trim().toLowerCase();
export const validLogin = (l) => l.length <= 200 && /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(l);
export const slugify = (v) => v
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
const MIN_PASSWORD = Number(process.env.GRIDWRIGHT_MIN_PASSWORD ?? 10);
export function passwordProblem(pw) {
    if (typeof pw !== 'string' || pw.length < MIN_PASSWORD)
        return `the password needs at least ${MIN_PASSWORD} characters`;
    if (pw.length > 256)
        return 'the password is too long';
    if (new Set(pw).size < 4)
        return 'the password is too simple';
    return null;
}
// ------------------------------------------------------------------ passwords
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
export function hashPassword(pw) {
    const salt = randomBytes(16);
    const h = scryptSync(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${h.toString('base64')}`;
}
function checkPassword(pw, stored) {
    if (!stored) {
        // the same work as a real check, so a missing account is not told apart by timing
        scryptSync(pw, 'gridwright-no-account', SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
        return false;
    }
    const [alg, N, r, p, salt, hash] = stored.split('$');
    if (alg !== 'scrypt' || !salt || !hash)
        return false;
    const expected = Buffer.from(hash, 'base64');
    const got = scryptSync(pw, Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
    return got.length === expected.length && timingSafeEqual(got, expected);
}
/** A password a person is given once and must change at first sign-in. */
export function temporaryPassword() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const bytes = randomBytes(16);
    let out = '';
    for (let i = 0; i < 16; i++)
        out += alphabet[bytes[i] % alphabet.length];
    return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12)}`;
}
// ------------------------------------------------------------------ the audit trail
export function audit(actor, action, e = {}) {
    if (!db)
        return;
    db.prepare('INSERT INTO audit (at, actor, action, tenant, target, detail) VALUES (?, ?, ?, ?, ?, ?)').run(now(), actor || 'system', action, e.tenant ?? null, e.target ?? null, e.detail ? e.detail.slice(0, 500) : null);
}
export function listAudit(filter = {}) {
    const where = [];
    const vals = [];
    if (filter.tenant) {
        where.push('tenant = ?');
        vals.push(filter.tenant);
    }
    if (filter.before) {
        where.push('seq < ?');
        vals.push(filter.before);
    }
    const rows = theDb()
        .prepare(`SELECT * FROM audit${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`)
        .all(...vals, Math.min(1000, Math.max(1, filter.limit ?? 200)));
    return rows.map((r) => ({ seq: Number(r.seq), at: String(r.at), actor: String(r.actor), action: String(r.action), tenant: s(r.tenant), target: s(r.target), detail: s(r.detail) }));
}
// ------------------------------------------------------------------ change notification
const listeners = [];
/** Called after any change that can alter what someone may do (membership, role, status). */
export function onAccessChange(fn) {
    listeners.push(fn);
}
const roleCache = new Map();
function changed() {
    roleCache.clear();
    for (const fn of listeners) {
        try {
            fn();
        }
        catch (e) {
            console.error('access-change listener failed:', e);
        }
    }
}
// ------------------------------------------------------------------ tenants
export function listTenants() {
    const rows = theDb().prepare('SELECT t.*, (SELECT COUNT(*) FROM memberships m WHERE m.tenant = t.id) AS members FROM tenants t ORDER BY t.name COLLATE NOCASE').all();
    return rows.map((r) => ({ ...tenantOf(r), members: Number(r.members) }));
}
/** A tenant by id or slug. */
export function getTenant(idOrSlug) {
    if (!idOrSlug || !db)
        return null;
    const r = db.prepare('SELECT * FROM tenants WHERE id = ? OR slug = ?').get(idOrSlug, idOrSlug);
    return r ? tenantOf(r) : null;
}
export function createTenant(input, actor) {
    const name = String(input.name ?? '').trim().slice(0, 120);
    if (!name)
        throw new Error('a client needs a name');
    let base = slugify(input.slug || name) || 'client';
    if (['api', 'admin', 'platform', 'mcp', 'ws', 'login', 'taken'].includes(base))
        base = `${base}-client`;
    let slug = base;
    for (let i = 2; getTenant(slug); i++)
        slug = `${base}-${i}`;
    const t = { id: input.id ?? randomBytes(8).toString('hex'), slug, name, status: 'active', plan: String(input.plan ?? 'standard').slice(0, 40) || 'standard', seats: input.seats === undefined || input.seats === null ? null : Math.max(1, Math.floor(Number(input.seats))), createdAt: now(), createdBy: actor };
    theDb().prepare('INSERT INTO tenants (id, slug, name, status, plan, seats, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(t.id, t.slug, t.name, t.status, t.plan, t.seats, t.createdAt, t.createdBy);
    audit(actor, 'client.created', { tenant: t.id, target: t.slug, detail: `${t.name} (${t.plan}${t.seats ? `, ${t.seats} seats` : ''})` });
    return t;
}
export function updateTenant(id, patch, actor) {
    const t = getTenant(id);
    if (!t)
        throw new Error('no such client');
    const next = { ...t };
    if (typeof patch.name === 'string' && patch.name.trim())
        next.name = patch.name.trim().slice(0, 120);
    if (patch.status === 'active' || patch.status === 'suspended')
        next.status = patch.status;
    if (typeof patch.plan === 'string' && patch.plan.trim())
        next.plan = patch.plan.trim().slice(0, 40);
    if (patch.seats !== undefined)
        next.seats = patch.seats === null || !Number.isFinite(Number(patch.seats)) || Number(patch.seats) <= 0 ? null : Math.floor(Number(patch.seats));
    theDb().prepare('UPDATE tenants SET name = ?, status = ?, plan = ?, seats = ? WHERE id = ?').run(next.name, next.status, next.plan, next.seats, t.id);
    const what = [next.name !== t.name && `name “${next.name}”`, next.status !== t.status && `status ${next.status}`, next.plan !== t.plan && `plan ${next.plan}`, next.seats !== t.seats && `seats ${next.seats ?? 'unlimited'}`].filter(Boolean).join(', ');
    if (what)
        audit(actor, 'client.updated', { tenant: t.id, target: t.slug, detail: what });
    if (next.status !== t.status)
        changed();
    return next;
}
/** Remove a client's account record (its documents must be gone first — the caller checks). */
export function deleteTenant(id, actor) {
    const t = getTenant(id);
    if (!t)
        throw new Error('no such client');
    if (t.id === DEFAULT_TENANT)
        throw new Error('the default client cannot be deleted');
    // its API tokens go with it; people stay signed in (they simply no longer have this client)
    theDb().prepare("DELETE FROM credentials WHERE tenant = ? AND kind = 'token'").run(t.id);
    theDb().prepare("UPDATE credentials SET tenant = NULL WHERE tenant = ? AND kind = 'session'").run(t.id);
    theDb().prepare('DELETE FROM tenants WHERE id = ?').run(t.id);
    audit(actor, 'client.deleted', { tenant: t.id, target: t.slug, detail: t.name });
    changed();
}
// ------------------------------------------------------------------ users
export function getUser(login) {
    if (!db)
        return null;
    const r = db.prepare('SELECT * FROM users WHERE login = ?').get(normaliseLogin(login));
    return r ? userOf(r) : null;
}
export function listUsers() {
    const rows = theDb().prepare('SELECT u.*, (SELECT COUNT(*) FROM memberships m WHERE m.login = u.login) AS clients FROM users u ORDER BY u.login').all();
    return rows.map((r) => ({ ...userOf(r), clients: Number(r.clients) }));
}
/**
 * A new person; without a password they get a temporary one (returned once). A password someone
 * else set — an administrator typing it in — must be changed at first sign-in too, so that nobody
 * keeps knowing it; only a password the person chose themselves (`ownPassword`) stands.
 */
export function createUser(input, actor) {
    const login = normaliseLogin(input.login);
    if (!validLogin(login))
        throw new Error('a login is an e-mail address');
    if (getUser(login))
        throw new Error(`${login} already has an account`);
    let temp;
    let pw = input.password;
    if (pw) {
        const problem = passwordProblem(pw);
        if (problem)
            throw new Error(problem);
    }
    else {
        temp = temporaryPassword();
        pw = temp;
    }
    const name = String(input.name ?? '').trim().slice(0, 120) || login.split('@')[0];
    const mustChange = !!temp || !input.ownPassword;
    theDb().prepare('INSERT INTO users (login, name, password, platform_admin, status, must_change, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(login, name, hashPassword(pw), input.platformAdmin ? 1 : 0, 'active', mustChange ? 1 : 0, now());
    audit(actor, 'user.created', { target: login, detail: input.platformAdmin ? 'platform administrator' : undefined });
    return { user: getUser(login), temporaryPassword: temp };
}
export function updateUser(login, patch, actor) {
    const u = getUser(login);
    if (!u)
        throw new Error('no such person');
    const next = { ...u };
    if (typeof patch.name === 'string' && patch.name.trim())
        next.name = patch.name.trim().slice(0, 120);
    if (patch.status === 'active' || patch.status === 'disabled')
        next.status = patch.status;
    if (typeof patch.platformAdmin === 'boolean')
        next.platformAdmin = patch.platformAdmin;
    if (u.platformAdmin && (!next.platformAdmin || next.status === 'disabled') && countPlatformAdmins() <= 1)
        throw new Error('the last platform administrator cannot be removed or disabled');
    theDb().prepare('UPDATE users SET name = ?, status = ?, platform_admin = ? WHERE login = ?').run(next.name, next.status, next.platformAdmin ? 1 : 0, u.login);
    const what = [next.name !== u.name && `name “${next.name}”`, next.status !== u.status && `status ${next.status}`, next.platformAdmin !== u.platformAdmin && (next.platformAdmin ? 'made platform administrator' : 'no longer platform administrator')].filter(Boolean).join(', ');
    if (what)
        audit(actor, 'user.updated', { target: u.login, detail: what });
    if (next.status === 'disabled' && u.status !== 'disabled')
        revokeCredentials(u.login, 'session');
    changed();
    return next;
}
const countPlatformAdmins = () => Number(theDb().prepare("SELECT COUNT(*) AS n FROM users WHERE platform_admin = 1 AND status = 'active'").get().n);
export function setPassword(login, pw, opts) {
    const u = getUser(login);
    if (!u)
        throw new Error('no such person');
    const problem = passwordProblem(pw);
    if (problem)
        throw new Error(problem);
    theDb().prepare('UPDATE users SET password = ?, must_change = ? WHERE login = ?').run(hashPassword(pw), opts.mustChange ? 1 : 0, u.login);
    // every other session ends: a changed password locks out whoever else held the old one
    const rows = theDb().prepare("SELECT hash FROM credentials WHERE login = ? AND kind = 'session'").all(u.login);
    for (const r of rows)
        if (String(r.hash) !== opts.keepSession)
            theDb().prepare('DELETE FROM credentials WHERE hash = ?').run(String(r.hash));
    audit(opts.actor, opts.actor === u.login ? 'user.password-changed' : 'user.password-reset', { target: u.login });
}
/** Reset by an administrator: a temporary password, shown once. */
export function resetPassword(login, actor) {
    const temp = temporaryPassword();
    setPassword(login, temp, { mustChange: true, actor });
    return temp;
}
/** Sign-in check: the user when the password is right and the account active. */
export function verifyLogin(login, pw) {
    const l = normaliseLogin(login);
    const r = db?.prepare('SELECT * FROM users WHERE login = ?').get(l);
    const ok = checkPassword(String(pw ?? ''), r ? s(r.password) : undefined);
    if (!ok || !r)
        return null;
    const u = userOf(r);
    if (u.status !== 'active')
        return null;
    theDb().prepare('UPDATE users SET last_login_at = ? WHERE login = ?').run(now(), l);
    return u;
}
// ------------------------------------------------------------------ memberships
export function membershipsOf(login) {
    if (!db)
        return [];
    const rows = db.prepare('SELECT t.*, m.role AS member_role FROM memberships m JOIN tenants t ON t.id = m.tenant WHERE m.login = ? ORDER BY t.name COLLATE NOCASE').all(normaliseLogin(login));
    return rows.map((r) => ({ tenant: tenantOf(r), role: isRole(r.member_role) ? r.member_role : 'viewer' }));
}
export function membersOf(tenant) {
    const rows = theDb().prepare('SELECT m.*, u.name, u.status, u.last_login_at FROM memberships m JOIN users u ON u.login = m.login WHERE m.tenant = ? ORDER BY u.name COLLATE NOCASE, m.login').all(tenant);
    return rows.map((r) => ({ tenant: String(r.tenant), login: String(r.login), name: String(r.name ?? ''), role: isRole(r.role) ? r.role : 'viewer', status: r.status === 'disabled' ? 'disabled' : 'active', addedAt: String(r.created_at), addedBy: String(r.added_by ?? ''), lastLoginAt: s(r.last_login_at) }));
}
export function roleIn(tenant, login) {
    if (!db || !tenant || !login)
        return null;
    const r = db.prepare('SELECT role FROM memberships WHERE tenant = ? AND login = ?').get(tenant, normaliseLogin(login));
    return r && isRole(r.role) ? r.role : null;
}
export const isMember = (tenant, login) => roleIn(tenant, login) !== null;
const adminCount = (tenant) => Number(theDb().prepare("SELECT COUNT(*) AS n FROM memberships WHERE tenant = ? AND role = 'admin'").get(tenant).n);
export function addMember(tenant, login, role, actor) {
    const t = getTenant(tenant);
    if (!t)
        throw new Error('no such client');
    const l = normaliseLogin(login);
    if (!getUser(l))
        throw new Error(`${l} has no account`);
    if (!isRole(role))
        throw new Error('role is admin, editor or viewer');
    const existing = roleIn(t.id, l);
    if (existing) {
        if (existing !== role)
            setMemberRole(t.id, l, role, actor);
        return;
    }
    if (t.seats !== null && membersOf(t.id).length >= t.seats)
        throw new Error(`${t.name} has used all ${t.seats} seats of its plan`);
    theDb().prepare('INSERT INTO memberships (tenant, login, role, created_at, added_by) VALUES (?, ?, ?, ?, ?)').run(t.id, l, role, now(), actor);
    audit(actor, 'member.added', { tenant: t.id, target: l, detail: role });
    changed();
}
export function setMemberRole(tenant, login, role, actor) {
    const l = normaliseLogin(login);
    const current = roleIn(tenant, l);
    if (!current)
        throw new Error(`${l} is not a member of this client`);
    if (!isRole(role))
        throw new Error('role is admin, editor or viewer');
    if (current === role)
        return;
    if (current === 'admin' && adminCount(tenant) <= 1)
        throw new Error('a client keeps at least one administrator');
    theDb().prepare('UPDATE memberships SET role = ? WHERE tenant = ? AND login = ?').run(role, tenant, l);
    audit(actor, 'member.role-changed', { tenant, target: l, detail: `${current} → ${role}` });
    changed();
}
export function removeMember(tenant, login, actor) {
    const l = normaliseLogin(login);
    const current = roleIn(tenant, l);
    if (!current)
        throw new Error(`${l} is not a member of this client`);
    if (current === 'admin' && adminCount(tenant) <= 1)
        throw new Error('a client keeps at least one administrator');
    theDb().prepare('DELETE FROM memberships WHERE tenant = ? AND login = ?').run(tenant, l);
    // tokens bound to the client stop working with the membership
    theDb().prepare("DELETE FROM credentials WHERE login = ? AND tenant = ? AND kind = 'token'").run(l, tenant);
    audit(actor, 'member.removed', { tenant, target: l, detail: current });
    changed();
}
/**
 * The role a login holds in a client right now (null: none — not a member, the account disabled,
 * or the client suspended for someone who does not run the platform). Cached for a moment: every
 * permission decision asks, including those on an open WebSocket.
 */
export function liveRole(tenant, login) {
    if (!ACCOUNTS)
        return null;
    if (!tenant || !login || !db)
        return null;
    const key = `${tenant}\n${login}`;
    const hit = roleCache.get(key);
    if (hit && Date.now() - hit.at < 1500)
        return hit.role;
    const r = db
        .prepare('SELECT m.role, u.status AS user_status, u.platform_admin, t.status AS tenant_status FROM memberships m JOIN users u ON u.login = m.login JOIN tenants t ON t.id = m.tenant WHERE m.tenant = ? AND m.login = ?')
        .get(tenant, normaliseLogin(login));
    let role = null;
    if (r && r.user_status === 'active' && isRole(r.role) && (r.tenant_status !== 'suspended' || Number(r.platform_admin) === 1))
        role = r.role;
    roleCache.set(key, { role, at: Date.now() });
    return role;
}
// ------------------------------------------------------------------ credentials (sessions, API tokens)
const hashOf = (token) => createHash('sha256').update(token).digest('hex');
function issue(login, kind, tenant, label, ttlMs) {
    const token = `${kind === 'session' ? 'gws' : 'gwk'}_${randomBytes(32).toString('base64url')}`;
    const id = randomBytes(6).toString('hex');
    theDb().prepare('INSERT INTO credentials (hash, id, login, kind, tenant, label, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(hashOf(token), id, normaliseLogin(login), kind, tenant, label, now(), ttlMs ? new Date(Date.now() + ttlMs).toISOString() : null, now());
    return { token, id };
}
export function createSession(login, tenant) {
    // expired sessions are swept as new ones are made
    theDb().prepare("DELETE FROM credentials WHERE kind = 'session' AND expires_at IS NOT NULL AND expires_at < ?").run(now());
    return issue(login, 'session', tenant, null, SESSION_TTL_MS).token;
}
export function createApiToken(login, tenant, label, actor) {
    if (!roleIn(tenant, login))
        throw new Error('an API token belongs to a client you are a member of');
    const t = issue(login, 'token', tenant, String(label || 'API token').slice(0, 80), null);
    audit(actor, 'token.created', { tenant, target: normaliseLogin(login), detail: label });
    return t;
}
export function listApiTokens(login) {
    const rows = theDb().prepare("SELECT * FROM credentials WHERE login = ? AND kind = 'token' ORDER BY created_at DESC").all(normaliseLogin(login));
    return rows.map((r) => ({ id: String(r.id), label: String(r.label ?? ''), tenant: s(r.tenant) ?? null, createdAt: String(r.created_at), lastSeenAt: s(r.last_seen_at) }));
}
export function revokeApiToken(login, id, actor) {
    const r = theDb().prepare("DELETE FROM credentials WHERE login = ? AND id = ? AND kind = 'token' RETURNING tenant").get(normaliseLogin(login), id);
    if (r)
        audit(actor, 'token.revoked', { tenant: s(r.tenant), target: normaliseLogin(login), detail: id });
    return !!r;
}
function revokeCredentials(login, kind) {
    theDb().prepare('DELETE FROM credentials WHERE login = ? AND kind = ?').run(normaliseLogin(login), kind);
}
export function endSession(token) {
    if (token)
        db?.prepare("DELETE FROM credentials WHERE hash = ? AND kind = 'session'").run(hashOf(token));
}
export function setSessionTenant(token, tenant) {
    db?.prepare("UPDATE credentials SET tenant = ? WHERE hash = ? AND kind = 'session'").run(tenant, hashOf(token));
}
export const sessionHash = (token) => hashOf(token);
// ------------------------------------------------------------------ requests
const header = (req, k) => {
    const v = req.headers[k];
    return ((Array.isArray(v) ? v[0] : v) ?? '').trim();
};
export function cookieOf(req, name) {
    for (const part of (req.headers.cookie ?? '').split(';')) {
        const p = part.trim();
        if (p.startsWith(name + '=')) {
            try {
                return decodeURIComponent(p.slice(name.length + 1));
            }
            catch {
                return '';
            }
        }
    }
    return '';
}
/** The session token a request carries (cookie, or `Authorization: Bearer gws_…`). */
export function sessionTokenOf(req) {
    const c = cookieOf(req, SESSION_COOKIE);
    if (c)
        return c;
    const auth = header(req, 'authorization');
    return auth.startsWith('Bearer gws_') ? auth.slice(7) : '';
}
function requestedTenant(req) {
    const h = header(req, TENANT_HEADER);
    if (h)
        return h;
    try {
        return new URL(req.url ?? '/', 'http://localhost').searchParams.get('tenant') ?? '';
    }
    catch {
        return '';
    }
}
export function sessionCookie(token, secure) {
    return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`;
}
export const clearSessionCookie = (secure) => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
/**
 * Who a request is, in which client. The credential is a session cookie, a Bearer token (session or
 * API token), or a login a trusted proxy vouched for (Tailscale) that has an account. The client is
 * the one the request names (header or `?tenant=`, per browser tab) — strictly: a client the person
 * is not a member of is refused, never silently swapped — else the session's last one, else the
 * person's first. An API token is bound to the client it was made in.
 */
export function resolveAccount(req, proxyLogin) {
    if (!db)
        return null;
    let login = '';
    let credential = 'session';
    let defaultTenant = null;
    let boundTenant = null;
    const token = (() => {
        const c = cookieOf(req, SESSION_COOKIE);
        if (c)
            return c;
        const auth = header(req, 'authorization');
        return auth.startsWith('Bearer gws_') || auth.startsWith('Bearer gwk_') ? auth.slice(7) : '';
    })();
    if (token) {
        const r = db.prepare('SELECT * FROM credentials WHERE hash = ?').get(hashOf(token));
        if (r && (!r.expires_at || String(r.expires_at) > now())) {
            login = String(r.login);
            credential = r.kind === 'token' ? 'token' : 'session';
            if (credential === 'token')
                boundTenant = s(r.tenant) ?? null;
            else
                defaultTenant = s(r.tenant) ?? null;
            // sliding expiry, written at most every ten minutes
            const seen = s(r.last_seen_at);
            if (!seen || Date.now() - Date.parse(seen) > 600_000) {
                db.prepare('UPDATE credentials SET last_seen_at = ?, expires_at = CASE WHEN kind = ? THEN ? ELSE expires_at END WHERE hash = ?').run(now(), 'session', new Date(Date.now() + SESSION_TTL_MS).toISOString(), hashOf(token));
            }
        }
    }
    if (!login && proxyLogin) {
        login = normaliseLogin(proxyLogin);
        credential = 'proxy';
    }
    if (!login)
        return null;
    const user = getUser(login);
    if (!user || user.status !== 'active')
        return null;
    const memberships = membershipsOf(login);
    const asked = boundTenant ?? requestedTenant(req);
    let chosen;
    let denied;
    // an API token works in its own client only: naming another one is a mistake to surface, not ignore
    const named = boundTenant ? requestedTenant(req) : '';
    const bound = boundTenant ? getTenant(boundTenant) : null;
    if (named && (!bound || (named !== bound.id && named !== bound.slug))) {
        denied = 'token-client';
    }
    else if (asked) {
        chosen = memberships.find((m) => m.tenant.id === asked || m.tenant.slug === asked);
        if (!chosen)
            denied = 'not-a-member';
    }
    else {
        chosen = memberships.find((m) => m.tenant.id === defaultTenant && m.tenant.status === 'active') ?? memberships.find((m) => m.tenant.status === 'active') ?? (user.platformAdmin ? memberships[0] : undefined);
        if (!chosen && memberships.length)
            denied = 'suspended'; // every client they belong to is suspended
    }
    if (chosen && chosen.tenant.status === 'suspended' && !user.platformAdmin) {
        chosen = undefined;
        denied = 'suspended';
    }
    return {
        login: user.login,
        name: user.name,
        role: chosen?.role ?? 'viewer',
        tenant: chosen?.tenant.id,
        tenantName: chosen?.tenant.name,
        tenantSlug: chosen?.tenant.slug,
        platformAdmin: user.platformAdmin,
        mustChangePassword: user.mustChangePassword && credential === 'session',
        credential,
        denied,
    };
}
// ------------------------------------------------------------------ sign-in throttling
// Hard limits per address and per address+account; across addresses an account only slows down (a
// pause that grows to 30 s), so nobody can lock a known e-mail out by failing on purpose. Counters
// live in SQLite (they survive a restart) and expire after the window; when too many are tracked
// the oldest go first — never all at once.
const WINDOW_MS = 15 * 60_000;
const LIMITS = { ip: 30, pair: 8 };
const SOFT_AFTER = 20;
const SOFT_MAX_S = 30;
const MAX_KEYS = 200_000;
const failRow = (key) => theDb().prepare('SELECT count, first_at, last_at FROM signin_failures WHERE key = ?').get(key);
/** Seconds to wait before another attempt (0 = go ahead). */
export function throttled(ip, login) {
    if (!db)
        return 0;
    const t = Date.now();
    let wait = 0;
    for (const [key, limit] of [[`ip:${ip}`, LIMITS.ip], [`pair:${ip}|${login}`, LIMITS.pair]]) {
        const r = failRow(key);
        if (!r)
            continue;
        if (t - r.first_at > WINDOW_MS)
            theDb().prepare('DELETE FROM signin_failures WHERE key = ?').run(key);
        else if (r.count >= limit)
            wait = Math.max(wait, Math.ceil((r.first_at + WINDOW_MS - t) / 1000));
    }
    const r = failRow(`login:${login}`);
    if (r && t - r.first_at <= WINDOW_MS && r.count >= SOFT_AFTER) {
        const pause = Math.min(SOFT_MAX_S, 2 ** Math.min(5, r.count - SOFT_AFTER)) * 1000;
        const left = r.last_at + pause - t;
        if (left > 0)
            wait = Math.max(wait, Math.ceil(left / 1000));
    }
    return wait;
}
let pruned = 0;
export function noteFailure(ip, login) {
    if (!db)
        return;
    const t = Date.now();
    const up = theDb().prepare(`INSERT INTO signin_failures (key, count, first_at, last_at) VALUES (?, 1, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN ? - first_at > ? THEN 1 ELSE count + 1 END,
       first_at = CASE WHEN ? - first_at > ? THEN ? ELSE first_at END,
       last_at = ?`);
    for (const key of [`ip:${ip}`, `pair:${ip}|${login}`, `login:${login}`])
        up.run(key, t, t, t, WINDOW_MS, t, WINDOW_MS, t, t);
    if (t - pruned > 60_000) {
        pruned = t;
        theDb().prepare('DELETE FROM signin_failures WHERE last_at < ?').run(t - WINDOW_MS);
        const n = Number(theDb().prepare('SELECT COUNT(*) AS n FROM signin_failures').get().n);
        if (n > MAX_KEYS)
            theDb().prepare('DELETE FROM signin_failures WHERE key IN (SELECT key FROM signin_failures ORDER BY last_at LIMIT ?)').run(n - Math.floor(MAX_KEYS * 0.9));
    }
}
/** After a successful sign-in: that address's count for the account, and the account's own pause. */
export function clearFailures(ip, login) {
    if (!db)
        return;
    theDb().prepare('DELETE FROM signin_failures WHERE key IN (?, ?)').run(`pair:${ip}|${login}`, `login:${login}`);
}
/** "try again in 40 seconds" / "in 3 minutes" */
export const waitText = (s) => (s < 60 ? `${s} second${s === 1 ? '' : 's'}` : `${Math.ceil(s / 60)} minute${s > 60 ? 's' : ''}`);
// ------------------------------------------------------------------ invitations
// A client administrator invites; the person accepts. An existing account is never attached to a
// client without its owner's consent, and the reply to "invite x@y" is the same whether or not x@y
// has an account anywhere (no way to probe which e-mails exist).
export const INVITE_DAYS = Math.max(1, Number(process.env.GRIDWRIGHT_INVITE_DAYS ?? 7) || 7);
const invitationOf = (r) => ({ id: String(r.id), tenant: String(r.tenant), login: String(r.login), role: isRole(r.role) ? r.role : 'viewer', createdAt: String(r.created_at), createdBy: String(r.created_by ?? ''), expiresAt: String(r.expires_at) });
/** A new invitation (any earlier one for the same person and client is replaced); the code is shown once. */
export function createInvitation(tenant, login, role, actor) {
    const t = getTenant(tenant);
    if (!t)
        throw new Error('no such client');
    const l = normaliseLogin(login);
    if (!validLogin(l))
        throw new Error('a login is an e-mail address');
    if (!isRole(role))
        throw new Error('role is admin, editor or viewer');
    if (roleIn(t.id, l))
        throw new Error(`${l} is already a member of ${t.name}`);
    if (t.seats !== null && membersOf(t.id).length >= t.seats)
        throw new Error(`${t.name} has used all ${t.seats} seats of its plan`);
    theDb().prepare('DELETE FROM invitations WHERE tenant = ? AND login = ? AND accepted_at IS NULL').run(t.id, l);
    const code = `gwi_${randomBytes(24).toString('base64url')}`;
    const id = randomBytes(8).toString('hex');
    const created = now();
    const expires = new Date(Date.now() + INVITE_DAYS * 86_400_000).toISOString();
    theDb().prepare('INSERT INTO invitations (code_hash, id, tenant, login, role, created_at, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(hashOf(code), id, t.id, l, role, created, actor, expires);
    audit(actor, 'member.invited', { tenant: t.id, target: l, detail: role });
    return { id, tenant: t.id, login: l, role, createdAt: created, createdBy: actor, expiresAt: expires, code };
}
export function listInvitations(tenant) {
    const rows = theDb().prepare('SELECT * FROM invitations WHERE tenant = ? AND accepted_at IS NULL AND expires_at > ? ORDER BY created_at DESC').all(tenant, now());
    return rows.map(invitationOf);
}
export function revokeInvitation(tenant, id, actor) {
    const r = theDb().prepare('SELECT * FROM invitations WHERE tenant = ? AND id = ? AND accepted_at IS NULL').get(tenant, id);
    if (!r)
        return false;
    theDb().prepare('DELETE FROM invitations WHERE id = ?').run(id);
    audit(actor, 'member.invitation-revoked', { tenant, target: String(r.login) });
    return true;
}
/** The pending invitation behind a code (null: unknown, used, expired, or its client is gone/suspended). */
export function invitationByCode(code) {
    if (!db || typeof code !== 'string' || !code.startsWith('gwi_') || code.length > 100)
        return null;
    const r = db.prepare('SELECT * FROM invitations WHERE code_hash = ? AND accepted_at IS NULL AND expires_at > ?').get(hashOf(code), now());
    if (!r)
        return null;
    const t = getTenant(String(r.tenant));
    if (!t || t.status !== 'active')
        return null;
    return { ...invitationOf(r), tenantName: t.name };
}
/**
 * Accept: with the password of the existing account, or — when there is none — the password the
 * person chooses now. The same message for "wrong password" and "no such account" mismatches.
 */
export function acceptInvitation(code, password, name) {
    const inv = invitationByCode(code);
    if (!inv)
        throw new Error('this invitation is no longer valid — ask for a new one');
    // the policy first, for both cases: the answer must not tell whether the account exists
    const problem = passwordProblem(password);
    if (problem)
        throw new Error(problem);
    const existing = getUser(inv.login);
    if (existing) {
        if (!verifyLogin(inv.login, password))
            throw new Error('wrong password for this account');
    }
    else {
        createUser({ login: inv.login, name, password, ownPassword: true }, inv.login);
    }
    addMember(inv.tenant, inv.login, inv.role, inv.createdBy || inv.login);
    theDb().prepare('UPDATE invitations SET accepted_at = ? WHERE id = ?').run(now(), inv.id);
    audit(inv.login, 'member.invitation-accepted', { tenant: inv.tenant, target: inv.login, detail: inv.role });
    return { login: inv.login, tenant: getTenant(inv.tenant), role: inv.role };
}
// ------------------------------------------------------------------ start-up
/**
 * Open the accounts store and make sure the platform can be entered: a default client (where every
 * document, connection and setting from before multi-tenancy lives) and a first platform
 * administrator — GRIDWRIGHT_ADMIN_EMAIL / GRIDWRIGHT_ADMIN_PASSWORD, or a generated password
 * written once to data/initial-admin.txt (mode 600) and never to the log.
 */
export async function initTenancy() {
    if (!ACCOUNTS)
        return;
    const emit = process.emitWarning;
    process.emitWarning = ((w, ...rest) => {
        if (String(w?.message ?? w).includes('SQLite'))
            return;
        return emit.call(process, w, ...rest);
    });
    let mod;
    try {
        mod = (await import('node:sqlite'));
    }
    finally {
        process.emitWarning = emit;
    }
    const path = process.env.GRIDWRIGHT_ACCOUNTS_DB ?? join(DATA_DIR, 'platform.sqlite');
    mkdirSync(dirname(path), { recursive: true });
    db = new mod.DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    db.exec(SCHEMA);
    try {
        chmodSync(path, 0o600);
    }
    catch {
        /* best effort */
    }
    if (!getTenant(DEFAULT_TENANT))
        createTenant({ id: DEFAULT_TENANT, name: process.env.GRIDWRIGHT_DEFAULT_CLIENT ?? 'Default client', slug: 'default' }, 'system');
    if (Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n) === 0) {
        const login = normaliseLogin(process.env.GRIDWRIGHT_ADMIN_EMAIL ?? 'admin@gridwright.local');
        const given = process.env.GRIDWRIGHT_ADMIN_PASSWORD ?? '';
        const { temporaryPassword: temp } = createUser({ login, name: process.env.GRIDWRIGHT_ADMIN_NAME ?? 'Administrator', password: given || undefined, platformAdmin: true, ownPassword: !!given }, 'system');
        addMember(DEFAULT_TENANT, login, 'admin', 'system');
        if (temp) {
            const file = join(DATA_DIR, 'initial-admin.txt');
            if (!existsSync(file))
                writeFileSync(file, `login: ${login}\npassword: ${temp}\n(change it at first sign-in; then delete this file)\n`, { mode: 0o600 });
            console.log(`accounts: first platform administrator ${login} — the temporary password is in ${file}`);
        }
        else
            console.log(`accounts: first platform administrator ${login} (password from GRIDWRIGHT_ADMIN_PASSWORD)`);
    }
}
export const accountsReady = () => !!db;

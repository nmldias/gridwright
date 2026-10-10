// Who is making a request. With GRIDWRIGHT_TRUST_TAILSCALE=1 the server trusts the
// identity headers that `tailscale serve` adds (Tailscale-User-Login / -Name); the
// listener should then be bound to 127.0.0.1 so nobody can reach it without the proxy.
//
// An investigation the server starts on someone's behalf runs as a local process that calls
// back over the loopback interface with a short-lived agent token: it carries exactly that
// person's identity and permissions — never more — and is marked as an agent so that what it
// records is proposed, not stated.
//
// With GRIDWRIGHT_AUTH=accounts (multi-tenant) a request is identified by its session or API token
// (tenancy.ts), and an identity also names the client it acts in, with the role it holds there.
import { randomBytes } from 'node:crypto';
import { ACCOUNTS, liveRole, resolveAccount } from './tenancy.js';
const TRUST = ['1', 'true', 'yes'].includes((process.env.GRIDWRIGHT_TRUST_TAILSCALE ?? '').toLowerCase());
const ADMINS = (process.env.GRIDWRIGHT_ADMINS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const READONLY = (process.env.GRIDWRIGHT_READONLY ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const agentTokens = new Map();
const isLoopback = (addr) => !!addr && (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1');
/**
 * The agent channel: a Unix socket the server listens on and binds into a sandbox (an agent cell).
 * A request on it is identified by an agent token and nothing else — never by Tailscale headers,
 * which any client of a socket could write — and without a valid token it is refused outright.
 */
const AGENT_CHANNEL = Symbol.for('gridwright.agentChannel');
export function markAgentChannel(socket) {
    socket[AGENT_CHANNEL] = true;
}
export function onAgentChannel(req) {
    return !!req.socket?.[AGENT_CHANNEL];
}
/** A token that would identify a request (live, not expired). */
export function agentTokenValid(token) {
    if (typeof token !== 'string' || !token)
        return false;
    const t = agentTokens.get(token);
    return !!t && t.expires > Date.now();
}
/** A token an agent process presents in `x-gridwright-agent`; valid from the loopback interface only, for `ttlMs`. */
export function issueAgentToken(identity, label, ttlMs = 20 * 60_000) {
    const token = randomBytes(24).toString('hex');
    agentTokens.set(token, { identity: { ...identity, agent: label }, expires: Date.now() + ttlMs });
    return token;
}
export function revokeAgentToken(token) {
    agentTokens.delete(token);
}
const resolved = new WeakMap();
/** Who a request is (resolved once per request: handlers ask several times). */
export function identityOf(req) {
    const hit = resolved.get(req);
    if (hit)
        return { ...hit };
    const id = resolveIdentity(req);
    resolved.set(req, id);
    return { ...id };
}
function resolveIdentity(req) {
    const agent = req.headers['x-gridwright-agent'];
    const channel = onAgentChannel(req);
    if (typeof agent === 'string' && agent && (channel || isLoopback(req.socket?.remoteAddress))) {
        const t = agentTokens.get(agent);
        if (t && t.expires > Date.now())
            return { ...t.identity };
    }
    // on the agent channel nothing but a token identifies a request: no headers are trusted there
    if (channel)
        return { login: '', name: '', role: 'viewer', agent: 'unauthenticated' };
    const h = (k) => {
        const v = req.headers[k];
        return (Array.isArray(v) ? v[0] : v) ?? '';
    };
    if (ACCOUNTS) {
        // a login the proxy vouches for still needs an account here; the role comes from the membership
        const a = resolveAccount(req, TRUST ? h('tailscale-user-login').trim() : undefined);
        if (!a)
            return { login: '', name: '', role: 'viewer' };
        return { login: a.login, name: a.name, role: a.role, tenant: a.tenant, tenantName: a.tenantName, tenantSlug: a.tenantSlug, platformAdmin: a.platformAdmin, mustChangePassword: a.mustChangePassword, denied: a.denied };
    }
    let login = '';
    let name = '';
    if (TRUST) {
        login = h('tailscale-user-login').trim();
        name = h('tailscale-user-name').trim() || login.split('@')[0];
    }
    const l = login.toLowerCase();
    let role = 'editor';
    if (l && READONLY.includes(l))
        role = 'viewer';
    else if (ADMINS.length === 0 || (l && ADMINS.includes(l)))
        role = 'admin';
    // with no identity at all everyone is an editor-admin unless admins are configured
    if (!l && ADMINS.length > 0)
        role = 'editor';
    return { login, name, role };
}
/**
 * The identity a login has on this server (the same role rules as a request's), for work done later
 * on a person's behalf. In accounts mode it is the membership in `tenant` as it stands now: someone
 * removed from the client since the work was queued gets no access through it.
 */
export function identityForLogin(login, name, tenant) {
    if (ACCOUNTS) {
        const role = liveRole(tenant, login);
        return role ? { login: login || '', name: name || login.split('@')[0] || '', role, tenant } : { login: login || '', name: name || '', role: 'viewer' };
    }
    const l = (login || '').toLowerCase();
    let role = 'editor';
    if (l && READONLY.includes(l))
        role = 'viewer';
    else if (ADMINS.length === 0 || (l && ADMINS.includes(l)))
        role = 'admin';
    if (!l && ADMINS.length > 0)
        role = 'editor';
    return { login: login || '', name: name || login.split('@')[0] || '', role };
}
/** People are told apart: by Tailscale, or by accounts. */
export const identityEnabled = TRUST || ACCOUNTS;
export const authMode = ACCOUNTS ? 'accounts' : TRUST ? 'tailscale' : 'none';

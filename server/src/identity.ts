// Who is making a request. With GRIDWRIGHT_TRUST_TAILSCALE=1 the server trusts the
// identity headers that `tailscale serve` adds (Tailscale-User-Login / -Name); the
// listener should then be bound to 127.0.0.1 so nobody can reach it without the proxy.
//
// An investigation the server starts on someone's behalf runs as a local process that calls
// back over the loopback interface with a short-lived agent token: it carries exactly that
// person's identity and permissions — never more — and is marked as an agent so that what it
// records is proposed, not stated.

import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export interface Identity {
  login: string; // "" when unknown
  name: string;
  role: 'admin' | 'editor' | 'viewer';
  /** set when the request comes from an agent process acting for this person */
  agent?: string;
}

const TRUST = ['1', 'true', 'yes'].includes((process.env.GRIDWRIGHT_TRUST_TAILSCALE ?? '').toLowerCase());
const ADMINS = (process.env.GRIDWRIGHT_ADMINS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const READONLY = (process.env.GRIDWRIGHT_READONLY ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const agentTokens = new Map<string, { identity: Identity; expires: number }>();
const isLoopback = (addr?: string) => !!addr && (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1');

/** A token an agent process presents in `x-gridwright-agent`; valid from the loopback interface only, for `ttlMs`. */
export function issueAgentToken(identity: Identity, label: string, ttlMs = 20 * 60_000): string {
  const token = randomBytes(24).toString('hex');
  agentTokens.set(token, { identity: { ...identity, agent: label }, expires: Date.now() + ttlMs });
  return token;
}
export function revokeAgentToken(token: string) {
  agentTokens.delete(token);
}

export function identityOf(req: IncomingMessage): Identity {
  const agent = req.headers['x-gridwright-agent'];
  if (typeof agent === 'string' && agent && isLoopback(req.socket?.remoteAddress)) {
    const t = agentTokens.get(agent);
    if (t && t.expires > Date.now()) return { ...t.identity };
  }
  let login = '';
  let name = '';
  if (TRUST) {
    const h = (k: string) => {
      const v = req.headers[k];
      return (Array.isArray(v) ? v[0] : v) ?? '';
    };
    login = h('tailscale-user-login').trim();
    name = h('tailscale-user-name').trim() || login.split('@')[0];
  }
  const l = login.toLowerCase();
  let role: Identity['role'] = 'editor';
  if (l && READONLY.includes(l)) role = 'viewer';
  else if (ADMINS.length === 0 || (l && ADMINS.includes(l))) role = 'admin';
  // with no identity at all everyone is an editor-admin unless admins are configured
  if (!l && ADMINS.length > 0) role = 'editor';
  return { login, name, role };
}

/** The identity a login has on this server (the same role rules as a request's), for work done later on a person's behalf. */
export function identityForLogin(login: string, name: string): Identity {
  const l = (login || '').toLowerCase();
  let role: Identity['role'] = 'editor';
  if (l && READONLY.includes(l)) role = 'viewer';
  else if (ADMINS.length === 0 || (l && ADMINS.includes(l))) role = 'admin';
  if (!l && ADMINS.length > 0) role = 'editor';
  return { login: login || '', name: name || login.split('@')[0] || '', role };
}

export const identityEnabled = TRUST;

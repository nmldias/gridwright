// Who is making a request. With GRIDWRIGHT_TRUST_TAILSCALE=1 the server trusts the
// identity headers that `tailscale serve` adds (Tailscale-User-Login / -Name); the
// listener should then be bound to 127.0.0.1 so nobody can reach it without the proxy.

import type { IncomingMessage } from 'node:http';

export interface Identity {
  login: string; // "" when unknown
  name: string;
  role: 'admin' | 'editor' | 'viewer';
}

const TRUST = ['1', 'true', 'yes'].includes((process.env.GRIDWRIGHT_TRUST_TAILSCALE ?? '').toLowerCase());
const ADMINS = (process.env.GRIDWRIGHT_ADMINS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const READONLY = (process.env.GRIDWRIGHT_READONLY ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

export function identityOf(req: IncomingMessage): Identity {
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

export const identityEnabled = TRUST;

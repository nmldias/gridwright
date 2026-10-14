// Accounts over HTTP (GRIDWRIGHT_AUTH=accounts): signing in, one's own account, the members of the
// client this tab works in, and the platform console. See server/src/routes/accounts.ts.
import { tenantFetch as fetch } from './tenant';

export type Role = 'admin' | 'editor' | 'viewer';
export interface Member {
  tenant: string;
  login: string;
  name: string;
  role: Role;
  status: 'active' | 'disabled';
  addedAt: string;
  addedBy: string;
  lastLoginAt?: string;
}
export interface TenantInfo {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
  plan: string;
  seats: number | null;
  createdAt: string;
  createdBy: string;
  members: number;
  documents?: number;
  connections?: number;
  role?: Role;
}
export interface UserInfo {
  login: string;
  name: string;
  platformAdmin: boolean;
  status: 'active' | 'disabled';
  mustChangePassword: boolean;
  createdAt: string;
  lastLoginAt?: string;
  clients: number;
  memberships: { id: string; name: string; role: Role }[];
}
export interface ApiToken {
  id: string;
  label: string;
  tenant: string | null;
  createdAt: string;
  lastSeenAt?: string;
}
export interface AuditEntry {
  seq: number;
  at: string;
  actor: string;
  action: string;
  tenant?: string;
  target?: string;
  detail?: string;
}
export interface Invitation {
  id: string;
  login: string;
  role: Role;
  createdAt: string;
  createdBy: string;
  expiresAt: string;
}
/** what inviting someone returns: the link (with its one-time code) to hand to them */
export interface InvitationSent {
  invited: true;
  id: string;
  login: string;
  role: Role;
  code: string;
  link: string;
  expiresAt: string;
}
export interface AiUsage {
  month: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated: boolean;
}
export interface AiBudget {
  /** null: unlimited, 0: AI off */
  tokens: number | null;
  own: boolean;
}
export interface AiUsageView {
  month: string;
  budget: AiBudget;
  usage: AiUsage;
  history: AiUsage[];
  limits: { perMinuteClient: number; perMinutePerson: number };
}
export interface PlatformAiUsage {
  month: string;
  defaultBudget: number | null;
  limits: { perMinuteClient: number; perMinutePerson: number };
  clients: { id: string; slug: string; name: string; budget: AiBudget; usage: AiUsage }[];
}
export interface AddedPerson {
  login: string;
  role: Role;
  created: boolean;
  temporaryPassword?: string;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}
const enc = encodeURIComponent;

export const accounts = {
  login: (login: string, password: string, tenant?: string) => call<{ ok: true; mustChangePassword: boolean; tenant: { id: string; slug: string; name: string } | null }>('POST', '/api/auth/login', { login, password, tenant }),
  logout: () => call<{ ok: true }>('POST', '/api/auth/logout', {}),
  invitation: (code: string) => call<{ tenant: string; login: string; role: Role; expiresAt: string }>('GET', `/api/auth/invitation?code=${enc(code)}`),
  acceptInvitation: (code: string, password: string, name?: string) => call<{ ok: true; tenant: { id: string; slug: string; name: string }; role: Role }>('POST', '/api/auth/invitation/accept', { code, password, name }),
  changePassword: (current: string, next: string) => call<{ ok: true }>('POST', '/api/auth/password', { current, next }),
  rename: (name: string) => call<{ login: string; name: string }>('PUT', '/api/account', { name }),
  tokens: {
    list: () => call<ApiToken[]>('GET', '/api/account/tokens'),
    create: (label: string) => call<{ id: string; token: string; tenant: string }>('POST', '/api/account/tokens', { label }),
    revoke: (id: string) => call<{ ok: boolean }>('DELETE', `/api/account/tokens/${enc(id)}`),
  },
  // the client this tab works in
  tenant: {
    get: () => call<TenantInfo>('GET', '/api/tenant'),
    rename: (name: string) => call<TenantInfo>('PUT', '/api/tenant', { name }),
    members: () => call<Member[]>('GET', '/api/tenant/members'),
    invite: (p: { login: string; role: Role }) => call<InvitationSent>('POST', '/api/tenant/members', p),
    invitations: () => call<Invitation[]>('GET', '/api/tenant/invitations'),
    revokeInvitation: (id: string) => call<{ ok: true }>('DELETE', `/api/tenant/invitations/${enc(id)}`),
    aiUsage: () => call<AiUsageView>('GET', '/api/tenant/ai-usage'),
    setRole: (login: string, role: Role) => call<{ ok: true }>('PUT', `/api/tenant/members/${enc(login)}`, { role }),
    remove: (login: string) => call<{ ok: true }>('DELETE', `/api/tenant/members/${enc(login)}`),
    resetPassword: (login: string) => call<{ login: string; temporaryPassword: string }>('POST', `/api/tenant/members/${enc(login)}/reset-password`, {}),
    audit: () => call<AuditEntry[]>('GET', '/api/tenant/audit'),
  },
  // the platform console (platform administrators)
  platform: {
    tenants: () => call<TenantInfo[]>('GET', '/api/platform/tenants'),
    createTenant: (b: { name: string; slug?: string; plan?: string; seats?: number | null; join?: boolean; admin?: { login: string; name?: string } }) => call<{ tenant: TenantInfo; admin?: AddedPerson }>('POST', '/api/platform/tenants', b),
    updateTenant: (id: string, b: { name?: string; status?: 'active' | 'suspended'; plan?: string; seats?: number | null | '' }) => call<TenantInfo>('PUT', `/api/platform/tenants/${enc(id)}`, b),
    deleteTenant: (id: string) => call<{ ok: true }>('DELETE', `/api/platform/tenants/${enc(id)}`),
    members: (id: string) => call<Member[]>('GET', `/api/platform/tenants/${enc(id)}/members`),
    addMember: (id: string, p: { login: string; name?: string; role: Role }) => call<AddedPerson>('POST', `/api/platform/tenants/${enc(id)}/members`, p),
    setRole: (id: string, login: string, role: Role) => call<{ ok: true }>('PUT', `/api/platform/tenants/${enc(id)}/members/${enc(login)}`, { role }),
    removeMember: (id: string, login: string) => call<{ ok: true }>('DELETE', `/api/platform/tenants/${enc(id)}/members/${enc(login)}`),
    users: () => call<UserInfo[]>('GET', '/api/platform/users'),
    createUser: (b: { login: string; name?: string; platformAdmin?: boolean }) => call<UserInfo & { temporaryPassword?: string }>('POST', '/api/platform/users', b),
    updateUser: (login: string, b: { name?: string; status?: 'active' | 'disabled'; platformAdmin?: boolean }) => call<UserInfo>('PUT', `/api/platform/users/${enc(login)}`, b),
    resetPassword: (login: string) => call<{ login: string; temporaryPassword: string }>('POST', `/api/platform/users/${enc(login)}/reset-password`, {}),
    aiUsage: () => call<PlatformAiUsage>('GET', '/api/platform/ai-usage'),
    setAiBudget: (id: string, monthlyTokens: number | null | 'default') => call<AiUsageView>('PUT', `/api/platform/tenants/${enc(id)}/ai-budget`, { monthlyTokens }),
    audit: (tenant?: string) => call<AuditEntry[]>('GET', `/api/platform/audit${tenant ? `?tenant=${enc(tenant)}` : ''}`),
    ai: () => call<{ baseUrl: string; model: string; hasKey: boolean; configured: boolean }>('GET', '/api/platform/ai'),
    saveAi: (b: { baseUrl?: string; model?: string; apiKey?: string }) => call<{ baseUrl: string; model: string; hasKey: boolean; configured: boolean }>('PUT', '/api/platform/ai', b),
  },
};

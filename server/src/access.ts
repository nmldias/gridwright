// Per-document access metadata: data/files/<id>.meta.json
//
//   { owner, public: 'edit' | 'view' | 'none', shares: { "<login>": 'view' | 'edit' | 'sign' }, folder }
//
// It only restricts anything when identity is on (GRIDWRIGHT_TRUST_TAILSCALE=1): without a login
// nobody can be told apart, so every document stays open to whoever reaches the server.
// Server-wide roles still apply on top: viewers never write, admins see everything.

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { identityEnabled, type Identity } from './identity.js';
import { DATA_DIR } from './storage.js';

export type ShareLevel = 'view' | 'edit' | 'sign';
export type PublicLevel = 'edit' | 'view' | 'none';
/** What a request may do with a document. `sign` = view + sign-off ops. */
export type Permission = 'none' | 'view' | 'sign' | 'edit' | 'own';

export interface FileAccess {
  owner: string; // login; "" = nobody (open document)
  ownerName?: string;
  public: PublicLevel;
  shares: Record<string, ShareLevel>;
  folder: string;
}

const safeId = (id: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(id);
const metaPath = (id: string) => join(DATA_DIR, 'files', `${id}.meta.json`);

export const DEFAULT_ACCESS: FileAccess = { owner: '', public: 'edit', shares: {}, folder: '' };

export function readAccess(id: string): FileAccess {
  if (!safeId(id)) return { ...DEFAULT_ACCESS };
  const p = metaPath(id);
  if (!existsSync(p)) return { ...DEFAULT_ACCESS };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<FileAccess>;
    return normalise(raw);
  } catch {
    return { ...DEFAULT_ACCESS };
  }
}

export function writeAccess(id: string, access: FileAccess) {
  if (!safeId(id)) throw new Error('bad id');
  const p = metaPath(id);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(normalise(access), null, 2));
  renameSync(tmp, p);
}

export function deleteAccess(id: string) {
  if (!safeId(id)) return;
  try {
    unlinkSync(metaPath(id));
  } catch {
    /* none */
  }
}

export function normalise(raw: Partial<FileAccess>): FileAccess {
  const shares: Record<string, ShareLevel> = {};
  for (const [k, v] of Object.entries(raw.shares ?? {})) {
    const login = k.trim().toLowerCase();
    if (!login || login.length > 200) continue;
    if (v === 'view' || v === 'edit' || v === 'sign') shares[login] = v;
  }
  const pub: PublicLevel = raw.public === 'view' || raw.public === 'none' ? raw.public : 'edit';
  return {
    owner: String(raw.owner ?? '').trim().toLowerCase().slice(0, 200),
    ownerName: raw.ownerName ? String(raw.ownerName).slice(0, 120) : undefined,
    public: pub,
    shares,
    folder: String(raw.folder ?? '')
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean)
      .join('/')
      .slice(0, 200),
  };
}

/** Effective permission of an identity on a document. */
export function permissionFor(access: FileAccess, id: Identity): Permission {
  const cap = (p: Permission): Permission => {
    // server-wide viewers never write; nobody exceeds their server role
    if (id.role === 'viewer') return p === 'none' ? 'none' : 'view';
    return p;
  };
  if (!identityEnabled || !access.owner) return cap('own');
  if (id.role === 'admin') return 'own';
  const login = id.login.toLowerCase();
  if (login && login === access.owner) return 'own';
  const share = login ? access.shares[login] : undefined;
  if (share) return cap(share);
  if (access.public === 'edit') return cap('edit');
  if (access.public === 'view') return cap('view');
  return 'none';
}

export const canView = (p: Permission) => p !== 'none';
export const canEdit = (p: Permission) => p === 'edit' || p === 'own';
export const canSign = (p: Permission) => p === 'sign' || canEdit(p);
export const canManage = (p: Permission) => p === 'own';

/** Ops a `sign`-level peer may send. */
export const SIGN_OPS = new Set(['add_signoff', 'remove_signoff', 'set_signoff_locked']);

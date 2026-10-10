// Per-document access metadata: data/files/<id>.meta.json
//
//   { owner, public: 'edit' | 'view' | 'none', shares: { "<login>": 'view' | 'edit' | 'sign' }, folder }
//
// It only restricts anything when identity is on (GRIDWRIGHT_TRUST_TAILSCALE=1): without a login
// nobody can be told apart, so every document stays open to whoever reaches the server.
// Server-wide roles still apply on top: viewers never write, admins see everything.
//
// With accounts (GRIDWRIGHT_AUTH=accounts) a document also belongs to one client (`tenant`), set
// when it is created and never changed by a request. Nobody outside that client gets any access —
// not by a share, not as an administrator of another client — and within it the role that counts is
// the membership as it stands now ("public" then means: everyone in the client).
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { identityEnabled } from './identity.js';
import { DATA_DIR, DEFAULT_TENANT } from './storage.js';
import { ACCOUNTS, liveRole } from './tenancy.js';
const safeId = (id) => /^[a-zA-Z0-9_-]{1,64}$/.test(id);
const metaPath = (id) => join(DATA_DIR, 'files', `${id}.meta.json`);
export const DEFAULT_ACCESS = { owner: '', public: 'edit', shares: {}, folder: '' };
/** The client a document belongs to. */
export const tenantOf = (a) => a.tenant || DEFAULT_TENANT;
export const tenantOfDoc = (id) => tenantOf(readAccess(id));
export function readAccess(id) {
    if (!safeId(id))
        return { ...DEFAULT_ACCESS };
    const p = metaPath(id);
    if (!existsSync(p))
        return { ...DEFAULT_ACCESS };
    try {
        const raw = JSON.parse(readFileSync(p, 'utf8'));
        return normalise(raw);
    }
    catch {
        return { ...DEFAULT_ACCESS };
    }
}
export function writeAccess(id, access) {
    if (!safeId(id))
        throw new Error('bad id');
    const p = metaPath(id);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(normalise(access), null, 2));
    renameSync(tmp, p);
}
export function deleteAccess(id) {
    if (!safeId(id))
        return;
    try {
        unlinkSync(metaPath(id));
    }
    catch {
        /* none */
    }
}
export function normalise(raw) {
    const shares = {};
    for (const [k, v] of Object.entries(raw.shares ?? {})) {
        const login = k.trim().toLowerCase();
        if (!login || login.length > 200)
            continue;
        if (v === 'view' || v === 'edit' || v === 'sign')
            shares[login] = v;
    }
    const pub = raw.public === 'view' || raw.public === 'none' ? raw.public : 'edit';
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
        tenant: typeof raw.tenant === 'string' && safeId(raw.tenant) ? raw.tenant : undefined,
    };
}
/** Effective permission of an identity on a document. */
export function permissionFor(access, id) {
    let role = id.role;
    if (ACCOUNTS) {
        // the client boundary comes first, then the membership as it is now
        if (!id.tenant || !id.login || tenantOf(access) !== id.tenant)
            return 'none';
        const live = liveRole(id.tenant, id.login);
        if (!live)
            return 'none';
        role = live;
    }
    const cap = (p) => {
        // server-wide viewers never write; nobody exceeds their server role
        if (role === 'viewer')
            return p === 'none' ? 'none' : 'view';
        return p;
    };
    if (!identityEnabled || !access.owner)
        return cap('own');
    if (role === 'admin')
        return 'own';
    const login = id.login.toLowerCase();
    if (login && login === access.owner)
        return 'own';
    const share = login ? access.shares[login] : undefined;
    if (share)
        return cap(share);
    if (access.public === 'edit')
        return cap('edit');
    if (access.public === 'view')
        return cap('view');
    return 'none';
}
export const canView = (p) => p !== 'none';
export const canEdit = (p) => p === 'edit' || p === 'own';
export const canSign = (p) => p === 'sign' || canEdit(p);
export const canManage = (p) => p === 'own';
/** Ops a `sign`-level peer may send. */
export const SIGN_OPS = new Set(['add_signoff', 'remove_signoff', 'set_signoff_locked']);

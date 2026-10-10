// On-disk storage: documents, connections, AI settings, server secret.

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const DATA_DIR = process.env.GRIDWRIGHT_DATA ?? join(process.cwd(), 'data');

/**
 * Test-only fault injection: with GRIDWRIGHT_CRASH_AT=<point> the process dies (SIGKILL, no
 * cleanup) when it reaches that point, so the recovery suite can show that an interruption at a
 * boundary neither loses nor duplicates accepted work. Off unless the variable names a point.
 */
export function crashPoint(name: string) {
  if (process.env.GRIDWRIGHT_CRASH_AT !== name) return;
  console.error(`crash point reached: ${name} (GRIDWRIGHT_CRASH_AT) — dying without cleanup`);
  process.kill(process.pid, 'SIGKILL');
}
const FILES_DIR = join(DATA_DIR, 'files');

export function ensureDirs() {
  mkdirSync(FILES_DIR, { recursive: true });
}

// --- secret & encryption ---------------------------------------------------
let secret: Buffer | null = null;
export function getSecret(): Buffer {
  if (secret) return secret;
  const env = process.env.GRIDWRIGHT_SECRET;
  if (env && env.length >= 16) {
    secret = createHash('sha256').update(env).digest();
    return secret;
  }
  const p = join(DATA_DIR, 'secret.key');
  if (existsSync(p)) {
    secret = Buffer.from(readFileSync(p, 'utf8').trim(), 'hex');
  } else {
    ensureDirs();
    secret = randomBytes(32);
    writeFileSync(p, secret.toString('hex'), { mode: 0o600 });
  }
  return secret;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', getSecret(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decrypt(payload: string): string {
  const [v, iv, tag, enc] = payload.split(':');
  if (v !== 'v1') throw new Error('unknown secret format');
  const d = createDecipheriv('aes-256-gcm', getSecret(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

// --- json helpers ------------------------------------------------------------
function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}
function writeJsonAtomic(path: string, value: unknown) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

// --- documents -----------------------------------------------------------------
export interface FileMeta {
  id: string;
  name: string;
  updatedAt: string;
  size: number;
}

const safeId = (id: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(id);

/** The client a record belongs to when it predates multi-tenancy (or the server runs without it). */
export const DEFAULT_TENANT = 'default';

/**
 * Every document, newest first. `include` is asked first, by id (cheap: the access metadata), so a
 * document the caller may not see is never read — with many clients on one server that matters.
 */
export function listFiles(include?: (id: string) => boolean): FileMeta[] {
  ensureDirs();
  const out: FileMeta[] = [];
  for (const f of readdirSync(FILES_DIR)) {
    if (!f.endsWith('.json') || f.endsWith('.meta.json')) continue;
    const id = f.slice(0, -5);
    if (include && !include(id)) continue;
    const p = join(FILES_DIR, f);
    try {
      const st = statSync(p);
      const doc = readJson<{ name?: string }>(p, {});
      out.push({ id, name: doc.name || id, updatedAt: st.mtime.toISOString(), size: st.size });
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return out;
}

export function readFile(id: string): { id: string; name: string; json: string } | null {
  if (!safeId(id)) return null;
  const p = join(FILES_DIR, `${id}.json`);
  if (!existsSync(p)) return null;
  const json = readFileSync(p, 'utf8');
  let name = id;
  try {
    name = JSON.parse(json).name || id;
  } catch {
    /* ignore */
  }
  return { id, name, json };
}

export function writeFile(id: string | null, name: string, json: string): FileMeta {
  ensureDirs();
  const fid = id ?? randomUUID().replace(/-/g, '').slice(0, 16);
  if (!safeId(fid)) throw new Error('bad id');
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(json);
  } catch {
    throw new Error('document is not valid JSON');
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray((doc as any).tables)) throw new Error('not a Gridwright document');
  doc.name = name;
  const p = join(FILES_DIR, `${fid}.json`);
  const tmp = `${p}.${process.pid}.tmp`;
  const text = JSON.stringify(doc);
  writeFileSync(tmp, text);
  renameSync(tmp, p);
  return { id: fid, name, updatedAt: new Date().toISOString(), size: text.length };
}

export function deleteFile(id: string): boolean {
  if (!safeId(id)) return false;
  const p = join(FILES_DIR, `${id}.json`);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

/** Directory holding a self-hosted Pyodide distribution (served at /pyodide/), when present. */
export function pyodideDir(): string | null {
  const p = process.env.GRIDWRIGHT_PYODIDE_DIR ?? join(DATA_DIR, 'pyodide');
  return existsSync(join(p, 'pyodide.mjs')) || existsSync(join(p, 'pyodide.js')) ? p : null;
}

// --- connections -------------------------------------------------------------------
export interface StoredConnection {
  id: string;
  name: string;
  kind: 'postgres' | 'mysql' | 'mssql';
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: boolean;
  passwordEnc?: string;
  /** only SELECT statements are accepted and the session runs read-only where the database supports it (default true) */
  readOnly?: boolean;
  /** logins allowed to query this connection (empty = every editor); admins are always allowed */
  allowed?: string[];
  /** rows a single query may return to a client (default 5000, hard cap 50 000) */
  maxRows?: number;
  /** statement timeout in milliseconds (default 30 000, cap 300 000) */
  timeoutMs?: number;
  /** the client (tenant) the connection belongs to; absent = the default client */
  tenant?: string;
}

export const connectionTenant = (c: StoredConnection) => c.tenant || DEFAULT_TENANT;

const CONN_PATH = () => join(DATA_DIR, 'connections.json');

export function listConnections(): StoredConnection[] {
  return readJson<StoredConnection[]>(CONN_PATH(), []);
}

export function saveConnections(list: StoredConnection[]) {
  ensureDirs();
  writeJsonAtomic(CONN_PATH(), list);
}

export function newId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

// --- AI settings --------------------------------------------------------------------
export interface AiConfig {
  baseUrl: string;
  model: string;
  apiKeyEnc?: string;
  /** where the settings come from: the platform default, or a client's own override */
  scope?: 'platform' | 'client';
  /** whether AI_API_KEY from the environment may be used for this endpoint */
  envKey?: boolean;
}

const AI_PATH = () => join(DATA_DIR, 'ai.json');
const safeTenant = (t: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(t);
const TENANT_AI_PATH = (tenant: string) => join(DATA_DIR, 'tenants', tenant, 'ai.json');
const sameEndpoint = (a: string, b: string) => a.trim().replace(/\/+$/, '') === b.trim().replace(/\/+$/, '');

/** The platform default (ai.json, then AI_BASE_URL / AI_MODEL / AI_API_KEY). */
export function readPlatformAiConfig(): AiConfig {
  const stored = readJson<Partial<AiConfig>>(AI_PATH(), {});
  return {
    baseUrl: stored.baseUrl ?? process.env.AI_BASE_URL ?? '',
    model: stored.model ?? process.env.AI_MODEL ?? '',
    apiKeyEnc: stored.apiKeyEnc,
    scope: 'platform',
    envKey: true,
  };
}

/** A client's own settings, or null when it uses the platform default. */
export function readTenantAiConfig(tenant: string): AiConfig | null {
  if (!safeTenant(tenant)) return null;
  const p = TENANT_AI_PATH(tenant);
  if (!existsSync(p)) return null;
  const t = readJson<Partial<AiConfig>>(p, {});
  if (!t.baseUrl && !t.model && !t.apiKeyEnc) return null;
  return { baseUrl: t.baseUrl ?? '', model: t.model ?? '', apiKeyEnc: t.apiKeyEnc, scope: 'client' };
}

/**
 * The settings in force for a client (or the platform default without one). A client may name its
 * own endpoint, model and key; whatever it leaves empty comes from the platform default — except the
 * key: the platform's key is only ever sent to the platform's own endpoint, never to an endpoint a
 * client typed in (that would hand the operator's key to whoever runs it).
 */
export function readAiConfig(tenant?: string): AiConfig {
  const platform = readPlatformAiConfig();
  const t = tenant ? readTenantAiConfig(tenant) : null;
  if (!t) return platform;
  const baseUrl = t.baseUrl || platform.baseUrl;
  const platformEndpoint = sameEndpoint(baseUrl, platform.baseUrl);
  return {
    baseUrl,
    model: t.model || platform.model,
    apiKeyEnc: t.apiKeyEnc ?? (platformEndpoint ? platform.apiKeyEnc : undefined),
    scope: 'client',
    envKey: !t.apiKeyEnc && platformEndpoint,
  };
}

/** The key to send with a configuration ("" = none). */
export function aiKeyOf(cfg: AiConfig): string {
  if (cfg.apiKeyEnc) return decrypt(cfg.apiKeyEnc);
  return cfg.envKey === false ? '' : process.env.AI_API_KEY ?? '';
}

/** Write the platform default (no tenant) or a client's override. */
export function writeAiConfig(cfg: AiConfig, tenant?: string) {
  ensureDirs();
  const plain = { baseUrl: cfg.baseUrl, model: cfg.model, apiKeyEnc: cfg.apiKeyEnc };
  if (!tenant) return writeJsonAtomic(AI_PATH(), plain);
  if (!safeTenant(tenant)) throw new Error('bad client id');
  mkdirSync(join(DATA_DIR, 'tenants', tenant), { recursive: true });
  writeJsonAtomic(TENANT_AI_PATH(tenant), plain);
}

/** A client's override removed: it uses the platform default again. */
export function clearTenantAiConfig(tenant: string) {
  if (!safeTenant(tenant)) return;
  try {
    unlinkSync(TENANT_AI_PATH(tenant));
  } catch {
    /* none */
  }
}

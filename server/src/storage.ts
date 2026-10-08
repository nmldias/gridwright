// On-disk storage: documents, connections, AI settings, server secret.

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const DATA_DIR = process.env.GRIDWRIGHT_DATA ?? join(process.cwd(), 'data');
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

export function listFiles(): FileMeta[] {
  ensureDirs();
  const out: FileMeta[] = [];
  for (const f of readdirSync(FILES_DIR)) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -5);
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

// --- connections -------------------------------------------------------------------
export interface StoredConnection {
  id: string;
  name: string;
  kind: 'postgres' | 'mysql';
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: boolean;
  passwordEnc?: string;
}

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
}

const AI_PATH = () => join(DATA_DIR, 'ai.json');

export function readAiConfig(): AiConfig {
  const stored = readJson<Partial<AiConfig>>(AI_PATH(), {});
  return {
    baseUrl: stored.baseUrl ?? process.env.AI_BASE_URL ?? '',
    model: stored.model ?? process.env.AI_MODEL ?? '',
    apiKeyEnc: stored.apiKeyEnc,
  };
}

export function writeAiConfig(cfg: AiConfig) {
  ensureDirs();
  writeJsonAtomic(AI_PATH(), cfg);
}

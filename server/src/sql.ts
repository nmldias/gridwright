// Database connections (PostgreSQL / MySQL) for the SQL panel.

import mysql from 'mysql2/promise';
import pg from 'pg';
import { decrypt, type StoredConnection } from './storage.js';

export interface QueryResult {
  columns: string[];
  rows: (string | number | boolean | null)[][];
  rowCount: number;
  truncated: boolean;
  ms: number;
}

function plain(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return v.toString('base64');
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  // numeric strings from pg (NUMERIC/BIGINT come back as text)
  if (/^-?\d+(\.\d+)?$/.test(s) && s.length < 16) return Number(s);
  return s;
}

export async function runQuery(c: StoredConnection, sql: string, limit: number): Promise<QueryResult> {
  const password = c.passwordEnc ? decrypt(c.passwordEnc) : '';
  const t0 = Date.now();
  const max = Math.max(1, Math.min(limit, 50000));
  if (c.kind === 'postgres') {
    const client = new pg.Client({
      host: c.host,
      port: c.port,
      database: c.database,
      user: c.user,
      password,
      ssl: c.ssl ? { rejectUnauthorized: false } : undefined,
      statement_timeout: 30000,
      connectionTimeoutMillis: 10000,
    });
    await client.connect();
    try {
      const res = await client.query({ text: sql, rowMode: 'array' });
      const r = Array.isArray(res) ? res[res.length - 1] : res;
      const columns = (r.fields ?? []).map((f: { name: string }) => f.name);
      const all = (r.rows ?? []) as unknown[][];
      const rows = all.slice(0, max).map((row) => row.map(plain));
      return { columns, rows, rowCount: all.length, truncated: all.length > max, ms: Date.now() - t0 };
    } finally {
      await client.end();
    }
  }
  const conn = await mysql.createConnection({
    host: c.host,
    port: c.port,
    database: c.database,
    user: c.user,
    password,
    ssl: c.ssl ? { rejectUnauthorized: false } : undefined,
    connectTimeout: 10000,
    rowsAsArray: true,
  });
  try {
    const [rowsRaw, fields] = await conn.query({ sql, timeout: 30000 });
    const all = (Array.isArray(rowsRaw) ? rowsRaw : []) as unknown[][];
    const columns = ((fields as { name: string }[] | undefined) ?? []).map((f) => f.name);
    const rows = all.slice(0, max).map((row) => (Array.isArray(row) ? row.map(plain) : [plain(row)]));
    return { columns, rows, rowCount: all.length, truncated: all.length > max, ms: Date.now() - t0 };
  } finally {
    await conn.end();
  }
}

export async function testConnection(c: StoredConnection): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await runQuery(c, c.kind === 'postgres' ? 'SELECT version()' : 'SELECT VERSION()', 1);
    return { ok: true, message: String(r.rows[0]?.[0] ?? 'connected') };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

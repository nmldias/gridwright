// Database connections (PostgreSQL / MySQL / SQL Server) for the SQL panel and SQL cells.

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

export type Param = string | number | boolean | null;

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

/** Replace `?` placeholders (outside quotes/comments) using `make(index)`. */
export function rewritePlaceholders(sql: string, make: (i: number) => string): { text: string; count: number } {
  let out = '';
  let i = 0;
  let n = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i);
      const end = j < 0 ? sql.length : j;
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2);
      const end = j < 0 ? sql.length : j + 2;
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (c === '?') {
      out += make(n++);
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return { text: out, count: n };
}

export async function runQuery(c: StoredConnection, sql: string, limit: number, params: Param[] = []): Promise<QueryResult> {
  const password = c.passwordEnc ? decrypt(c.passwordEnc) : '';
  const t0 = Date.now();
  const max = Math.max(1, Math.min(limit, 50000));
  if (c.kind === 'postgres') {
    const { text } = rewritePlaceholders(sql, (i) => `$${i + 1}`);
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
      const res = await client.query({ text, values: params, rowMode: 'array' });
      const r = Array.isArray(res) ? res[res.length - 1] : res;
      const columns = (r.fields ?? []).map((f: { name: string }) => f.name);
      const all = (r.rows ?? []) as unknown[][];
      const rows = all.slice(0, max).map((row) => row.map(plain));
      return { columns, rows, rowCount: all.length, truncated: all.length > max, ms: Date.now() - t0 };
    } finally {
      await client.end();
    }
  }
  if (c.kind === 'mssql') {
    const mssql = (await import('mssql')).default;
    const pool = new mssql.ConnectionPool({
      server: c.host,
      port: c.port,
      database: c.database,
      user: c.user,
      password,
      connectionTimeout: 10000,
      requestTimeout: 30000,
      arrayRowMode: true,
      options: { encrypt: !!c.ssl, trustServerCertificate: true, enableArithAbort: true },
      pool: { max: 2, min: 0, idleTimeoutMillis: 5000 },
    });
    await pool.connect();
    try {
      const { text } = rewritePlaceholders(sql, (i) => `@p${i}`);
      const request = pool.request();
      params.forEach((p, i) => request.input(`p${i}`, p));
      const res = await request.query(text);
      const sets = res.recordsets as unknown as unknown[][][];
      const last = sets.length ? sets[sets.length - 1] : [];
      const colsMeta = (last as unknown as { columns?: { name: string }[] }).columns ?? [];
      const columns = Array.isArray(colsMeta) ? colsMeta.map((x) => x.name) : Object.keys(colsMeta);
      const all = last as unknown[][];
      const rows = all.slice(0, max).map((row) => (Array.isArray(row) ? row.map(plain) : [plain(row)]));
      return { columns, rows, rowCount: all.length, truncated: all.length > max, ms: Date.now() - t0 };
    } finally {
      await pool.close();
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
    const [rowsRaw, fields] = await conn.query({ sql, timeout: 30000, values: params });
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
    const probe = c.kind === 'postgres' ? 'SELECT version()' : c.kind === 'mssql' ? 'SELECT @@VERSION' : 'SELECT VERSION()';
    const r = await runQuery(c, probe, 1);
    return { ok: true, message: String(r.rows[0]?.[0] ?? 'connected').split('\n')[0] };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

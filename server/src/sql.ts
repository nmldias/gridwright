// Database connections (PostgreSQL / MySQL / SQL Server) for the SQL panel, SQL cells and the
// assistant's tools. Every query goes through `runQuery`, which bounds what reaches the server:
// rows are pulled through a cursor/stream and the query is cancelled once the limit is reached,
// statements time out, and read-only connections run inside read-only transactions where the
// database supports them (the text-level SELECT check lives in sqlpolicy.ts).

import mysql from 'mysql2';
import pg from 'pg';
import Cursor from 'pg-cursor';
import { decrypt, type StoredConnection } from './storage.js';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface QueryResult {
  columns: string[];
  rows: (string | number | boolean | null)[][];
  /** rows seen by the server (limit + 1 when truncated) */
  rowCount: number;
  truncated: boolean;
  ms: number;
}

export type Param = string | number | boolean | null;

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_ROWS = 5000;
export const HARD_MAX_ROWS = 50_000;

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

/** Effective per-connection limits. */
export function limitsOf(c: StoredConnection, requested?: number): { maxRows: number; timeoutMs: number } {
  const cap = Math.min(HARD_MAX_ROWS, Math.max(1, c.maxRows ?? DEFAULT_MAX_ROWS));
  const maxRows = Math.min(cap, Math.max(1, requested ?? cap));
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, c.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  return { maxRows, timeoutMs };
}

export async function runQuery(c: StoredConnection, sql: string, limit: number, params: Param[] = []): Promise<QueryResult> {
  const password = c.passwordEnc ? decrypt(c.passwordEnc) : '';
  const t0 = Date.now();
  const { maxRows: max, timeoutMs } = limitsOf(c, limit);
  const readOnly = c.readOnly !== false;
  if (c.kind === 'postgres') return runPostgres(c, password, sql, max, timeoutMs, readOnly, params, t0);
  if (c.kind === 'mssql') return runMssql(c, password, sql, max, timeoutMs, params, t0);
  return runMysql(c, password, sql, max, timeoutMs, readOnly, params, t0);
}

async function runPostgres(c: StoredConnection, password: string, sql: string, max: number, timeoutMs: number, readOnly: boolean, params: Param[], t0: number): Promise<QueryResult> {
  const { text } = rewritePlaceholders(sql, (i) => `$${i + 1}`);
  const client = new pg.Client({
    host: c.host,
    port: c.port,
    database: c.database,
    user: c.user,
    password,
    ssl: c.ssl ? { rejectUnauthorized: false } : undefined,
    statement_timeout: timeoutMs,
    connectionTimeoutMillis: 10000,
  });
  await client.connect();
  try {
    // a read-only transaction is enforced by the database itself, whatever the text says
    if (readOnly) await client.query('BEGIN READ ONLY');
    const cursor = client.query(new Cursor(text, params, { rowMode: 'array' } as never));
    const { rows, fields } = await new Promise<{ rows: unknown[][]; fields: { name: string }[] }>((resolve, reject) => {
      cursor.read(max + 1, (err: Error | undefined, rows: unknown[][], result?: { fields?: { name: string }[] }) => {
        if (err) reject(err);
        else resolve({ rows, fields: result?.fields ?? [] });
      });
    });
    await new Promise<void>((resolve) => cursor.close(() => resolve()));
    if (readOnly) await client.query('ROLLBACK').catch(() => undefined);
    const truncated = rows.length > max;
    return { columns: fields.map((f) => f.name), rows: rows.slice(0, max).map((row) => row.map(plain)), rowCount: rows.length, truncated, ms: Date.now() - t0 };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function runMssql(c: StoredConnection, password: string, sql: string, max: number, timeoutMs: number, params: Param[], t0: number): Promise<QueryResult> {
  const mssql = (await import('mssql')).default;
  const pool = new mssql.ConnectionPool({
    server: c.host,
    port: c.port,
    database: c.database,
    user: c.user,
    password,
    connectionTimeout: 10000,
    requestTimeout: timeoutMs,
    arrayRowMode: true,
    options: { encrypt: !!c.ssl, trustServerCertificate: true, enableArithAbort: true },
    pool: { max: 2, min: 0, idleTimeoutMillis: 5000 },
  });
  await pool.connect();
  try {
    const { text } = rewritePlaceholders(sql, (i) => `@p${i}`);
    const request = pool.request();
    request.stream = true;
    params.forEach((p, i) => request.input(`p${i}`, p));
    let columns: string[] = [];
    const rows: unknown[][] = [];
    let truncated = false;
    await new Promise<void>((resolve, reject) => {
      request.on('recordset', (cols: unknown) => {
        columns = Array.isArray(cols) ? (cols as { name: string }[]).map((x) => x.name) : Object.keys(cols as object);
        rows.length = 0; // only the last result set is returned
      });
      request.on('row', (row: unknown) => {
        if (rows.length < max) rows.push(Array.isArray(row) ? row : [row]);
        else if (!truncated) {
          truncated = true;
          request.cancel(); // stop the server from sending the rest
        }
      });
      request.on('error', (err: Error & { code?: string }) => {
        if (truncated && (err.code === 'ECANCEL' || /cancel/i.test(err.message))) return;
        reject(err);
      });
      request.on('done', () => resolve());
      request.query(text);
    });
    return { columns, rows: rows.map((row) => row.map(plain)), rowCount: rows.length + (truncated ? 1 : 0), truncated, ms: Date.now() - t0 };
  } finally {
    await pool.close().catch(() => undefined);
  }
}

async function runMysql(c: StoredConnection, password: string, sql: string, max: number, timeoutMs: number, readOnly: boolean, params: Param[], t0: number): Promise<QueryResult> {
  const raw = mysql.createConnection({
    host: c.host,
    port: c.port,
    database: c.database,
    user: c.user,
    password,
    ssl: c.ssl ? { rejectUnauthorized: false } : undefined,
    connectTimeout: 10000,
    rowsAsArray: true,
  });
  const conn = raw.promise();
  try {
    await conn.connect();
    // MySQL ≥ 5.7.8 (max_execution_time, ms) and MariaDB ≥ 10.1 (max_statement_time, s) spell the
    // statement timeout differently: one of the two must take, or the query does not run
    const timeouts = await Promise.allSettled([conn.query(`SET SESSION max_execution_time = ${Math.round(timeoutMs)}`), conn.query(`SET SESSION max_statement_time = ${Math.max(1, Math.round(timeoutMs / 1000))}`)]);
    if (!timeouts.some((t) => t.status === 'fulfilled')) {
      throw new Error(`could not set a statement timeout on this server (${timeouts.map((t) => (t.status === 'rejected' ? errorText(t.reason) : '')).filter(Boolean).join('; ')})`);
    }
    // the database-side guard is not optional: a read-only connection whose session cannot be made
    // read-only does not run the query at all
    if (readOnly) {
      try {
        // the session (every transaction, autocommit included) and the transaction we run in
        await conn.query('SET SESSION TRANSACTION READ ONLY');
        await conn.query('START TRANSACTION READ ONLY');
      } catch (e) {
        throw new Error(`could not make the session read-only, query refused: ${errorText(e)}`);
      }
    }
    let columns: string[] = [];
    const rows: unknown[][] = [];
    let truncated = false;
    await new Promise<void>((resolve, reject) => {
      const q = raw.query({ sql, values: params, rowsAsArray: true });
      const stream = q.stream();
      q.on('fields', (fields: unknown) => {
        // a statement without a result set (DDL, INSERT on a read-write connection) reports no fields
        if (!fields || !Array.isArray(fields) || !fields.length) return;
        const f = fields as { name: string }[] | { name: string }[][];
        const list = (Array.isArray(f[0]) ? (f as { name: string }[][])[f.length - 1] : (f as { name: string }[])) ?? [];
        columns = list.map((x) => x.name);
      });
      stream.on('data', (row: unknown) => {
        if (!Array.isArray(row) && !columns.length) return; // an OK packet, not a row
        if (rows.length < max) rows.push(Array.isArray(row) ? row : [row]);
        else if (!truncated) {
          truncated = true;
          stream.destroy(); // the rest never leaves the server
          resolve();
        }
      });
      stream.on('error', (err: Error) => (truncated ? resolve() : reject(err)));
      stream.on('end', () => resolve());
      stream.on('close', () => resolve());
    });
    if (readOnly && !truncated) await conn.query('ROLLBACK').catch(() => undefined);
    return { columns, rows: rows.map((row) => row.map(plain)), rowCount: rows.length + (truncated ? 1 : 0), truncated, ms: Date.now() - t0 };
  } finally {
    // a destroyed stream leaves the connection mid-result: drop it rather than reuse it
    raw.destroy();
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

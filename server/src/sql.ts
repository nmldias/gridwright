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

/** The coarse kind of a result column, from the driver's column metadata — the data contract a value is converted under. */
export type ColumnKind = 'number' | 'text' | 'date' | 'datetime' | 'boolean' | 'json' | 'binary' | 'unknown';

export interface QueryResult {
  columns: string[];
  /** the declared kind of each column: a VARCHAR of digits stays text, a NUMERIC becomes a number — never guessed from the value's look */
  kinds: ColumnKind[];
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

// PostgreSQL type OIDs → kinds (pg reports the OID of every result column, expressions included)
const PG_KINDS: Record<number, ColumnKind> = { 16: 'boolean', 17: 'binary', 20: 'number', 21: 'number', 23: 'number', 25: 'text', 26: 'number', 114: 'json', 700: 'number', 701: 'number', 790: 'number', 1042: 'text', 1043: 'text', 1082: 'date', 1083: 'text', 1114: 'datetime', 1184: 'datetime', 1186: 'text', 1700: 'number', 2950: 'text', 3802: 'json' };
// MySQL / MariaDB column type codes → kinds
const MYSQL_KINDS: Record<number, ColumnKind> = { 0: 'number', 1: 'number', 2: 'number', 3: 'number', 4: 'number', 5: 'number', 6: 'unknown', 7: 'datetime', 8: 'number', 9: 'number', 10: 'date', 11: 'text', 12: 'datetime', 13: 'number', 14: 'date', 15: 'text', 16: 'binary', 245: 'json', 246: 'number', 247: 'text', 248: 'text', 249: 'binary', 250: 'binary', 251: 'binary', 252: 'binary', 253: 'text', 254: 'text', 255: 'binary' };
const MYSQL_BINARY_FLAG = 128;
function mysqlKind(f: { columnType?: number; type?: number; flags?: number | string[]; charsetNr?: number; characterSet?: number }): ColumnKind {
  const code = f.columnType ?? f.type;
  const k = code === undefined ? 'unknown' : (MYSQL_KINDS[code] ?? 'unknown');
  // a *_BLOB with a text character set is text (TEXT columns report as BLOB); binary ones carry the flag or the binary charset (63)
  if (k === 'binary' && code !== undefined && code >= 249 && code <= 252) {
    const charset = f.charsetNr ?? f.characterSet;
    const binary = (typeof f.flags === 'number' && (f.flags & MYSQL_BINARY_FLAG) !== 0) || charset === 63;
    return binary ? 'binary' : 'text';
  }
  return k;
}
// SQL Server: the mssql driver names each column's type (sql.VarChar → declaration 'varchar')
function mssqlKind(t: unknown): ColumnKind {
  const name = String((t as { declaration?: string; name?: string } | undefined)?.declaration ?? (t as { name?: string } | undefined)?.name ?? '').toLowerCase();
  if (!name) return 'unknown';
  if (/^(bit)$/.test(name)) return 'boolean';
  if (/^(tinyint|smallint|int|bigint|decimal|numeric|float|real|money|smallmoney)$/.test(name)) return 'number';
  if (/^date$/.test(name)) return 'date';
  if (/^(datetime|datetime2|smalldatetime|datetimeoffset)$/.test(name)) return 'datetime';
  if (/^(binary|varbinary|image)$/.test(name)) return 'binary';
  return 'text';
}

const pad = (n: number) => String(n).padStart(2, '0');
/** A date-typed value as the calendar day it names (no time zone shift), a datetime as ISO. */
function dateText(v: unknown, kind: ColumnKind): string {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    return kind === 'date' ? `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}` : v.toISOString();
  }
  return String(v);
}

/**
 * A driver value under its column's declared kind. Numbers come only from numeric columns (a
 * NUMERIC or BIGINT that pg returns as text is parsed; a value with 16 or more digits is kept as
 * text so that no digit is lost); a text column stays text whatever its values look like —
 * an identifier such as 000123 keeps its zeros; dates are the day they name.
 */
export function plain(v: unknown, kind: ColumnKind = 'unknown'): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (kind === 'date' || kind === 'datetime') return dateText(v, kind);
  if (typeof v === 'boolean') return v;
  if (kind === 'boolean') return typeof v === 'number' ? v !== 0 : /^(1|t|true|yes)$/i.test(String(v));
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return v <= Number.MAX_SAFE_INTEGER && v >= Number.MIN_SAFE_INTEGER ? Number(v) : v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return v.toString('base64');
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  if (kind === 'number' && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s) && s.replace(/[-.]/g, '').length < 16) return Number(s);
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
    const { rows, fields } = await new Promise<{ rows: unknown[][]; fields: { name: string; dataTypeID?: number }[] }>((resolve, reject) => {
      cursor.read(max + 1, (err: Error | undefined, rows: unknown[][], result?: { fields?: { name: string; dataTypeID?: number }[] }) => {
        if (err) reject(err);
        else resolve({ rows, fields: result?.fields ?? [] });
      });
    });
    await new Promise<void>((resolve) => cursor.close(() => resolve()));
    if (readOnly) await client.query('ROLLBACK').catch(() => undefined);
    const truncated = rows.length > max;
    const kinds = fields.map((f) => (f.dataTypeID === undefined ? 'unknown' : (PG_KINDS[f.dataTypeID] ?? 'unknown')));
    return { columns: fields.map((f) => f.name), kinds, rows: rows.slice(0, max).map((row) => row.map((v, i) => plain(v, kinds[i]))), rowCount: rows.length, truncated, ms: Date.now() - t0 };
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
    let kinds: ColumnKind[] = [];
    const rows: unknown[][] = [];
    let truncated = false;
    await new Promise<void>((resolve, reject) => {
      request.on('recordset', (cols: unknown) => {
        const list = Array.isArray(cols) ? (cols as { name: string; type?: unknown }[]) : Object.values(cols as Record<string, { name: string; type?: unknown }>);
        columns = list.map((x) => x.name);
        kinds = list.map((x) => mssqlKind(x.type));
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
    return { columns, kinds, rows: rows.map((row) => row.map((v, i) => plain(v, kinds[i]))), rowCount: rows.length + (truncated ? 1 : 0), truncated, ms: Date.now() - t0 };
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
    let kinds: ColumnKind[] = [];
    const rows: unknown[][] = [];
    let truncated = false;
    await new Promise<void>((resolve, reject) => {
      const q = raw.query({ sql, values: params, rowsAsArray: true });
      const stream = q.stream();
      q.on('fields', (fields: unknown) => {
        // a statement without a result set (DDL, INSERT on a read-write connection) reports no fields
        if (!fields || !Array.isArray(fields) || !fields.length) return;
        type F = { name: string; columnType?: number; type?: number; flags?: number | string[]; charsetNr?: number; characterSet?: number };
        const f = fields as F[] | F[][];
        const list = (Array.isArray(f[0]) ? (f as F[][])[f.length - 1] : (f as F[])) ?? [];
        columns = list.map((x) => x.name);
        kinds = list.map(mysqlKind);
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
    return { columns, kinds, rows: rows.map((row) => row.map((v, i) => plain(v, kinds[i]))), rowCount: rows.length + (truncated ? 1 : 0), truncated, ms: Date.now() - t0 };
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

// Server-side tools the AI assistant may call (OpenAI function-calling format).
// Everything here is read-only: SELECT queries capped at 200 rows, schema lookups, the audit log.

import { describeOp, recentEntries } from './history.js';
import { runQuery, type QueryResult } from './sql.js';
import { listConnections } from './storage.js';

export const MAX_TOOL_ROWS = 200;

export interface ToolContext {
  fileId?: string;
}

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'list_connections',
      description: 'List the database connections configured on this Gridwright server (id, name, kind, database).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tables',
      description: 'List tables and views visible on a database connection.',
      parameters: {
        type: 'object',
        properties: { connection: { type: 'string', description: 'connection id from list_connections' } },
        required: ['connection'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'describe_table',
      description: 'Columns and data types of a database table.',
      parameters: {
        type: 'object',
        properties: {
          connection: { type: 'string' },
          table: { type: 'string', description: 'table name (optionally schema.table)' },
        },
        required: ['connection', 'table'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_sql',
      description: `Run a read-only SELECT on a connection and get up to ${MAX_TOOL_ROWS} rows. Use it to look at real data before proposing formulas or SQL cells. Only SELECT/WITH statements are allowed.`,
      parameters: {
        type: 'object',
        properties: {
          connection: { type: 'string' },
          sql: { type: 'string' },
        },
        required: ['connection', 'sql'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_history',
      description: 'Recent changes to the open document from its audit log: who changed what and when.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: 'number of entries (default 50, max 200)' } },
      },
    },
  },
];

/** True when the statement is a single read-only SELECT (comments and string literals ignored). */
export function isReadOnlySql(sql: string): { ok: boolean; reason?: string } {
  let bare = '';
  let i = 0;
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
      bare += ' ';
      i = j + 1;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i);
      i = j < 0 ? sql.length : j;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2);
      i = j < 0 ? sql.length : j + 2;
      continue;
    }
    bare += c;
    i++;
  }
  const text = bare.trim().replace(/;\s*$/, '');
  if (!text) return { ok: false, reason: 'empty statement' };
  if (text.includes(';')) return { ok: false, reason: 'one statement at a time' };
  const first = (text.match(/^[a-zA-Z]+/) ?? [''])[0].toUpperCase();
  if (first !== 'SELECT' && first !== 'WITH') return { ok: false, reason: 'only SELECT statements are allowed' };
  const banned = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE|MERGE|CALL|INTO|COPY|VACUUM|LOCK|SET|USE)\b/i;
  const m = text.match(banned);
  if (m) return { ok: false, reason: `${m[1].toUpperCase()} is not allowed in assistant queries` };
  return { ok: true };
}

function resultForModel(r: QueryResult): Record<string, unknown> {
  return { columns: r.columns, rows: r.rows.slice(0, MAX_TOOL_ROWS), rowCount: r.rowCount, truncated: r.truncated || r.rowCount > MAX_TOOL_ROWS, ms: r.ms };
}

/** Execute a tool; the result is what goes back to the model (always JSON-serialisable). */
export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<{ result: unknown; summary: string }> {
  const conn = (id: unknown) => {
    const c = listConnections().find((x) => x.id === String(id ?? ''));
    if (!c) throw new Error(`no connection with id ${String(id ?? '')} — call list_connections first`);
    return c;
  };
  switch (name) {
    case 'list_connections': {
      const list = listConnections().map((c) => ({ id: c.id, name: c.name, kind: c.kind, database: c.database, host: c.host }));
      return { result: list, summary: `${list.length} connection(s)` };
    }
    case 'list_tables': {
      const c = conn(args.connection);
      const sql =
        c.kind === 'postgres'
          ? "SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1, 2"
          : c.kind === 'mysql'
            ? 'SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY 1, 2'
            : "SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ('sys','INFORMATION_SCHEMA') ORDER BY 1, 2";
      const r = await runQuery(c, sql, 500);
      return { result: resultForModel(r), summary: `${r.rowCount} table(s) on ${c.name}` };
    }
    case 'describe_table': {
      const c = conn(args.connection);
      const full = String(args.table ?? '').trim();
      if (!full) throw new Error('table required');
      const parts = full.split('.');
      const table = parts.pop()!.replace(/^[\[`"]|[\]`"]$/g, '');
      const schema = parts.length ? parts.pop()!.replace(/^[\[`"]|[\]`"]$/g, '') : '';
      const sql = schema
        ? 'SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = ? AND table_schema = ? ORDER BY ordinal_position'
        : 'SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = ? ORDER BY ordinal_position';
      const r = await runQuery(c, sql, 500, schema ? [table, schema] : [table]);
      return { result: resultForModel(r), summary: `${r.rowCount} column(s) in ${full}` };
    }
    case 'run_sql': {
      const c = conn(args.connection);
      const sql = String(args.sql ?? '');
      const check = isReadOnlySql(sql);
      if (!check.ok) throw new Error(check.reason);
      const r = await runQuery(c, sql, MAX_TOOL_ROWS);
      return { result: resultForModel(r), summary: `${r.rowCount} row(s)${r.rowCount > MAX_TOOL_ROWS ? ` (first ${MAX_TOOL_ROWS} shown)` : ''} in ${r.ms} ms` };
    }
    case 'read_history': {
      if (!ctx.fileId) throw new Error('the document is not saved yet, so it has no history');
      const limit = Math.min(200, Math.max(1, Number(args.limit ?? 50) || 50));
      const entries = recentEntries(ctx.fileId, limit).map((e) => {
        const d = e.op ? describeOp(e.op) : { range: '', detail: '' };
        return { seq: e.seq, at: e.ts, by: e.author?.name, login: e.author?.login, origin: e.origin, type: e.op?.type ?? (e.checkpoint ? 'checkpoint' : ''), table: e.op?.table, range: d.range, detail: d.detail, note: e.note };
      });
      return { result: entries, summary: `${entries.length} entries` };
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

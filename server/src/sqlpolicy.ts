// The one place that decides whether a caller may run a statement on a connection, used by the
// SQL panel, SQL cells and the assistant's tools alike. Policy per connection: read-only (a single
// SELECT, read the way that database reads it, and enforced again by the database itself: a read-only
// transaction on Postgres and MySQL, a transaction that is always rolled back on SQL Server), an
// allow-list of logins (admins always pass), and row / time limits applied by the driver.

import type { Identity } from './identity.js';
import { identityEnabled } from './identity.js';
import { connectionTenant, type StoredConnection } from './storage.js';
import { ACCOUNTS } from './tenancy.js';

export class SqlRefused extends Error {
  status: number;
  constructor(message: string, status = 403) {
    super(message);
    this.status = status;
  }
}

export type SqlDialect = 'postgres' | 'mysql' | 'mssql';

/** Characters that continue an identifier (so `a$b` or `x$$` is not the start of a dollar quote). */
const WORDCHAR = /[A-Za-z0-9_$\u0080-\uffff]/;

// Statements (and statement words) a read-only query never needs. SQL Server runs statements one after
// another without a ';', so a word that starts a statement is refused wherever it appears. Words that
// are also ordinary column names in finance data (open, close, start, comment, replace) or part of a
// SELECT (FETCH NEXT, CASE … END, MySQL's IF()) are not on the list; none of them writes on its own.
const BANNED_WORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE', 'DENY', 'EXEC', 'EXECUTE', 'MERGE', 'CALL',
  'INTO', 'COPY', 'VACUUM', 'LOCK', 'SET', 'USE', 'BULK', 'WAITFOR', 'SHUTDOWN', 'RECONFIGURE', 'OPENROWSET', 'OPENQUERY', 'OPENDATASOURCE',
  'BACKUP', 'RESTORE', 'KILL', 'DBCC', 'CHECKPOINT', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'TRAN', 'TRANSACTION',
  'DECLARE', 'WHILE', 'RAISERROR', 'THROW', 'SETUSER', 'REVERT', 'DISABLE', 'ENABLE', 'WRITETEXT', 'UPDATETEXT', 'LOAD', 'HANDLER',
  'PREPARE', 'DEALLOCATE', 'FLUSH', 'RESET', 'PURGE', 'INSTALL', 'UNINSTALL', 'IMPORT', 'OPTIMIZE', 'REINDEX', 'CLUSTER', 'DISCARD',
  'LISTEN', 'NOTIFY', 'UNLISTEN', 'REFRESH', 'ADD', 'SEND', 'RECEIVE', 'MOVE', 'CONVERSATION', 'OUTFILE', 'DUMPFILE',
];
// Functions with effects outside the query: other connections (dblink opens one that is not read-only),
// server files, sessions, replication, large objects, configuration, sleeping.
const BANNED_FUNCTIONS = [
  'dblink\\w*', 'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf', 'pg_rotate_logfile', 'pg_promote', 'pg_switch_wal',
  'pg_create_\\w+', 'pg_drop_\\w+', 'pg_replication_\\w+', 'pg_logical_\\w+', 'lo_\\w+', 'pg_read_file', 'pg_read_binary_file', 'pg_ls_\\w+',
  'pg_stat_reset\\w*', 'pg_file_\\w+', 'set_config', 'pg_notify', 'pg_sleep\\w*', 'sys_exec', 'sys_eval', 'load_file',
  '(?:xp|sp|dm)_\\w+',
];
const BANNED = new RegExp(`\\b(${BANNED_WORDS.join('|')})\\b|\\b(${BANNED_FUNCTIONS.join('|')})\\b`, 'i');

type Lexed = { ok: true; code: string } | { ok: false; reason: string };

/**
 * The statement with every comment removed and every quoted string / quoted identifier replaced by a
 * space, read the way `dialect` reads it. The lexer has to agree with the database exactly: where it
 * thought code was a string, a statement could hide inside it. Without a dialect, every construct that
 * databases read differently (backslashes in quotes, dollar quotes, "#", "--x", MySQL executable comments, nested comments) is refused.
 */
function lex(sql: string, dialect?: SqlDialect): Lexed {
  const strict = !dialect;
  const pg = dialect === 'postgres';
  const my = dialect === 'mysql';
  const ms = dialect === 'mssql';
  const n = sql.length;
  let code = '';
  let i = 0;
  const no = (reason: string): Lexed => ({ ok: false, reason });
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    // quoted strings and identifiers
    if (c === "'" || c === '"' || c === '`' || (c === '[' && ms)) {
      const close = c === '[' ? ']' : c;
      // backslash escapes: MySQL '…' and "…" (the session's sql_mode is set so this holds), Postgres E'…'
      const eString = pg && c === "'" && i > 0 && (sql[i - 1] === 'e' || sql[i - 1] === 'E') && !(i > 1 && WORDCHAR.test(sql[i - 2]));
      const backslash = (my && (c === "'" || c === '"')) || eString;
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const x = sql[j];
        if (x === '\\') {
          if (backslash) {
            j += 2;
            continue;
          }
          if (strict && close !== ']') return no('a backslash inside quotes is read differently by different databases — not allowed when the database is not known');
        }
        if (x === close) {
          if (sql[j + 1] === close) {
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) return no('a quote is not closed');
      code += ' ';
      i = j + 1;
      continue;
    }
    // Postgres dollar quoting: $$…$$ or $tag$…$tag$ (but not $1, nor a $ inside an identifier)
    if (c === '$' && (pg || strict) && !(i > 0 && WORDCHAR.test(sql[i - 1]))) {
      const m = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/.exec(sql.slice(i, i + 80));
      if (m) {
        if (strict) return no('dollar quoting ($$) is only understood by Postgres — not allowed when the database is not known');
        const end = sql.indexOf(m[0], i + m[0].length);
        if (end < 0) return no('a dollar-quoted string is not closed');
        code += ' ';
        i = end + m[0].length;
        continue;
      }
    }
    // line comments: "--" (MySQL: only when followed by a space or control character), "#" (MySQL)
    const dashComment = c === '-' && d === '-';
    if (dashComment || (c === '#' && (my || strict))) {
      if (c === '#' && strict) return no('"#" starts a comment in MySQL only — not allowed when the database is not known');
      if (dashComment && (my || strict)) {
        const after = sql[i + 2];
        const isComment = after === undefined || /[\s\x00-\x1f]/.test(after);
        if (!isComment) {
          if (strict) return no('"--" followed directly by text is a comment in some databases and two minus signs in others');
          code += c; // MySQL: 1--1 is arithmetic
          i++;
          continue;
        }
      }
      let j = sql.indexOf('\n', i);
      if (j < 0) j = n;
      // a carriage return alone ends the comment for Postgres but not for MySQL
      const cr = sql.slice(i, j).search(/\r(?!\n)/);
      if (cr >= 0 && (pg || strict || ms)) {
        if (!pg) return no('a carriage return inside a comment is read differently by different databases');
        j = i + cr;
      }
      code += ' ';
      i = j;
      continue;
    }
    // block comments: nested in Postgres and SQL Server, not in MySQL; /*! … */ is executed by MySQL
    if (c === '/' && d === '*') {
      if ((my || strict) && (sql[i + 2] === '!' || (sql[i + 2] === 'M' && sql[i + 3] === '!'))) return no('MySQL executable comments (/*! … */) are not allowed on a read-only connection');
      let j = i + 2;
      if (pg || ms) {
        let depth = 1;
        while (j < n && depth > 0) {
          if (sql[j] === '/' && sql[j + 1] === '*') {
            depth++;
            j += 2;
          } else if (sql[j] === '*' && sql[j + 1] === '/') {
            depth--;
            j += 2;
          } else j++;
        }
        if (depth > 0) return no('a comment is not closed');
      } else {
        const end = sql.indexOf('*/', j);
        if (end < 0) return no('a comment is not closed');
        if (strict && sql.slice(j, end).includes('/*')) return no('nested comments are read differently by different databases — not allowed when the database is not known');
        j = end + 2;
      }
      code += ' ';
      i = j;
      continue;
    }
    code += c;
    i++;
  }
  return { ok: true, code };
}

/**
 * True when the statement is a single read-only SELECT, read the way `dialect` reads it (comments and
 * quoted text ignored). One layer of two: the database enforces read-only as well (see sql.ts).
 */
export function isReadOnlySql(sql: string, dialect?: SqlDialect): { ok: boolean; reason?: string } {
  const lexed = lex(sql, dialect);
  if (!lexed.ok) return { ok: false, reason: lexed.reason };
  // a leading ';' (T-SQL's ';WITH …') and trailing ones are not statements
  const text = lexed.code.trim().replace(/^(?:;\s*)+/, '').replace(/(?:;\s*)+$/, '');
  if (!text) return { ok: false, reason: 'empty statement' };
  if (text.includes(';')) return { ok: false, reason: 'one statement at a time' };
  const first = (text.match(/^[a-zA-Z]+/) ?? [''])[0].toUpperCase();
  if (first !== 'SELECT' && first !== 'WITH') return { ok: false, reason: 'only SELECT statements are allowed on a read-only connection' };
  const m = text.match(BANNED);
  if (m) {
    const word = (m[1] ?? m[2]).toUpperCase();
    const hint = m[1] ? ` (a column with that name can be quoted: ${dialect === 'mysql' ? '`name`' : dialect === 'mssql' ? '[name]' : '"name"'})` : '';
    return { ok: false, reason: `${word} is not allowed on a read-only connection${hint}` };
  }
  return { ok: true };
}

/** The dialect a stored connection speaks. */
export function dialectOf(conn: Pick<StoredConnection, 'kind'>): SqlDialect {
  return conn.kind === 'postgres' ? 'postgres' : conn.kind === 'mssql' ? 'mssql' : 'mysql';
}

/** Throws `SqlRefused` unless `who` may run `sql` on `conn`. */
export function authorizeQuery(conn: StoredConnection, who: Identity, sql: string): void {
  // another client's connection does not exist for this caller
  if (!sameClient(conn, who)) throw new SqlRefused('no such connection', 404);
  if (who.role === 'viewer') throw new SqlRefused('read-only access: viewers cannot run queries');
  const allowed = (conn.allowed ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && who.role !== 'admin') {
    if (!identityEnabled) throw new SqlRefused(`connection "${conn.name}" is restricted to named logins, and this server cannot identify you (identity is off)`);
    if (!allowed.includes(who.login.toLowerCase())) throw new SqlRefused(`connection "${conn.name}" is not shared with ${who.login || 'you'}`);
  }
  if (conn.readOnly !== false) {
    const check = isReadOnlySql(sql, dialectOf(conn));
    if (!check.ok) throw new SqlRefused(check.reason ?? 'not allowed', 400);
  }
}

/** Can `who` see this connection in lists at all? */
export function canSeeConnection(conn: StoredConnection, who: Identity): boolean {
  if (!sameClient(conn, who)) return false;
  const allowed = (conn.allowed ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length || who.role === 'admin') return true;
  return identityEnabled && allowed.includes(who.login.toLowerCase());
}

/** Accounts mode: a connection belongs to one client, and only that client's members reach it. */
export function sameClient(conn: StoredConnection, who: Identity): boolean {
  if (!ACCOUNTS) return true;
  return !!who.tenant && connectionTenant(conn) === who.tenant;
}

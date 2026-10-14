// Read-only SQL connections cannot write (review 11 Oct 2026, finding 1.5).
//
//   node e2e/sql_readonly.mjs [server/dist] [--pg host:port:db:user:pass] [--mysql host:port:db:user:pass [--mysql-root pass]]
//                                           [--mssql host:port:db:user:pass]
//
// Part 1 (always): the policy reads each statement the way that database reads it — a statement the
// lexer took for a string, a comment or arithmetic cannot carry a write past it.
// Part 2 (per database given): the database enforces read-only by itself. runQuery is called directly,
// skipping the text policy, with statements that write; a canary table must be unchanged afterwards.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const DIST = resolve(args[0] && !args[0].startsWith('--') ? args[0] : join(import.meta.dirname, '..', 'server', 'dist'));
// a private data directory for the server key the connection passwords are encrypted with
const DATA = mkdtempSync(join(tmpdir(), 'gw-sqlro-'));
process.env.GRIDWRIGHT_DATA = DATA;
const policy = await import(pathToFileURL(join(DIST, 'sqlpolicy.js')).href);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ---------------------------------------------------------------------------------------------- part 1
const ALL = ['postgres', 'mysql', 'mssql', undefined];
const cases = [
  // [dialects, sql, allowed?, what it shows]
  [ALL, 'SELECT 1', true, 'a plain SELECT'],
  [ALL, 'SELECT region, SUM(amount) FROM orders GROUP BY region;', true, 'a trailing semicolon'],
  [ALL, 'WITH a AS (SELECT 1 AS x) SELECT x FROM a', true, 'a CTE'],
  [ALL, "SELECT 'DELETE FROM t; DROP TABLE t' AS s", true, 'banned words inside a string'],
  [ALL, 'SELECT CASE WHEN a > 0 THEN 1 ELSE 0 END, open, close, start, comment, begin_date FROM prices', true, 'CASE … END and finance column names'],
  [ALL, "SELECT REPLACE(name, 'a', 'b') FROM t", true, 'the REPLACE() function'],
  [['postgres', 'mssql'], 'SELECT a FROM t ORDER BY a OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY', true, 'FETCH NEXT paging'],
  [['postgres'], "SELECT $$it's$$, $tag$a 'quoted' b$tag$", true, 'Postgres dollar quotes'],
  [['postgres'], "SELECT E'it\\'s'", true, "Postgres E'' escapes"],
  [['postgres'], 'SELECT x /* a /* nested */ still a comment */ FROM t', true, 'Postgres nested comments'],
  [['postgres'], 'SELECT a[1], 2 # 3, $1::int FROM t', true, 'arrays, # (XOR) and $1 in Postgres'],
  [['mysql'], "SELECT 'it\\'s', \"say \\\"hi\\\"\"", true, 'MySQL backslash escapes'],
  [['mysql'], 'SELECT 1--1, 2 # a comment', true, 'MySQL: --1 is arithmetic, # a comment'],
  [['mysql'], "SELECT IF(a > 1, 'x', 'y') FROM t", true, "MySQL's IF()"],
  [['mssql'], ';WITH a AS (SELECT 1 AS x) SELECT x FROM a', true, "T-SQL's ;WITH"],
  [['mssql'], "SELECT [delete], N'it''s' FROM t", true, 'bracketed identifiers and N strings'],
  [[undefined], "SELECT a FROM t WHERE b = 'x' -- a comment", true, 'unknown database: ordinary SQL'],

  [ALL, 'DELETE FROM t', false, 'a DELETE'],
  [ALL, 'SELECT 1; SELECT 2', false, 'two statements'],
  [ALL, 'SELECT * INTO copy FROM t', false, 'SELECT … INTO'],
  [ALL, "SELECT 'not closed", false, 'an unclosed quote'],
  [ALL, 'SELECT 1 /* not closed', false, 'an unclosed comment'],
  [ALL, 'SELECT a FROM t FOR UPDATE', false, 'row locks'],
  // Postgres: what the old lexer took for strings or comments
  [['postgres'], "SELECT $$'$$; COMMIT; DELETE FROM t; --'", false, 'dollar quote hiding COMMIT; DELETE'],
  [['postgres'], "SELECT $$'$$, dblink_exec('dbname=demo', 'DROP TABLE t') --'", false, 'dollar quote hiding dblink_exec'],
  [['postgres'], "SELECT E'\\'', pg_terminate_backend(1) --'", false, "E'' escape hiding pg_terminate_backend"],
  [['postgres'], "SELECT 1 /* /* */ ' */, dblink_exec('x', 'DROP TABLE t') --'", false, 'nested comment hiding dblink_exec'],
  [['postgres'], "SELECT set_config('transaction_read_only', 'off', false)", false, 'set_config'],
  [['postgres'], "SELECT lo_export(1, '/tmp/x'), pg_read_file('/etc/passwd')", false, 'server files'],
  // MySQL
  [['mysql'], "SELECT 'a\\'', sys_exec('id') -- '", false, "\\' escape hiding sys_exec"],
  [['mysql'], "SELECT 1 # '\n, LOAD_FILE('/etc/passwd') -- '", false, '# comment hiding LOAD_FILE'],
  [['mysql'], 'SELECT 1--1; DELETE FROM t', false, '--1 is not a comment in MySQL'],
  [['mysql'], 'SELECT 1 /*! , SLEEP(5) */', false, 'an executable comment'],
  [['mysql'], 'SELECT 1 /*M! , SLEEP(5) */', false, 'a MariaDB executable comment'],
  // SQL Server: statements follow each other without a ';'
  [['mssql'], "SELECT 1 BACKUP DATABASE master TO DISK = '/tmp/x.bak'", false, 'SELECT … BACKUP'],
  [['mssql'], "SELECT 1 RESTORE DATABASE x FROM DISK = '/tmp/x.bak'", false, 'SELECT … RESTORE'],
  [['mssql'], 'SELECT 1 KILL 51', false, 'SELECT … KILL'],
  [['mssql'], 'SELECT 1 DBCC FREEPROCCACHE', false, 'SELECT … DBCC'],
  [['mssql'], 'SELECT 1 COMMIT SELECT 2', false, 'SELECT … COMMIT'],
  [['mssql'], "SELECT 1 DECLARE @s NVARCHAR(40) = N'x' SELECT @s", false, 'SELECT … DECLARE'],
  [['mssql'], 'SELECT 1 CHECKPOINT', false, 'SELECT … CHECKPOINT'],
  [['mssql'], 'SELECT 1 DENY SELECT ON t TO public', false, 'SELECT … DENY'],
  [['mssql'], 'SELECT 1 WHILE 1 = 1 SELECT 2', false, 'SELECT … WHILE'],
  [['mssql'], 'SELECT 1 -- x\r, 2', false, 'a lone carriage return in a comment'],
  // unknown database: constructs read differently by different databases are refused
  [[undefined], "SELECT 'a\\'b'", false, 'unknown database: a backslash in quotes'],
  [[undefined], 'SELECT $$x$$', false, 'unknown database: dollar quotes'],
  [[undefined], 'SELECT 1 # x', false, 'unknown database: #'],
  [[undefined], 'SELECT 1--1', false, 'unknown database: --1'],
  [[undefined], 'SELECT 1 /*! x */', false, 'unknown database: an executable comment'],
  [[undefined], 'SELECT 1 /* a /* b */ c */', false, 'unknown database: nested comments'],
];
let p1 = 0;
let p1fail = [];
for (const [dialects, sql, allowed, what] of cases) {
  for (const d of dialects) {
    const r = policy.isReadOnlySql(sql, d);
    p1++;
    if (r.ok !== allowed) p1fail.push(`${d ?? 'unknown'}: ${what} — expected ${allowed ? 'allowed' : 'refused'}, got ${r.ok ? 'allowed' : `refused (${r.reason})`}`);
  }
}
check(`1. the policy reads ${p1} statement/database pairs the way each database does`, p1fail.length === 0, p1fail.length ? `${p1fail.length} wrong:\n     ${p1fail.join('\n     ')}` : '');
{
  const r = policy.isReadOnlySql('SELECT release FROM versions', 'postgres');
  check('1b. a refused column name comes with a hint to quote it', !r.ok && /quoted: "name"/.test(r.reason ?? ''), r.reason);
}
if (typeof policy.authorizeQuery === 'function') {
  const conn = { id: 'x', name: 'x', kind: 'mysql', readOnly: true };
  let refused = '';
  try {
    policy.authorizeQuery(conn, { login: 'a', name: 'a', role: 'admin' }, "SELECT 'a\\'', sys_exec('id') -- '");
  } catch (e) {
    refused = e.message;
  }
  check("1c. authorizeQuery reads a connection's statements in its own dialect", /SYS_EXEC/.test(refused), refused || 'allowed');
}

// ---------------------------------------------------------------------------------------------- part 2
const dbs = [
  ['postgres', opt('--pg')],
  ['mysql', opt('--mysql')],
  ['mssql', opt('--mssql')],
].filter(([, spec]) => spec);
if (dbs.length) {
  const { runQuery } = await import(pathToFileURL(join(DIST, 'sql.js')).href);
  const { encrypt } = await import(pathToFileURL(join(DIST, 'storage.js')).href);
  const connOf = (kind, spec, readOnly) => {
    const [host, port, database, user, ...pw] = spec.split(':');
    return { id: `t-${kind}`, name: `t-${kind}`, kind, host, port: Number(port), database, user, passwordEnc: encrypt(pw.join(':')), ssl: false, readOnly, maxRows: 1000, timeoutMs: 15000 };
  };
  const err = async (p) => {
    try {
      await p;
      return '';
    } catch (e) {
      return String(e.message ?? e).slice(0, 160) || 'error';
    }
  };
  for (const [kind, spec] of dbs) {
    const rw = connOf(kind, spec, false);
    const ro = connOf(kind, spec, true);
    const T = 'gw_canary';
    const drop = kind === 'mssql' ? `IF OBJECT_ID('${T}') IS NOT NULL DROP TABLE ${T}` : `DROP TABLE IF EXISTS ${T}`;
    try {
      await runQuery(rw, drop, 10);
      await runQuery(rw, `CREATE TABLE ${T} (n INT)`, 10);
      await runQuery(rw, `INSERT INTO ${T} (n) VALUES (1)`, 10);
    } catch (e) {
      check(`2.${kind} set up the canary table`, false, e.message);
      continue;
    }
    const canary = async () => {
      try {
        const r = await runQuery(rw, `SELECT n FROM ${T}`, 10);
        return JSON.stringify(r.rows);
      } catch (e) {
        return `gone (${String(e.message).slice(0, 80)})`;
      }
    };
    const writes = [`DELETE FROM ${T}`, `INSERT INTO ${T} (n) VALUES (2)`, `UPDATE ${T} SET n = 3`, `DROP TABLE ${T}`, `CREATE TABLE gw_planted (n INT)`];
    if (kind === 'postgres') writes.push(`SELECT 1; COMMIT; DELETE FROM ${T}`);
    if (kind === 'mysql') writes.push(`SELECT 1; DELETE FROM ${T}`);
    if (kind === 'mssql') writes.push(`SELECT 1 DELETE FROM ${T}`, `SELECT 1 BACKUP DATABASE master TO DISK = '/tmp/gw-planted.bak'`);
    const outcomes = [];
    for (const w of writes) outcomes.push(`${w.slice(0, 48)} → ${(await err(runQuery(ro, w, 10))) || 'ran (must have been rolled back)'}`);
    const after = await canary();
    check(`2.${kind}a. writes sent straight to a read-only connection change nothing`, after === '[[1]]', `canary ${after}\n     ${outcomes.join('\n     ')}`);
    const planted = await err(runQuery(rw, 'SELECT COUNT(*) FROM gw_planted', 10));
    check(`2.${kind}b. a table created through a read-only connection does not exist`, planted !== '', planted || 'gw_planted exists');
    // the assistant and MCP: read-only even on a read-write connection
    const forced = await err(runQuery(rw, `DELETE FROM ${T}`, 10, [], { forceReadOnly: true }));
    const after2 = await canary();
    check(`2.${kind}c. forceReadOnly on a read-write connection changes nothing`, after2 === '[[1]]', `canary ${after2}; ${forced || 'ran (rolled back)'}`);
    // reads work, including a result cut at the row limit
    const big = kind === 'postgres' ? 'SELECT generate_series(1, 500)' : kind === 'mssql' ? 'SELECT a.object_id FROM sys.all_objects a CROSS JOIN sys.all_objects b' : 'SELECT a.ORDINAL_POSITION FROM information_schema.COLUMNS a CROSS JOIN information_schema.COLUMNS b';
    let read = '';
    try {
      const r1 = await runQuery(ro, `SELECT n FROM ${T}`, 10);
      const r2 = await runQuery(ro, big, 5);
      read = r1.rows.length === 1 && r2.rows.length === 5 && r2.truncated ? 'ok' : `rows ${r1.rows.length}, ${r2.rows.length}, truncated ${r2.truncated}`;
    } catch (e) {
      read = e.message;
    }
    check(`2.${kind}d. reads on a read-only connection work, and a long result stops at the limit`, read === 'ok', read);
    if (kind === 'postgres') {
      const r = await runQuery(ro, "SELECT current_setting('standard_conforming_strings'), current_setting('transaction_read_only')", 10);
      check('2.postgres e. the query runs with standard strings in a read-only transaction', JSON.stringify(r.rows) === '[["on","on"]]', JSON.stringify(r.rows));
    }
    if (kind === 'mssql') {
      const r = await runQuery(ro, 'SELECT @@TRANCOUNT', 10);
      check('2.mssql e. the query runs inside a transaction (which is rolled back)', JSON.stringify(r.rows) === '[[1]]', JSON.stringify(r.rows));
    }
    if (kind === 'mysql') {
      const r = await runQuery(ro, 'SELECT @@SESSION.transaction_read_only', 10).catch(() => runQuery(ro, 'SELECT @@SESSION.tx_read_only', 10));
      check('2.mysql e. the session is read-only', String(r.rows[0]?.[0]) === '1', JSON.stringify(r.rows));
      const rootPw = opt('--mysql-root');
      if (rootPw) {
        const [host, port, database] = spec.split(':');
        const root = { ...connOf(kind, `${host}:${port}:${database}:root:${rootPw}`, false), id: 'root' };
        const saved = (await runQuery(root, 'SELECT @@GLOBAL.sql_mode', 1)).rows[0][0];
        try {
          await runQuery(root, "SET GLOBAL sql_mode = 'ANSI,NO_BACKSLASH_ESCAPES'", 1);
          const m = String((await runQuery(ro, 'SELECT @@SESSION.sql_mode', 1)).rows[0][0]);
          check('2.mysql f. a server set to read quotes differently is set back for the read-only session', !/NO_BACKSLASH_ESCAPES|ANSI_QUOTES/.test(m), m);
        } finally {
          await runQuery(root, 'SET GLOBAL sql_mode = ?', 1, [saved]);
        }
      }
    }
    await runQuery(rw, drop, 10).catch(() => undefined);
  }
} else {
  console.log('(part 2 skipped: no --pg/--mysql/--mssql given)');
}

rmSync(DATA, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

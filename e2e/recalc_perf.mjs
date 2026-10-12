#!/usr/bin/env node
// Recalculation cost on the real wasm build: edits must cost what they change, not the size of
// the workbook. Each case builds a sheet, times the operations named in its title, checks the
// result and holds the time under a budget.
//
//   node e2e/recalc_perf.mjs [engine-dir]          (default: server/engine)
//   node e2e/recalc_perf.mjs [engine-dir] --report (print the times, never fail on a budget)
//
// Each case runs in its own process with a time limit, so a quadratic case on an old engine is
// reported as a failure instead of stalling the suite. Budgets are several times what the case
// takes on a CI runner, and well under what it took before the dependency index (review
// 11 Oct, 2.8); the times before are in the last column and in the PR that added this file.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const TIME_LIMIT_MS = 120_000;

const op = (b, o) => {
  const ch = JSON.parse(b.apply(JSON.stringify(o)));
  if (ch.error) throw new Error(`${o.type}: ${ch.error}`);
  return ch;
};
const set = (b, row, col, input) => op(b, { type: 'set_cell', table: 1, row, col, input });
const value = (b, row, col) => JSON.parse(b.cell(1, row, col)).v;
const timed = (f) => {
  const t0 = performance.now();
  f();
  return performance.now() - t0;
};
/** A book whose table 1 has `rows` rows and `cols` columns. */
function book(Book, rows, cols) {
  const b = new Book('perf');
  op(b, { type: 'resize_table', table: 1, rows, cols });
  return b;
}
/** Paste A = 1..n and B = a running balance of A. */
function runningBalance(Book, n) {
  const b = book(Book, n + 1, 4);
  const values = [];
  for (let i = 0; i < n; i++) values.push([String(i + 1), i === 0 ? '=A1' : `=B${i}+A${i + 1}`]);
  op(b, { type: 'set_cells', table: 1, row: 0, col: 0, values });
  return b;
}
const sum1toN = (n) => (n * (n + 1)) / 2;

// [name, run(Book) -> { ms, ok, got }, budget ms, before: ms on main at 1d71db3]
const CASES = [
  ['running balance typed cell by cell, 3,000 rows (6,000 edits)', (Book) => {
    const n = 3000;
    const b = book(Book, n + 1, 4);
    const ms = timed(() => {
      for (let i = 0; i < n; i++) {
        set(b, i, 0, String(i + 1));
        set(b, i, 1, i === 0 ? '=A1' : `=B${i}+A${i + 1}`);
      }
    });
    const got = value(b, n - 1, 1);
    return { ms, ok: got.n === sum1toN(n), got };
  }, 2000, 6013],
  ['running balance typed cell by cell, 10,000 rows (20,000 edits)', (Book) => {
    const n = 10000;
    const b = book(Book, n + 1, 4);
    const ms = timed(() => {
      for (let i = 0; i < n; i++) {
        set(b, i, 0, String(i + 1));
        set(b, i, 1, i === 0 ? '=A1' : `=B${i}+A${i + 1}`);
      }
    });
    const got = value(b, n - 1, 1);
    return { ms, ok: got.n === sum1toN(n), got };
  }, 6000, 80442],
  ['running balance of 10,000 rows pasted at once', (Book) => {
    let b;
    const ms = timed(() => { b = runningBalance(Book, 10000); });
    const got = value(b, 9999, 1);
    return { ms, ok: got.n === sum1toN(10000), got };
  }, 3000, 494],
  ['editing the first amount of a 10,000-row running balance', (Book) => {
    const b = runningBalance(Book, 10000);
    const ms = timed(() => set(b, 0, 0, '101'));
    const got = value(b, 9999, 1);
    return { ms, ok: got.n === sum1toN(10000) + 100, got };
  }, 1500, 14153],
  ['editing the head of a 5,000-cell chain', (Book) => {
    const n = 5000;
    const b = book(Book, n + 1, 2);
    const values = [['1']];
    for (let i = 1; i < n; i++) values.push([`=A${i}+1`]);
    op(b, { type: 'set_cells', table: 1, row: 0, col: 0, values });
    const ms = timed(() => set(b, 0, 0, '2'));
    const got = value(b, n - 1, 0);
    return { ms, ok: got.n === n + 1, got };
  }, 1000, 2861],
  ['undo and redo of that edit', (Book) => {
    const n = 5000;
    const b = book(Book, n + 1, 2);
    const values = [['1']];
    for (let i = 1; i < n; i++) values.push([`=A${i}+1`]);
    op(b, { type: 'set_cells', table: 1, row: 0, col: 0, values });
    set(b, 0, 0, '2');
    let after;
    const ms = timed(() => { b.undo(); after = value(b, n - 1, 0); b.redo(); });
    const got = value(b, n - 1, 0);
    return { ms, ok: after.n === n && got.n === n + 1, got: { undone: after, redone: got } };
  }, 2000, 5992],
  ['2,000 SUM(A:A) pasted, then one amount edited', (Book) => {
    const n = 2000;
    const b = book(Book, n + 1, 3);
    const values = [];
    for (let i = 0; i < n; i++) values.push([String(i), '=SUM(A:A)']);
    const ms = timed(() => {
      op(b, { type: 'set_cells', table: 1, row: 0, col: 0, values });
      set(b, 5, 0, '7');
    });
    const got = value(b, n - 1, 1);
    return { ms, ok: got.n === sum1toN(n - 1) + 2, got };
  }, 6000, 1658],
  ['2,000 edits beside a spilled SEQUENCE in a 10,000-row table', (Book) => {
    const n = 10000;
    const b = book(Book, n + 1, 4);
    const values = [];
    for (let i = 0; i < n; i++) values.push([String(i)]);
    op(b, { type: 'set_cells', table: 1, row: 0, col: 0, values });
    set(b, 0, 2, '=SEQUENCE(1000)');
    const ms = timed(() => {
      for (let i = 0; i < 2000; i++) set(b, i, 1, String(i));
    });
    const got = value(b, 999, 2);
    return { ms, ok: got.n === 1000 && value(b, 1999, 1).n === 1999, got };
  }, 1000, 2052],
  ['a row inserted into a 10,000-row running balance, then an amount edited', (Book) => {
    const b = runningBalance(Book, 10000);
    const ms = timed(() => {
      op(b, { type: 'insert_rows', table: 1, at: 5000, count: 1 });
      set(b, 5000, 0, '1000');
      set(b, 5000, 1, '=B5000+A5001');
      // the next row still adds to the row above the insertion, as in Excel: link it to the new row
      set(b, 5001, 1, '=B5001+A5002');
      set(b, 0, 0, '2');
    });
    const got = value(b, 10000, 1);
    return { ms, ok: got.n === sum1toN(10000) + 1001, got };
  }, 3000, 25842],
];

function runCase(engineDir, i) {
  const require = createRequire(import.meta.url);
  const { Book } = require(path.resolve(engineDir, 'gridwright_core.js'));
  const r = CASES[i][1](Book);
  process.stdout.write('\n' + JSON.stringify(r) + '\n');
}

function main() {
  const args = process.argv.slice(2);
  const ci = args.indexOf('--case');
  const report = args.includes('--report');
  const positional = args.filter((a, k) => !a.startsWith('--') && (ci < 0 || k !== ci + 1));
  const engineDir = positional[0] || path.join(here, '..', 'server', 'engine');
  if (ci >= 0) return runCase(engineDir, Number(args[ci + 1]));

  console.log(`engine: ${path.resolve(engineDir)}`);
  let failed = 0;
  CASES.forEach(([name, , budget, before], i) => {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), engineDir, '--case', String(i)], {
      encoding: 'utf8', timeout: TIME_LIMIT_MS, maxBuffer: 16 << 20,
    });
    let verdict;
    let ok = false;
    if (r.error && r.error.code === 'ETIMEDOUT') verdict = `no result in ${TIME_LIMIT_MS / 1000} s`;
    else if (r.status !== 0) {
      const why = (r.stderr || '').split('\n').find((l) => /Error|panicked/.test(l)) || `exit ${r.status ?? r.signal}`;
      verdict = `crashed: ${why.trim().slice(0, 140)}`;
    } else {
      const out = JSON.parse(r.stdout.trim().split('\n').pop());
      const fast = out.ms <= budget;
      ok = out.ok && (fast || report);
      verdict = `${Math.round(out.ms)} ms (budget ${budget} ms)${out.ok ? '' : `; wrong result ${JSON.stringify(out.got)}`}${fast ? '' : '; over budget'}`;
    }
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${i + 1}. ${name} -> ${verdict}${before ? `   [before: ${before} ms]` : ''}`);
  });
  console.log(`\n${CASES.length - failed} of ${CASES.length} recalculation timing checks passed`);
  process.exit(failed ? 1 : 0);
}

main();

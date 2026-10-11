#!/usr/bin/env node
// Engine limits on the real wasm build: formulas that used to crash the engine, hang it or
// exhaust its memory must return an error value quickly and leave the engine working.
//
// Runs against the Node build of the engine (the same Rust code as the browser build, with the
// same 1 MB wasm stack). Each case runs in its own process with a time limit, so a crash or a
// hang is reported as a failure of that case instead of stopping the suite.
//
//   node e2e/engine_limits.mjs [engine-dir]        (default: server/engine)
//
// The Rust unit tests (core/src/formula/mod.rs) check the same limits natively, plus the
// work-day functions against a day-by-day count; this file proves them on the shipped engine.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const TIME_LIMIT_MS = 20_000;

const err = (code) => (v) => v.e === code;
const num = (n) => (v) => v.n === n;
const nest = (k, open, close) => `${open.repeat(k)}1${close.repeat(k)}`;

/** A table big enough for the cell cases; returns its id. */
function table(b, rows, cols) {
  b.apply(JSON.stringify({ type: 'add_table', x: 0, y: 0, rows, cols }));
  const all = JSON.parse(b.tables());
  return all[all.length - 1].id;
}

// [name, formula or function(book) -> value, expectation, what it used to do]
const CASES = [
  // arrays sized by arguments
  ['SEQUENCE overflowing rows×cols', '=SEQUENCE(65537,65537)', err('#NUM!'), 'u32 overflow, huge allocation'],
  ['SEQUENCE(1E10,1E10)', '=SEQUENCE(1E10,1E10)', err('#NUM!'), 'out of memory'],
  ['EXPAND to 10 billion cells', '=EXPAND(1,1E5,1E5)', err('#NUM!'), 'out of memory'],
  ['WRAPROWS with 1E9 columns', '=WRAPROWS({1,2,3},1E9)', err('#NUM!'), 'out of memory'],
  ['a million-cell SEQUENCE still works', '=SUM(SEQUENCE(1000,1000))', num(500000500000), ''],
  // text past Excel's 32,767-character limit
  ['REPT 1E10 times', '=REPT("x",1E10)', err('#VALUE!'), 'out of memory'],
  ['nested REPT', '=REPT(REPT("x",30000),30000)', err('#VALUE!'), '900 MB string'],
  ['SUBSTITUTE growing the text', '=SUBSTITUTE(REPT("a",30000),"a","bb")', err('#VALUE!'), ''],
  ['& past the limit', '=REPT("a",20000)&REPT("b",20000)', err('#VALUE!'), ''],
  ['FIXED with 1E9 decimals', '=FIXED(1,1E9)', err('#VALUE!'), 'out of memory'],
  ['BASE padded to 1E9 digits', '=BASE(1,2,1E9)', err('#NUM!'), 'out of memory'],
  ['the largest allowed text', '=LEN(REPT("x",32767))', num(32767), ''],
  // loops bounded by their arguments
  ['NETWORKDAYS over 1E12 days', '=NETWORKDAYS(0,1E12)', err('#NUM!'), 'hang (day-by-day loop)'],
  ['WORKDAY 1E12 days', '=WORKDAY(0,1E12)', err('#NUM!'), 'hang'],
  ['NETWORKDAYS.INTL over 1E12 days', '=NETWORKDAYS.INTL(0,1E12,1)', err('#NUM!'), 'hang'],
  ['WORKDAY.INTL 1E12 days', '=WORKDAY.INTL(0,1E12,1)', err('#NUM!'), 'hang'],
  ['NETWORKDAYS over all of Excel\'s dates', '=NETWORKDAYS(1,2958465)', num(2113190), 'slow'],
  ['COMBIN(1E18,1E17)', '=COMBIN(1E18,1E17)', err('#NUM!'), 'hang'],
  ['PERMUT(1E18,1E17)', '=PERMUT(1E18,1E17)', err('#NUM!'), 'hang'],
  // dates outside 0 .. 31 Dec 9999
  ['YEAR(1E300)', '=YEAR(1E300)', err('#NUM!'), 'panic'],
  ['DATE(1E9,1,1)', '=DATE(1E9,1,1)', err('#NUM!'), ''],
  ['EDATE 1E15 months', '=EDATE(0,1E15)', err('#NUM!'), ''],
  ['TEXT of a date past 9999', '=TEXT(1E300,"dd/mm/yyyy")', err('#VALUE!'), ''],
  // nesting and length
  ['5,000 nested parentheses', '=' + nest(5000, '(', ')'), err('#NAME?'), 'stack overflow'],
  ['5,000 unary minus signs', '=' + '-'.repeat(5000) + '1', err('#NAME?'), 'stack overflow'],
  ['8,000 percent signs', '=1' + '%'.repeat(8000), err('#NAME?'), 'stack overflow'],
  ['255 nested parentheses', '=' + nest(255, '(', ')'), num(1), ''],
  ['64 nested functions (Excel\'s limit)', '=' + nest(64, 'ABS(', ')'), num(1), ''],
  ['a 4,096-term chain', '=' + '1+'.repeat(4095) + '1', num(4096), 'stack overflow'],
  ['a 20,000-term chain (past Excel\'s 8,192 characters)', '=' + '1+'.repeat(19999) + '1', num(20000), 'stack overflow'],
  ['60 nested LETs', '=' + 'LET(x,1,'.repeat(60) + 'x' + ')'.repeat(60), num(1), ''],
  // work per formula: each limit above bounds one result; the work budget bounds repeating them
  ['a 32,767-character text over a million rows', '=ROWS(IF(SEQUENCE(1E6),REPT("x",32767)))', err('#NUM!'), 'hang (32 GB of text)'],
  ['& of a long text over a million rows', '=ROWS(SEQUENCE(1E6)&REPT("x",32767))', err('#NUM!'), '11 s'],
  ['IFERROR cannot hide a stopped evaluation', '=IFERROR(ROWS(SEQUENCE(1E6)&REPT("x",1000)),7)', err('#NUM!'), 'hang'],
  ['3,200 long texts in one formula', '=' + Array(3200).fill('LEN(REPT("x",32767))').join('+'), err('#NUM!'), ''],
  ['2,900 long texts in one formula still work', '=' + Array(2900).fill('LEN(REPT("x",32767))').join('+'), num(2900 * 32767), ''],
  ['ARRAYTOTEXT past the text limit', '=LEN(ARRAYTOTEXT(SEQUENCE(1000,1000)))', err('#VALUE!'), '7.9 million characters'],
  ['UNIQUE of 100,000 values', '=ROWS(UNIQUE(SEQUENCE(100000)))', num(100000), 'hang (compares every pair)'],
  ['UNIQUE of 200,000 values with repeats', '=ROWS(UNIQUE(MOD(SEQUENCE(200000),1000)))', num(1000), 'slow'],
  ['XLOOKUP of 100,000 values in 100,000 keys', '=SUM(XLOOKUP(SEQUENCE(100000),SEQUENCE(100000),SEQUENCE(100000)))', num(5000050000), 'hang (10 billion comparisons)'],
  ['a name defined as INDIRECT of itself', (b) => {
    const name = (n, reference) => b.apply(JSON.stringify({ type: 'set_name', name: n, reference }));
    name('Loop', 'INDIRECT("Loop")');
    name('A', 'INDIRECT("B")*2');
    name('B', 'INDIRECT("C")+1');
    name('C', '20');
    const t = JSON.parse(b.tables())[0]?.id ?? table(b, 5, 3);
    const at = (f) => JSON.parse(b.eval_at(t, 4, 2, f));
    return { loop: at('=Loop'), caught: at('=IFERROR(Loop,7)'), chain: at('=A') };
  }, (v) => v.loop.e === '#CYCLE!' && v.caught.n === 7 && v.chain.n === 42, 'crash (stack overflow)'],
  // the recalculation path: formulas stored in cells, then rows inserted above them
  ['the tallest formula tree the limits allow, in a cell', (b) => {
    const t = table(b, 5, 3);
    // every precedence level at every nesting level: = & + * ^ ( … )
    const f = '=' + '1=1&1+1*1^('.repeat(255) + '1' + ')'.repeat(255);
    b.apply(JSON.stringify({ type: 'set_cell', table: t, row: 0, col: 0, input: f }));
    return JSON.parse(b.cell(t, 0, 0)).v;
  }, (v) => v && v.b === false, ''],
  ['a 2,700-reference chain in a cell, then a row inserted', (b) => {
    const t = table(b, 20, 3);
    b.apply(JSON.stringify({ type: 'set_cell', table: t, row: 0, col: 0, input: '10' }));
    b.apply(JSON.stringify({ type: 'set_cell', table: t, row: 5, col: 2, input: '=' + 'A1+'.repeat(2700) + 'A1' }));
    const before = JSON.parse(b.cell(t, 5, 2)).v;
    b.apply(JSON.stringify({ type: 'insert_rows', table: t, at: 0, count: 1 }));
    const moved = JSON.parse(b.cell(t, 6, 2));
    // printed with spaces around operators: `=A2 + A2 + …`
    const text = moved.i.replace(/\s+/g, '');
    return { n: before && before.n, moved: text.startsWith('=A2+A2') && !text.includes('A1') && moved.v && moved.v.n === before.n };
  }, (v) => v.n === 27010 && v.moved === true, 'stack overflow'],
  // a long dependency chain must not recurse cell to cell (kept at 3,000 rows here: speed is
  // measured separately, see the recalculation item in the 11 Oct review)
  ['a 3,000-row running balance', (b) => {
    const t = table(b, 3000, 2);
    const values = [];
    for (let r = 0; r < 3000; r++) values.push(['1', r === 0 ? '=A1' : `=B${r}+A${r + 1}`]);
    b.apply(JSON.stringify({ type: 'set_cells', table: t, row: 0, col: 0, values }));
    const last = JSON.parse(b.cell(t, 2999, 1)).v;
    b.apply(JSON.stringify({ type: 'set_cell', table: t, row: 0, col: 0, input: '2' }));
    const after = JSON.parse(b.cell(t, 2999, 1)).v;
    return { n: last && last.n, after: after && after.n };
  }, (v) => v.n === 3000 && v.after === 3001, ''],
];

function runCase(engineDir, i) {
  const require = createRequire(import.meta.url);
  const { Book } = require(path.resolve(engineDir, 'gridwright_core.js'));
  const [, what] = CASES[i];
  const b = new Book('limits');
  const tid = JSON.parse(b.tables())[0]?.id ?? table(b, 5, 3);
  const t0 = Date.now();
  const value = typeof what === 'function' ? what(b) : JSON.parse(b.eval_at(tid, 4, 2, what));
  const ms = Date.now() - t0;
  const after = JSON.parse(b.eval_at(tid, 4, 2, '=1+1'));
  process.stdout.write('\n' + JSON.stringify({ value, ms, after }) + '\n');
}

function main() {
  const args = process.argv.slice(2);
  const ci = args.indexOf('--case');
  const positional = args.filter((a, k) => !a.startsWith('--') && (ci < 0 || k !== ci + 1));
  const engineDir = positional[0] || path.join(here, '..', 'server', 'engine');
  if (ci >= 0) return runCase(engineDir, Number(args[ci + 1]));

  console.log(`engine: ${path.resolve(engineDir)}`);
  let failed = 0;
  CASES.forEach(([name, , expect, used], i) => {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), engineDir, '--case', String(i)], {
      encoding: 'utf8', timeout: TIME_LIMIT_MS, maxBuffer: 16 << 20,
    });
    let verdict;
    let ok = false;
    if (r.error && r.error.code === 'ETIMEDOUT') verdict = `hung (no result in ${TIME_LIMIT_MS / 1000} s)`;
    else if (r.status !== 0) {
      const why = (r.stderr || '').split('\n').find((l) => /RangeError|RuntimeError|panicked|memory|stack|Error/.test(l)) || `exit ${r.status ?? r.signal}`;
      verdict = `crashed: ${why.trim().slice(0, 140)}`;
    } else {
      const line = r.stdout.trim().split('\n').pop();
      const out = JSON.parse(line);
      ok = expect(out.value) && out.after.n === 2;
      verdict = `${JSON.stringify(out.value).slice(0, 80)} in ${out.ms} ms${out.after.n === 2 ? '' : '; engine broken afterwards'}`;
    }
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${String(i + 1).padStart(2)}. ${name} -> ${verdict}${!ok && used ? `   [previously: ${used}]` : ''}`);
  });
  console.log(`\n${CASES.length - failed} of ${CASES.length} engine limit checks passed`);
  process.exit(failed ? 1 : 0);
}

main();

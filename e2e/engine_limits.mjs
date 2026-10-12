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
// The last cases check day counts against Excel's own results (DAYS360, YEARFRAC, two-digit
// years: Microsoft's examples and reported Excel results).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const TIME_LIMIT_MS = 20_000;

const err = (code) => (v) => v.e === code;
const num = (n) => (v) => v.n === n;
const near = (n) => (v) => typeof v.n === 'number' && Math.abs(v.n - n) < 5e-9;
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
  // IRR, XIRR and RATE evaluate every flow per iteration: their iterations are charged to the budget
  ['IRR of a million flows stops at the work budget', '=IRR(SEQUENCE(1E6)-2)', err('#NUM!'), '2.7 s'],
  ['a second one in the same formula is stopped at once', '=IRR(SEQUENCE(1E6)-2)+IRR(SEQUENCE(1E6)-2)', err('#NUM!'), '5.5 s'],
  ['XIRR of 300,000 dated flows', '=XIRR(SEQUENCE(300000)-2,SEQUENCE(300000,1,40000))', err('#NUM!'), '2.1 s'],
  ['IRR of 100,000 flows still works', '=IRR(SEQUENCE(100000)-2)', num(1), ''],
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
  // volatile functions: the clock, random numbers, references computed while evaluating
  ['RAND and RANDBETWEEN', (b) => {
    const t = table(b, 5, 3);
    const at = (f) => JSON.parse(b.eval_at(t, 0, 0, f));
    return { r: at('=RAND()'), d: at('=RANDBETWEEN(1,6)') };
  }, (v) => v.r.n >= 0 && v.r.n < 1 && Number.isInteger(v.d.n) && v.d.n >= 1 && v.d.n <= 6,
  'crash (WebAssembly has no clock: SystemTime::now() aborts)'],
  ['a saved workbook shows today once loaded', (b) => {
    const t = table(b, 5, 3);
    const set = (row, col, input) => b.apply(JSON.stringify({ type: 'set_cell', table: t, row, col, input }));
    set(0, 0, '=TODAY()');
    set(0, 1, '=A1+30');
    const loaded = b.constructor.from_json(b.to_json());
    const before = JSON.parse(loaded.cell(t, 0, 0)).v;
    const now = Date.now() / 86400000 + 25569; // what the client and the server pass
    const ch = JSON.parse(loaded.set_now(now));
    const v = (col) => JSON.parse(loaded.cell(t, 0, col)).v;
    return { before: before.n, today: v(0).n, plus: v(1).n, expect: Math.floor(now), reported: (ch.cells?.[t] || []).length };
  }, (v) => v.before === 0 && v.today === v.expect && v.plus === v.expect + 30 && v.reported === 2,
  'showed 30 Dec 1899 (set_now did not recalculate)'],
  ['INDIRECT and OFFSET follow the cells they point at', (b) => {
    const t = table(b, 6, 3);
    const set = (row, col, input) => b.apply(JSON.stringify({ type: 'set_cell', table: t, row, col, input }));
    set(1, 0, '5');
    set(2, 0, '=INDIRECT("A"&2)*2');
    set(3, 0, '=OFFSET(A1,1,0)+1');
    set(1, 0, '7');
    const v = (row) => JSON.parse(b.cell(t, row, 0)).v;
    return { indirect: v(2), offset: v(3) };
  }, (v) => v.indirect.n === 14 && v.offset.n === 8, 'INDIRECT kept 10; OFFSET was a false #CYCLE!'],
  ['INDIRECT of a computed address in a loaded workbook', (b) => {
    const t = table(b, 5, 4);
    const set = (row, col, input) => b.apply(JSON.stringify({ type: 'set_cell', table: t, row, col, input }));
    set(0, 2, '5');
    set(0, 1, '=C1*2');
    set(0, 3, 'B1');
    set(0, 0, '=INDIRECT(D1)');
    // the saved file's C1 differs from the value its formulas were computed from (edited elsewhere)
    const doc = JSON.parse(b.to_json());
    const tab = doc.tables.find((x) => x.id === t);
    const c1 = tab.cells.find((x) => x.r === 0 && x.c === 2).cell;
    c1.input = '6';
    c1.value = { n: 6 };
    const loaded = b.constructor.from_json(JSON.stringify(doc));
    const v = (col) => JSON.parse(loaded.cell(t, 0, col)).v;
    return { b1: v(1), a1: v(0) };
  }, (v) => v.b1.n === 12 && v.a1.n === 12, 'INDIRECT read B1 before it was recomputed'],
  ['10,000 TODAY() formulas, then an unrelated edit', (b) => {
    const t = table(b, 10000, 2);
    const values = [];
    for (let r = 0; r < 10000; r++) values.push([`=TODAY()-${r}`, '']);
    b.apply(JSON.stringify({ type: 'set_cells', table: t, row: 0, col: 0, values }));
    const t0 = Date.now();
    const ch = JSON.parse(b.apply(JSON.stringify({ type: 'set_cell', table: t, row: 0, col: 1, input: '1' })));
    // re-evaluated, as in Excel, but only a changed result is reported to the grid
    return { ms: Date.now() - t0, reported: (ch.cells?.[t] || []).length };
  }, (v) => v.reported === 1 && v.ms < 2000, ''],
  // day counts as Excel computes them (review 11 Oct, 2.3)
  ['DAYS360 from 29 Feb to 31 Mar is 30', '=DAYS360(DATE(2024,2,29),DATE(2024,3,31))', num(30), 'gave 32'],
  ['DAYS360 on 28 Feb to itself is -2', '=DAYS360(DATE(2006,2,28),DATE(2006,2,28))', num(-2), 'gave 0'],
  ['DAYS360 from 1 to 28 Feb is 27', '=DAYS360(DATE(2018,2,1),DATE(2018,2,28))', num(27), ''],
  ['DAYS360 from 30 Jan to 1 Feb is 1', '=DAYS360(DATE(2011,1,30),DATE(2011,2,1))', num(1), ''],
  ['YEARFRAC basis 0, Microsoft example', '=YEARFRAC(DATE(2012,1,1),DATE(2012,7,30))', near(0.58055556), ''],
  ['YEARFRAC basis 1, Microsoft example', '=YEARFRAC(DATE(2012,1,1),DATE(2012,7,30),1)', near(0.57650273), ''],
  ['YEARFRAC basis 1 of a whole non-leap year is 1', '=YEARFRAC(DATE(2023,1,1),DATE(2024,1,1),1)', num(1), 'gave 0.998632'],
  ['YEARFRAC basis 1 of a whole leap year is 1', '=YEARFRAC(DATE(2024,1,1),DATE(2025,1,1),1)', num(1), 'gave 1.001368'],
  ['YEARFRAC basis 0 from the last day of February', '=YEARFRAC(DATE(2023,2,28),DATE(2023,3,31))', near(31 / 360), 'gave 33/360'],
  ['two-digit year 95 is 1995', '=DATEVALUE("15/06/95")', num(34865), 'gave 2095'],
  ['two-digit year 30 is 1930', '=DATEVALUE("15/06/30")', num(11124), 'gave 2030'],
  ['two-digit year 29 is 2029', '=DATEVALUE("15/06/29")', num(47284), ''],
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

#!/usr/bin/env node
// Rounding and display as Excel (review 11 Oct, 2.6), against the shipped engine:
//  1. every case of core/src/formula/excel_cases.tsv (formula · Excel's result · source),
//     evaluated through the WASM `Book`;
//  2. the browser's formatter (client/src/grid/format.ts, bundled with esbuild) gives the same
//     text as the engine's TEXT() for numbers × patterns, and the same General text.
// Usage: node e2e/numerics.mjs [server/engine]
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { Book } = createRequire(import.meta.url)(path.resolve(process.argv[2] || 'server/engine', 'gridwright_core.js'));
let passed = 0, failed = 0;
const check = (ok, label) => {
  ok ? passed++ : failed++;
  if (!ok) console.log(`FAIL ${label}`);
};

// 1. Excel cases
const b = new Book('numerics');
b.apply(JSON.stringify({ type: 'add_table', x: 0, y: 0, rows: 5, cols: 3 }));
const table = JSON.parse(b.tables()).at(-1).id;
const lines = fs.readFileSync(path.join(root, 'core/src/formula/excel_cases.tsv'), 'utf8').split('\n');
let cases = 0;
for (const line of lines) {
  if (!line.trim() || line.startsWith('#')) continue;
  const [formula, expected, source] = line.split('\t');
  const got = JSON.parse(b.eval_at(table, 4, 2, '=' + formula));
  let ok;
  if (expected.startsWith('"')) ok = got.s === expected.slice(1, -1).replaceAll('""', '"');
  else if (expected.startsWith('#')) ok = got.e === expected;
  else if (expected === 'TRUE' || expected === 'FALSE') ok = got.b === (expected === 'TRUE');
  else ok = got.n === Number(expected);
  check(ok, `=${formula}: ${JSON.stringify(got)}, Excel ${expected} (${source})`);
  cases++;
}
console.log(`excel cases: ${cases}`);

// The review's example: a value read back as text showed binary noise.
const cell = (row, col, input) => b.apply(JSON.stringify({ type: 'set_cell', table, row, col, input }));
cell(0, 0, '888888888.3');
cell(0, 1, '=A1&" AOA"');
check(JSON.parse(b.eval_at(table, 4, 2, '=B1')).s === '888888888.3 AOA', 'concatenation shows 888888888.3');
b.free();

// 2. Browser formatter == engine
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-numerics-'));
const bundle = path.join(out, 'format.mjs');
execFileSync(path.join(root, 'client/node_modules/.bin/esbuild'), [path.join(root, 'client/src/grid/format.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${bundle}`, '--log-level=error']);
const client = await import(pathToFileURL(bundle).href);
fs.rmSync(out, { recursive: true, force: true });

const patterns = ['', 'General', '0', '0.00', '#,##0', '#,##0.00', '#.##0,00', '0,00', '0%', '0.0%', '€#,##0.00', '$#,##0.00',
  '#,##0.00 "Kz"', '#.##0,00 "Kz"', '#,##0,', '0.0,,', '####.#', '#.0#', '0.#', '???.???', '0000000', '"Total "#,##0.00',
  '#,##0.00;(#,##0.00)', '#,##0.00;[Red]-#,##0.00;"-"', '0.00;(0.00);"zero"',
  '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)', '_($* #,##0_);_($* (#,##0);_($* "-"_);_(@_)', '\\$0.00', '0.000_)'];
const values = [0, -0, 1, -1, 0.5, -0.5, 1.005, -1.005, 2.675, 0.1 + 0.2, 1 / 3, -2 / 3, 1234.5, -1234.5, 1234567.891, 999.995,
  0.285, 12200000, 888888888.3, 1e15, 1234567890123456, 1e20, 1e-7, 1.5e-11, -0.0004, 99.999, 1000000000000005, 123456789.987654321];
let rng = 0x9e3779b9;
const rand = () => ((rng = (rng * 1103515245 + 12345) >>> 0) / 2 ** 32);
for (let i = 0; i < 300; i++) values.push((rand() - 0.4) * 10 ** Math.floor(rand() * 24 - 10));
let compared = 0;
for (const v of values) {
  const general = Book.format_number(v, '');
  check(client.formatNumber(v, '', true) === general, `General ${v}: client ${client.formatNumber(v, '', true)} engine ${general}`);
  for (const p of patterns) {
    const engine = Book.format_number(v, p);
    const browser = client.formatNumber(v, p, true);
    check(browser === engine, `${v} "${p}": client ${JSON.stringify(browser)} engine ${JSON.stringify(engine)}`);
    compared++;
  }
}
console.log(`client/engine comparisons: ${compared + values.length}`);
// a pattern's text section applies to text cells in the grid, as TEXT() does
check(client.displayValue({ s: 'n/a' }, { number_format: '0;0;0;"[" @ "]"' }, true) === '[ n/a ]', 'text section in the grid');
check(client.displayValue({ s: 'n/a' }, { number_format: '0.00' }, true) === 'n/a', 'text without a text section');

console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

#!/usr/bin/env node
// Numeric precision policy (review 11 Oct, 2.5):
// https://learn.microsoft.com/en-us/office/troubleshoot/excel/floating-point-arithmetic-inaccurate-result
// CHECK is Gridwright-specific; its condition uses Excel-style numeric equality.
import { createRequire } from 'node:module';
import path from 'node:path';
const { Book } = createRequire(import.meta.url)(path.resolve(process.argv[2] || 'server/engine', 'gridwright_core.js'));
const b = new Book('numeric equality');
b.apply(JSON.stringify({type:'add_table', x:0, y:0, rows:10, cols:4}));
const table = JSON.parse(b.tables()).at(-1).id;
for (const [row,col,input] of [[0,0,'0.1'],[1,0,'0.2'],[2,0,'0.3'],[0,1,'0.6']]) {
  b.apply(JSON.stringify({type:'set_cell',table,row,col,input}));
}
let passed = 0, failed = 0;
for (const [formula, expected] of [
  ['=CHECK(SUM(A1:A3)=B1)', true],
  ['=0.1+0.2=0.3', true],
  // https://support.microsoft.com/en-us/excel/functions/sumif-function
  ['=SUMIF({0.3,0.1},0.1+0.2)', 0.3],
  // https://techcommunity.microsoft.com/blog/excelblog/announcing-xlookup/811376
  // Array keys exercise the hash-index path as well as scalar lookup.
  ['=SUM(XLOOKUP({0.1+0.2,0.1},{0.3,0.1},{7,8}))', 15],
]) {
  const actual = JSON.parse(b.eval_at(table,0,2,formula));
  const ok = (actual.n ?? actual.b ?? actual.e) === expected;
  ok ? passed++ : failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${formula}: ${JSON.stringify(actual)}`);
}
b.free();
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

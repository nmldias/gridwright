#!/usr/bin/env node
// Dates read by the guided import (server/src/dsengine.ts toDate): day-first and month-first
// numeric dates, ISO text, spreadsheet serials, and two-digit years with Excel's pivot
// (00-29 are 2000-2029, 30-99 are 1930-1999), so an export's "15/06/95" is 1995, not 2095.
//
//   node e2e/import_dates.mjs [server-dist-dir]      (default: server/dist)
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(process.argv[2] || path.join(here, '..', 'server', 'dist'));
const { toDate } = await import(pathToFileURL(path.join(dist, 'dsengine.js')).href);

const CASES = [
  // [input, dayFirst, expected ISO date or null]
  ['15/06/2026', true, '2026-06-15'],
  ['15.06.2026', true, '2026-06-15'],
  ['15-06-2026', true, '2026-06-15'],
  ['06/15/2026', false, '2026-06-15'],
  ['2026-06-15', true, '2026-06-15'],
  ['2026-06-15T10:30:00Z', true, '2026-06-15'],
  ['20260615', true, '2026-06-15'],
  [46188, true, '2026-06-15'],
  // two-digit years: Excel's pivot
  ['15/06/26', true, '2026-06-15'],
  ['31/12/29', true, '2029-12-31'],
  ['01/01/30', true, '1930-01-01'],
  ['15/06/95', true, '1995-06-15'],
  ['06/15/95', false, '1995-06-15'],
  ['01/01/00', true, '2000-01-01'],
  // not dates
  ['31/02/2026', true, null],
  ['13/13/2026', true, null],
  ['abc', true, null],
  [12, true, null],
];

let failed = 0;
for (const [input, dayFirst, want] of CASES) {
  const got = toDate(input, dayFirst);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} toDate(${JSON.stringify(input)}, ${dayFirst ? 'day first' : 'month first'}) = ${JSON.stringify(got)}${ok ? '' : `, want ${JSON.stringify(want)}`}`);
}
console.log(`\n${CASES.length - failed} of ${CASES.length} import date checks passed`);
process.exit(failed ? 1 : 0);

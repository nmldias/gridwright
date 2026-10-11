#!/usr/bin/env node
// Numbers typed the Portuguese way (review 11 Oct, 2.4), on the real wasm build of the engine.
//
// A workbook has a decimal-comma setting (an op, so every replica agrees and it can be undone).
// What a person types or pastes from outside goes through normalize_typed, which turns
// "1.234,56" into the canonical "1,234.56" the engine stores; edit_text shows a stored input the
// way it was typed. Ops, formulas and copies inside the workbook stay canonical. In every
// workbook, repeated separators count as thousands only with valid grouping, and "(…)" is
// negative, so "1,5" or "08.10.2026" never silently become 15 or 8102026.
//
//   node e2e/decimal_comma.mjs [engine-dir]        (default: server/engine)
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(process.argv[2] || path.join(here, '..', 'server', 'engine'));
const { Book } = createRequire(import.meta.url)(path.join(dir, 'gridwright_core.js'));

let passed = 0;
const failed = [];
function check(name, fn) {
  let ok = false;
  let detail = '';
  try {
    const r = fn();
    ok = r === true || (Array.isArray(r) && r[0] === true);
    if (Array.isArray(r)) detail = JSON.stringify(r[1]);
  } catch (e) {
    detail = `threw: ${String(e?.message || e).slice(0, 160)}`;
  }
  if (ok) passed++;
  else failed.push(name);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  — ${detail}` : ''}`);
}

function workbook(comma) {
  const b = new Book('t');
  b.apply(JSON.stringify({ type: 'add_table', x: 0, y: 0, rows: 20, cols: 4 }));
  const t = JSON.parse(b.tables()).at(-1).id;
  if (comma) {
    const ch = JSON.parse(b.apply(JSON.stringify({ type: 'set_decimal_comma', on: true })));
    if (ch.error) console.log(`  (set_decimal_comma refused: ${String(ch.error).slice(0, 90)})`);
  }
  let row = 0;
  /** Store a typed value the way the client does, and return [stored input, value]. */
  const typed = (text) => {
    const input = b.normalize_typed(text);
    const r = row++;
    b.apply(JSON.stringify({ type: 'set_cell', table: t, row: r, col: 0, input }));
    const c = JSON.parse(b.cell(t, r, 0));
    return [c.i ?? input, c.v];
  };
  /** Store an input exactly (an op, a paste inside the workbook, an import). */
  const raw = (input) => {
    const r = row++;
    b.apply(JSON.stringify({ type: 'set_cell', table: t, row: r, col: 0, input }));
    return JSON.parse(b.cell(t, r, 0)).v;
  };
  return { b, t, typed, raw };
}
const n = (v) => (v && typeof v.n === 'number' ? v.n : null);
const close = (a, x) => a !== null && Math.abs(a - x) < 1e-9;

// --- every workbook: grouping, parentheses, no silent wrong numbers ---
{
  const { raw } = workbook(false);
  check('1. "1,500" is still 1500', () => [n(raw('1,500')) === 1500, raw('1,500')]);
  check('1b. "1.5" is 1.5', () => [close(n(raw('1.5')), 1.5), raw('1.5')]);
  check('1c. "1,5" is not 15 (comma needs 3-digit groups)', () => { const v = raw('1,5'); return [n(v) !== 15, v]; });
  check('1d. "1.000.000" is one million', () => [n(raw('1.000.000')) === 1000000, raw('1.000.000')]);
  check('1e. "(1,234.00)" is -1234', () => [n(raw('(1,234.00)')) === -1234, raw('(1,234.00)')]);
  check('1f. "08.10.2026" is not the number 8102026', () => { const v = raw('08.10.2026'); return [n(v) !== 8102026 && n(v) !== 8.102026, v]; });
  check('1g. "1,234.56" is 1234.56', () => [close(n(raw('1,234.56')), 1234.56), raw('1,234.56')]);
}

// --- the setting itself ---
{
  const { b } = workbook(false);
  check('2. a new workbook has no decimal comma, and its JSON is unchanged', () => {
    const doc = JSON.parse(b.to_json());
    return [b.decimal_comma() === false && !('decimal_comma' in doc), Object.keys(doc)];
  });
  check('2b. typing in a dot workbook is left as typed', () => [b.normalize_typed('1.234,56') === '1.234,56' && b.normalize_typed('1,5') === '1,5', b.normalize_typed('1,5')]);
  const ch = JSON.parse(b.apply(JSON.stringify({ type: 'set_decimal_comma', on: true })));
  check('2c. set_decimal_comma turns it on and reports it', () => [b.decimal_comma() === true && ch.decimal_comma === true, ch.decimal_comma]);
  check('2d. it is saved and loaded with the workbook', () => {
    const loaded = Book.from_json(b.to_json());
    return [loaded.decimal_comma() === true, JSON.parse(b.to_json()).decimal_comma];
  });
  const u = JSON.parse(b.undo());
  check('2e. undo turns it off again and reports it', () => [b.decimal_comma() === false && u.decimal_comma === false, u.decimal_comma]);
  check('2f. the setting and its undo travel as ops: another editor replaying them agrees', () => {
    const relay = (u.ops || []).filter((o) => o.type === 'set_decimal_comma');
    const other = new Book('t2');
    other.apply(JSON.stringify({ type: 'set_decimal_comma', on: true }));
    const on = other.decimal_comma();
    for (const o of relay) other.apply(JSON.stringify(o));
    return [on === true && relay.length === 1 && relay[0].on === false && other.decimal_comma() === false, relay];
  });
}

// --- a decimal-comma workbook ---
{
  const { b, t, typed, raw } = workbook(true);
  check('3. "1,5" typed is 1.5', () => { const [i, v] = typed('1,5'); return [close(n(v), 1.5) && i === '1.5', [i, v]]; });
  check('3b. "1.234,56" typed is 1234.56', () => { const [i, v] = typed('1.234,56'); return [close(n(v), 1234.56), [i, v]]; });
  check('3c. "1.000" typed is one thousand', () => { const [i, v] = typed('1.000'); return [n(v) === 1000, [i, v]]; });
  check('3d. "1.000.000" typed is one million', () => { const [i, v] = typed('1.000.000'); return [n(v) === 1000000, [i, v]]; });
  check('3p. "1,500" typed is one and a half, not 1500 (the review\'s example)', () => { const [i, v] = typed('1,500'); return [close(n(v), 1.5), [i, v]]; });
  check('3q. "08.10.2026" typed is the date 8 Oct 2026, not a number', () => { const [i, v] = typed('08.10.2026'); return [n(v) === 46303, [i, v]]; });
  check('3e. "(1.234,00)" typed is -1234', () => { const [i, v] = typed('(1.234,00)'); return [n(v) === -1234, [i, v]]; });
  check('3f. "1.234,56 Kz" typed is 1234.56', () => { const [i, v] = typed('1.234,56 Kz'); return [close(n(v), 1234.56), [i, v]]; });
  check('3g. "-2,5%" typed is -0.025', () => { const [i, v] = typed('-2,5%'); return [close(n(v), -0.025), [i, v]]; });
  check('3h. a formula is stored as typed (English: "." decimals, "," between arguments)', () => {
    const [i, v] = typed('=ROUND(1.25,1)+1');
    return [i === '=ROUND(1.25,1)+1' && close(n(v), 2.3), [i, v]];
  });
  check("3i. an apostrophe keeps text: \"'1,5\"", () => { const [i, v] = typed("'1,5"); return [n(v) === null && i === "'1,5", [i, v]]; });
  check('3j. plain text and dates are left alone', () => {
    const [i1] = typed('Factura 1.234,5');
    const [i2, v2] = typed('08.10.2026');
    return [i1 === 'Factura 1.234,5' && n(v2) !== 8102026 && i2 === '08.10.2026', [i1, i2, v2]];
  });
  check('3k. edit_text shows a stored input the way it was typed', () => {
    const pairs = [['1.5', '1,5'], ['1,234.56', '1.234,56'], ['=SUM(A1:A2)*1.5', '=SUM(A1:A2)*1.5'], ['abc', 'abc'], ['-1234', '-1234']];
    const got = pairs.map(([s]) => b.edit_text(s));
    return [pairs.every(([, want], k) => got[k] === want), got];
  });
  check('3l. typing what edit_text shows stores the same input (round trip)', () => {
    const inputs = ['1.5', '1,234.56', '1000000', '-0.025', '(1,234.00)', '2.5%', '1,234.56 Kz'];
    const back = inputs.map((s) => b.normalize_typed(b.edit_text(s)));
    return [inputs.every((s, k) => back[k] === s), back];
  });
  check('3m. canonical ops are not reinterpreted: "1,500" from an op is 1500', () => [n(raw('1,500')) === 1500, raw('1,500')]);
  check('3n. VALUE reads text the workbook way: VALUE("1,5") = 1.5', () => {
    const v = JSON.parse(b.eval_at(t, 19, 3, '=VALUE("1,5")'));
    return [close(n(v), 1.5), v];
  });
  check('3o. a formula on a text "1.234,5" cell computes 1234.5', () => {
    b.apply(JSON.stringify({ type: 'set_cell', table: t, row: 18, col: 1, input: "'1.234,5" }));
    const v = JSON.parse(b.eval_at(t, 19, 3, '=B19*1'));
    const cellText = JSON.parse(b.cell(t, 18, 1)).v;
    return [close(n(v), 1234.5), [cellText, v]];
  });
}

// --- filters and rules in a decimal-comma workbook: stored canonically, so the switch never
// changes which rows are kept or which entries are allowed; messages are written its way ---
{
  const { b, t } = workbook(true);
  const op = (o) => JSON.parse(b.apply(JSON.stringify({ table: t, ...o })));
  const hidden = () => JSON.parse(b.tables()).find((x) => x.id === t).hidden_rows.filter((r) => r <= 3);
  op({ type: 'set_header_rows', rows: 1 });
  [['Valor', 0], ['1.5', 1], ['1234.56', 2], ['7', 3]].forEach(([input, row]) => op({ type: 'set_cell', row, col: 0, input }));
  check('4. a filter on ticked values compares canonical text: keeping "1.5" and "1234.56" hides only the 7', () => {
    op({ type: 'set_filters', filters: [{ col: 0, values: ['1.5', '1234.56', ''] }] });
    return [JSON.stringify(hidden()) === '[3]', hidden()];
  });
  check('4b. …and switching to a decimal point keeps the same rows hidden', () => {
    b.apply(JSON.stringify({ type: 'set_decimal_comma', on: false }));
    const h = hidden();
    b.apply(JSON.stringify({ type: 'set_decimal_comma', on: true }));
    return [JSON.stringify(h) === '[3]' && JSON.stringify(hidden()) === '[3]', h];
  });
  check('4c. a condition typed "< 1.000" is stored as "1,000" and keeps everything under one thousand', () => {
    const value = b.normalize_typed('1.000');
    op({ type: 'set_filters', filters: [{ col: 0, op: 'lt', value }] });
    return [value === '1,000' && JSON.stringify(hidden()) === '[2]', [value, hidden()]];
  });
  op({ type: 'set_filters', filters: [] });
  op({ type: 'set_validations', rules: [{ r0: 5, c0: 0, r1: 9, c1: 0, kind: 'number', op: 'between', values: [b.normalize_typed('1,5'), b.normalize_typed('10')], allow_blank: true, strict: true }] });
  const verdict = (typedText) => JSON.parse(b.check_validation(t, 5, 0, b.normalize_typed(typedText)));
  check('4d. validation bounds typed "1,5" and "10" are stored canonically and refuse 0,5 with "between 1,5 and 10"', () => {
    const rule = JSON.parse(b.tables()).find((x) => x.id === t).validations[0];
    const no = verdict('0,5');
    const yes = verdict('2,5');
    return [JSON.stringify(rule.values) === '["1.5","10"]' && !no.ok && /between 1,5 and 10/.test(no.message) && yes.ok, [rule.values, no.message, yes.ok]];
  });
  check('4e. …and the same message reads "between 1.5 and 10" with a decimal point', () => {
    b.apply(JSON.stringify({ type: 'set_decimal_comma', on: false }));
    const no = verdict('0.5');
    b.apply(JSON.stringify({ type: 'set_decimal_comma', on: true }));
    return [!no.ok && /between 1\.5 and 10/.test(no.message), no.message];
  });
  check('4f. parse_number reads a stored threshold as the engine reads input', () => {
    const got = ['1,000', '2.5', '12%', '2026-10-08', 'Norte'].map((s) => Book.parse_number(s));
    return [got[0] === 1000 && got[1] === 2.5 && close(got[2], 0.12) && got[3] === 46303 && Number.isNaN(got[4]), got];
  });
}

const total = passed + failed.length;
console.log(`\n${passed}/${total} checks passed${failed.length ? `; failed: ${failed.join(' | ')}` : ''}`);
process.exit(failed.length ? 1 : 0);

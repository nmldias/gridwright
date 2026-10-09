// Starter documents for recurring finance work. Each template builds its tables with the
// ordinary ops, so everything stays editable and is recorded in the history.

import * as book from '../engine/book';
import { EMPTY_CHART } from '../engine/types';
import { addTable } from '../grid/actions';
import { layoutOf } from '../grid/geometry';
import { getState, setStatus, useStore } from '../state/store';
import { newFile } from './files';

export interface Template {
  id: string;
  name: string;
  description: string;
}

export const TEMPLATES: Template[] = [
  { id: 'ap-ageing', name: 'Accounts payable ageing', description: 'Open invoices bucketed by days overdue with AGEING(), a check that the buckets reconcile to the ledger, and an exhibit chart.' },
  { id: 'bank-rec', name: 'Bank reconciliation', description: 'Ledger vs statement matched by reference with RECONCILE(), a tolerance, and sign-off ready totals.' },
  { id: 'treasury', name: 'Treasury position', description: 'Balances per bank and currency converted with FX() against a rate table, with a SQL cell placeholder for Primavera.' },
];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return iso(d);
};

function place(): { x: number; y: number } {
  let y = 80;
  for (const t of getState().tables.values()) y = Math.max(y, t.y + layoutOf(t).height + 80);
  return { x: 80, y };
}

export async function applyTemplate(id: string): Promise<void> {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) return;
  await newFile(t.name);
  // the fresh document starts with an empty "Table 1": reuse it as the first table
  const first = getState().tables.keys().next().value as number | undefined;
  if (first !== undefined) book.apply({ type: 'delete_table', table: first }, { silent: true, origin: 'system' });
  switch (id) {
    case 'ap-ageing':
      apAgeing();
      break;
    case 'bank-rec':
      bankRec();
      break;
    case 'treasury':
      treasury();
      break;
  }
  useStore.setState({ dirty: true });
  setStatus(`Template “${t.name}” ready — Save to keep it`, 4000);
}

function apAgeing() {
  const invoices = [
    ['Supplier', 'Invoice', 'Issued', 'Due', 'Amount', 'Days overdue', 'Bucket'],
    ['Sonangol Distribuidora', 'F-2026-0412', daysAgo(75), daysAgo(45), '1250000', '=TODAY()-D2', '=AGE_BUCKET(D2)'],
    ['Unitel', 'F-2026-0433', daysAgo(40), daysAgo(10), '318500', '=TODAY()-D3', '=AGE_BUCKET(D3)'],
    ['ENDE', 'F-2026-0450', daysAgo(125), daysAgo(95), '96200', '=TODAY()-D4', '=AGE_BUCKET(D4)'],
    ['Refriango', 'F-2026-0471', daysAgo(20), '=C5+30', '540000', '=TODAY()-D5', '=AGE_BUCKET(D5)'],
    ['Macon', 'F-2026-0488', daysAgo(100), daysAgo(70), '2200000', '=TODAY()-D6', '=AGE_BUCKET(D6)'],
    ['Angola Cables', 'F-2026-0502', daysAgo(5), '=C7+30', '185000', '=TODAY()-D7', '=AGE_BUCKET(D7)'],
    ['Total', '', '', '', '=SUM(E2:E7)', '', ''],
  ];
  const inv = addTable({ name: 'Invoices', rows: invoices.length, cols: 7, values: invoices, origin: 'import' });
  if (inv) {
    book.apply({ type: 'set_format', table: inv, r0: 1, c0: 4, r1: 7, c1: 4, format: { number_format: '#,##0 "Kz"' } });
    book.apply({ type: 'set_format', table: inv, r0: 1, c0: 2, r1: 7, c1: 3, format: { number_format: 'yyyy-mm-dd' } });
    book.apply({ type: 'set_format', table: inv, r0: 7, c0: 0, r1: 7, c1: 6, format: { bold: true } });
    book.apply({ type: 'set_col_width', table: inv, col: 0, width: 170 });
    book.apply({ type: 'set_col_width', table: inv, col: 4, width: 120 });
  }
  const p = place();
  const summary = [
    ['Ageing summary', '', '', ''],
    ['=AGEING(Invoices::D2:D7, Invoices::E2:E7)', '', '', ''],
    ['', '', '', ''],
    ['', '', '', ''],
    ['', '', '', ''],
    ['', '', '', ''],
    ['', '', '', ''],
    ['', '', '', ''],
    ['Reconciles to ledger', '=CHECK(ROUND(C8 - Invoices::E8, 2) = 0, "Ageing total equals invoice total")', '', ''],
  ];
  const sum = addTable({ name: 'Ageing', rows: summary.length, cols: 4, values: summary, origin: 'import', x: p.x, y: p.y });
  if (sum) {
    book.apply({ type: 'set_header_rows', table: sum, header_rows: 0 });
    book.apply({ type: 'set_format', table: sum, r0: 0, c0: 0, r1: 0, c1: 0, format: { bold: true } });
    book.apply({ type: 'set_format', table: sum, r0: 2, c0: 2, r1: 7, c1: 2, format: { number_format: '#,##0 "Kz"' } });
    book.apply({ type: 'set_format', table: sum, r0: 2, c0: 3, r1: 7, c1: 3, format: { number_format: '0.0%' } });
    book.apply({ type: 'set_col_width', table: sum, col: 0, width: 150 });
    book.apply({ type: 'set_col_width', table: sum, col: 1, width: 90 });
    const meta = getState().tables.get(sum)!;
    book.apply({
      type: 'add_chart',
      chart: {
        ...EMPTY_CHART,
        kind: 'bar',
        exhibit: 'Exhibit 1 — Payables ageing',
        title: 'Half of the open balance is 61–90 days past due',
        subtitle: 'Open supplier invoices by days overdue, AOA',
        source: 'Invoices table; ageing as of today',
        categories: 'Ageing::A3:A7',
        series: [{ name: 'Amount', range: 'Ageing::C3:C7' }],
        highlight: 3,
        x: meta.x + layoutOf(meta).width + 40,
        y: meta.y,
        w: 560,
        h: 400,
      },
    });
  }
}

function bankRec() {
  const ledger = [
    ['Reference', 'Date', 'Description', 'Amount'],
    ['TRF-1001', daysAgo(9), 'Customer receipt — Luanda Sul', '4500000'],
    ['TRF-1002', daysAgo(8), 'Supplier payment — Macon', '-2200000'],
    ['CHQ-221', daysAgo(7), 'Cheque — rent', '-850000'],
    ['TRF-1003', daysAgo(5), 'Customer receipt — Benguela', '1275000'],
    ['FEE-07', daysAgo(2), 'Bank fees', '-12500'],
    ['TRF-1004', daysAgo(1), 'Customer receipt — Huambo', '640000'],
    ['Total', '', '', '=SUM(D2:D7)'],
  ];
  const statement = [
    ['Reference', 'Date', 'Amount'],
    ['TRF-1001', daysAgo(8), '4500000'],
    ['TRF-1002', daysAgo(8), '-2200000'],
    ['TRF-1003', daysAgo(4), '1275000'],
    ['FEE-07', daysAgo(2), '-12750'],
    ['INT-09', daysAgo(1), '3100'],
    ['Total', '', '=SUM(C2:C6)'],
  ];
  const l = addTable({ name: 'Ledger', rows: ledger.length, cols: 4, values: ledger, origin: 'import' });
  const p1 = place();
  const s = addTable({ name: 'Statement', rows: statement.length, cols: 3, values: statement, origin: 'import', x: p1.x, y: p1.y });
  for (const [id, col, last] of [
    [l, 3, 7],
    [s, 2, 6],
  ] as [number | undefined, number, number][]) {
    if (!id) continue;
    book.apply({ type: 'set_format', table: id, r0: 1, c0: col, r1: last, c1: col, format: { number_format: '#,##0.00 "Kz"' } });
    book.apply({ type: 'set_format', table: id, r0: 1, c0: 1, r1: last, c1: 1, format: { number_format: 'yyyy-mm-dd' } });
    book.apply({ type: 'set_format', table: id, r0: last, c0: 0, r1: last, c1: col, format: { bold: true } });
  }
  if (l) book.apply({ type: 'set_col_width', table: l, col: 2, width: 220 });
  const p2 = place();
  const rec = [
    ['Reconciliation', '', '', '', '', ''],
    ['Tolerance', '0.01', '', '', '', ''],
    ['=RECONCILE(Ledger::A2:D7, Statement::A2:C6, B2)', '', '', '', '', ''],
    ['', '', '', '', '', ''],
    ['', '', '', '', '', ''],
    ['', '', '', '', '', ''],
    ['', '', '', '', '', ''],
    ['', '', '', '', '', ''],
    ['', '', '', '', '', ''],
    ['', '', '', '', '', ''],
    ['', '', '', '', '', ''],
    ['Unmatched items', '=COUNTIF(E4:E11, "<>Matched")', '', '', '', ''],
    ['Difference to explain', '=Ledger::D8 - Statement::C7', '', '', '', ''],
    ['All matched', '=CHECK(B12 = 0, "Every ledger line matches the statement")', '', '', '', ''],
  ];
  const r = addTable({ name: 'Reconciliation', rows: rec.length, cols: 6, values: rec, origin: 'import', x: p2.x, y: p2.y });
  if (r) {
    book.apply({ type: 'set_header_rows', table: r, header_rows: 0 });
    book.apply({ type: 'set_format', table: r, r0: 0, c0: 0, r1: 0, c1: 0, format: { bold: true } });
    book.apply({ type: 'set_format', table: r, r0: 2, c0: 0, r1: 2, c1: 4, format: { bold: true } });
    book.apply({ type: 'set_format', table: r, r0: 3, c0: 1, r1: 12, c1: 3, format: { number_format: '#,##0.00' } });
    book.apply({ type: 'set_col_width', table: r, col: 0, width: 170 });
    book.apply({
      type: 'set_cond_formats',
      table: r,
      rules: [
        { r0: 3, c0: 4, r1: 10, c1: 4, kind: 'text', op: 'eq', values: ['Matched'], fill: '#dcfce7' },
        { r0: 3, c0: 4, r1: 10, c1: 4, kind: 'text', op: 'ne', values: ['Matched'], fill: '#fee2e2' },
      ],
    });
  }
}

function treasury() {
  const fx = [
    ['Date', 'From', 'To', 'Rate'],
    [daysAgo(30), 'USD', 'AOA', '915'],
    [daysAgo(1), 'USD', 'AOA', '920'],
    [daysAgo(1), 'EUR', 'USD', '1.08'],
    [daysAgo(1), 'ZAR', 'USD', '0.056'],
  ];
  const f = addTable({ name: 'FX', rows: fx.length, cols: 4, values: fx, origin: 'import' });
  if (f) book.apply({ type: 'set_format', table: f, r0: 1, c0: 0, r1: 4, c1: 0, format: { number_format: 'yyyy-mm-dd' } });
  const p1 = place();
  const positions = [
    ['Bank', 'Account', 'Currency', 'Balance', 'In AOA', 'Share'],
    ['BAI', '0012-3456', 'AOA', '185000000', '=FX(D2, C2, "AOA")', '=E2/$E$8'],
    ['BFA', '0098-1122', 'USD', '240000', '=FX(D3, C3, "AOA")', '=E3/$E$8'],
    ['Standard Bank', '7731-0040', 'USD', '95000', '=FX(D4, C4, "AOA")', '=E4/$E$8'],
    ['BIC', '4400-7781', 'EUR', '60000', '=FX(D5, C5, "AOA")', '=E5/$E$8'],
    ['Standard Bank ZA', '3300-2201', 'ZAR', '1500000', '=FX(D6, C6, "AOA")', '=E6/$E$8'],
    ['Petty cash', '—', 'AOA', '2500000', '=FX(D7, C7, "AOA")', '=E7/$E$8'],
    ['Total', '', '', '', '=SUM(E2:E7)', '=SUM(F2:F7)'],
  ];
  const pos = addTable({ name: 'Positions', rows: positions.length, cols: 6, values: positions, origin: 'import', x: p1.x, y: p1.y });
  if (pos) {
    book.apply({ type: 'set_format', table: pos, r0: 1, c0: 3, r1: 7, c1: 3, format: { number_format: '#,##0' } });
    book.apply({ type: 'set_format', table: pos, r0: 1, c0: 4, r1: 7, c1: 4, format: { number_format: '#,##0 "Kz"' } });
    book.apply({ type: 'set_format', table: pos, r0: 1, c0: 5, r1: 7, c1: 5, format: { number_format: '0.0%' } });
    book.apply({ type: 'set_format', table: pos, r0: 7, c0: 0, r1: 7, c1: 5, format: { bold: true } });
    book.apply({ type: 'set_col_width', table: pos, col: 0, width: 150 });
    book.apply({ type: 'set_col_width', table: pos, col: 4, width: 150 });
    const meta = getState().tables.get(pos)!;
    book.apply({
      type: 'add_chart',
      chart: {
        ...EMPTY_CHART,
        kind: 'hbar',
        exhibit: 'Exhibit 1 — Cash position',
        title: 'Half of the cash sits in USD accounts',
        subtitle: 'Balances converted at the latest FX rates, AOA',
        source: 'Positions and FX tables; bank statements as of today',
        categories: 'Positions::A2:A7',
        series: [{ name: 'In AOA', range: 'Positions::E2:E7' }],
        highlight: 1,
        stat_cards: true,
        x: meta.x + layoutOf(meta).width + 40,
        y: meta.y,
        w: 560,
        h: 380,
      },
    });
  }
  const p2 = place();
  const checks = [
    ['Controls', ''],
    ['Rates are recent', '=CHECK(MAX(FX::A2:A5) >= TODAY()-7, "FX rates not older than a week")'],
    ['Shares add up', '=CHECK(ROUND(Positions::F8, 6) = 1, "Shares sum to 100%")'],
    ['Primavera pending payables (SQL cell below)', ''],
    ['-- Replace with your Primavera connection and query, e.g.\n-- SELECT Entidade, Documento, DataVencimento, ValorPendente FROM Pendentes WHERE TipoEntidade = \'F\'\nSELECT 1 AS Entidade, \'example\' AS Documento, 0 AS ValorPendente', ''],
  ];
  const c = addTable({ name: 'Controls', rows: 8, cols: 4, values: checks, origin: 'import', x: p2.x, y: p2.y });
  if (c) {
    book.apply({ type: 'set_header_rows', table: c, header_rows: 0 });
    book.apply({ type: 'set_format', table: c, r0: 0, c0: 0, r1: 0, c1: 0, format: { bold: true } });
    book.apply({ type: 'set_col_width', table: c, col: 0, width: 260 });
    book.apply({ type: 'set_cell', table: c, row: 4, col: 0, input: checks[4][0], kind: 'sql' }, { silent: true });
  }
}

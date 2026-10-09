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
  // reference workbooks: fixed data with independently established expected results (e2e/reference.py asserts them exactly)
  { id: 'ref-landed-cost', name: 'Reference — vehicle landed cost by VIN', description: 'FOB, freight and insurance allocated by value share with the rounding absorbed explicitly, customs value at the BNA rate of the customs date, duty and fees per vehicle; checks for a missing rate and a duplicate VIN.' },
  { id: 'ref-bank-rec', name: 'Reference — bank reconciliation', description: 'Ledger and statement matched on normalised identifiers (leading zeros kept), a reversal pair, a receipt in transit, bank fee and interest, and a duplicate statement posting; the explained items must equal the difference exactly.' },
  { id: 'ref-cash-13w', name: 'Reference — 13-week cash forecast', description: 'Opening, movements and closing per week chained across a leap day, a collection-rate scenario input, and checks that the chain and the totals stay consistent.' },
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
    case 'ref-landed-cost':
      refLandedCost();
      break;
    case 'ref-bank-rec':
      refBankRec();
      break;
    case 'ref-cash-13w':
      refCash13w();
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

// ---------------------------------------------------------------------------------------------
// Reference workbooks. Fixed dates, sanitised data, every basis stated in the sheet; the checks
// include two that fail on purpose (a duplicate VIN, a duplicate statement posting) so that
// detection is part of what the reference proves. e2e/reference.py asserts the exact outcomes.
// ---------------------------------------------------------------------------------------------

const money = (id: number, r0: number, c0: number, r1: number, c1: number, fmt = '#,##0.00') => book.apply({ type: 'set_format', table: id, r0, c0, r1, c1, format: { number_format: fmt } });
const bold = (id: number, r0: number, c0: number, r1: number, c1: number) => book.apply({ type: 'set_format', table: id, r0, c0, r1, c1, format: { bold: true } });
const width = (id: number, col: number, w: number) => book.apply({ type: 'set_col_width', table: id, col, width: w });

function refLandedCost() {
  // FX basis: BNA reference rate on the customs clearance date (not the invoice date); EUR and JPY
  // reach AOA through USD; ZAR has no rate on purpose.
  const fx = [
    ['Date', 'From', 'To', 'Rate', 'Basis'],
    ['2026-01-15', 'USD', 'AOA', '912.5', 'BNA reference'],
    ['2026-02-10', 'USD', 'AOA', '920', 'BNA reference'],
    ['2026-02-10', 'EUR', 'USD', '1.085', 'BNA reference'],
    ['2026-02-10', 'JPY', 'USD', '0.0067', 'BNA reference'],
  ];
  const f = addTable({ name: 'FX', rows: fx.length, cols: 5, values: fx, origin: 'import' });
  if (f) book.apply({ type: 'set_format', table: f, r0: 1, c0: 0, r1: 4, c1: 0, format: { number_format: 'yyyy-mm-dd' } });
  const p1 = place();
  const shipments = [
    ['Shipment', 'Invoice currency', 'Customs date', 'Freight USD', 'Insurance USD', 'FOB total (invoice ccy)', 'Allocated freight', 'Allocated insurance'],
    ['SH-001', 'USD', '2026-02-10', '4200', '650', '=SUMIF(Vehicles::B2:B7, A2, Vehicles::D2:D7)', '=SUMIF(Vehicles::B2:B7, A2, Vehicles::F2:F7)', '=SUMIF(Vehicles::B2:B7, A2, Vehicles::G2:G7)'],
    ['SH-002', 'EUR', '2026-02-10', '3100', '420', '=SUMIF(Vehicles::B2:B7, A3, Vehicles::D2:D7)', '=SUMIF(Vehicles::B2:B7, A3, Vehicles::F2:F7)', '=SUMIF(Vehicles::B2:B7, A3, Vehicles::G2:G7)'],
    ['SH-003', 'ZAR', '2026-02-10', '1800', '300', '=SUMIF(Vehicles::B2:B7, A4, Vehicles::D2:D7)', '=SUMIF(Vehicles::B2:B7, A4, Vehicles::F2:F7)', '=SUMIF(Vehicles::B2:B7, A4, Vehicles::G2:G7)'],
  ];
  const sh = addTable({ name: 'Shipments', rows: shipments.length, cols: 8, values: shipments, origin: 'import', x: p1.x, y: p1.y });
  if (sh) {
    money(sh, 1, 3, 3, 7);
    book.apply({ type: 'set_format', table: sh, r0: 1, c0: 2, r1: 3, c1: 2, format: { number_format: 'yyyy-mm-dd' } });
  }
  // allocation: share of FOB within the shipment, rounded to 2 dp per vehicle; the last vehicle of a
  // shipment absorbs the rounding difference so that the allocation sums exactly to the invoice
  const V = (r: number, last: boolean) => {
    const row = r + 1; // sheet row of this vehicle
    const share = `=ROUND(D${row} / SUMIF($B$2:$B$7, B${row}, $D$2:$D$7), 6)`;
    const freight = last ? `=XLOOKUP(B${row}, Shipments::A2:A4, Shipments::D2:D4) - SUMIFS($F$2:$F$${row - 1}, $B$2:$B$${row - 1}, B${row})` : `=ROUND(XLOOKUP(B${row}, Shipments::A2:A4, Shipments::D2:D4) * E${row}, 2)`;
    const insurance = last ? `=XLOOKUP(B${row}, Shipments::A2:A4, Shipments::E2:E4) - SUMIFS($G$2:$G$${row - 1}, $B$2:$B$${row - 1}, B${row})` : `=ROUND(XLOOKUP(B${row}, Shipments::A2:A4, Shipments::E2:E4) * E${row}, 2)`;
    return [share, freight, insurance];
  };
  const vehicles = [
    ['VIN', 'Shipment', 'Model', 'FOB (invoice ccy)', 'FOB share', 'Freight USD', 'Insurance USD', 'FOB USD', 'CIF USD', 'Rate USD→AOA (customs date)', 'CIF AOA', 'Duty %', 'Duty AOA', 'Fees AOA', 'Landed cost AOA', 'Status'],
    ['KMHJ381ABNU012345', 'SH-001', 'Tucson', '24500', ...V(1, false)],
    ['KMHJ381ABNU012346', 'SH-001', 'Tucson', '24500', ...V(2, false)],
    ['KMHJ381ABNU012347', 'SH-001', 'Creta', '18900', ...V(3, true)],
    ['WVWZZZ1KZBW123456', 'SH-002', 'Golf', '21000', ...V(4, false)],
    ['WVWZZZ1KZBW123456', 'SH-002', 'Golf', '21000', ...V(5, true)],
    ['AHTEB3CD700012345', 'SH-003', 'Hilux', '540000', ...V(6, true)],
  ];
  for (let i = 1; i < vehicles.length; i++) {
    const row = i + 1;
    vehicles[i].push(
      `=IFERROR(ROUND(FX(D${row}, XLOOKUP(B${row}, Shipments::A2:A4, Shipments::B2:B4), "USD", XLOOKUP(B${row}, Shipments::A2:A4, Shipments::C2:C4)), 2), "no rate")`, // FOB USD
      `=IF(ISNUMBER(H${row}), ROUND(H${row} + F${row} + G${row}, 2), "no rate")`, // CIF USD
      `=IFERROR(FXRATE("USD", "AOA", XLOOKUP(B${row}, Shipments::A2:A4, Shipments::C2:C4)), "no rate")`, // rate
      `=IF(ISNUMBER(I${row}), ROUND(I${row} * J${row}, 2), "no rate")`, // CIF AOA
      `=XLOOKUP(C${row}, Tariff::A2:A5, Tariff::B2:B5)`, // duty %
      `=IF(ISNUMBER(K${row}), ROUND(K${row} * L${row}, 2), "no rate")`, // duty AOA
      '350000', // fees
      `=IF(ISNUMBER(K${row}), ROUND(K${row} + M${row} + N${row}, 0), "no rate")`, // landed, rounded to the kwanza
      `=IF(COUNTIF($A$2:$A$7, A${row}) > 1, "duplicate VIN", IF(ISNUMBER(K${row}), "ok", "no rate"))`,
    );
  }
  vehicles.push(['Total', '', '', '', '=SUM(E2:E7)', '=SUM(F2:F7)', '=SUM(G2:G7)', '=SUM(H2:H7)', '=SUM(I2:I7)', '', '=SUM(K2:K7)', '', '=SUM(M2:M7)', '=SUM(N2:N7)', '=SUM(O2:O7)', '']);
  const tariff = [
    ['Model', 'Duty %', 'Note'],
    ['Tucson', '0.2', 'passenger, > 1500 cc'],
    ['Creta', '0.2', 'passenger, > 1500 cc'],
    ['Golf', '0.2', 'passenger, > 1500 cc'],
    ['Hilux', '0.1', 'light commercial'],
  ];
  const p2 = place();
  const tf = addTable({ name: 'Tariff', rows: tariff.length, cols: 3, values: tariff, origin: 'import', x: p2.x, y: p2.y });
  if (tf) money(tf, 1, 1, 4, 1, '0%');
  const p3 = place();
  const v = addTable({ name: 'Vehicles', rows: vehicles.length, cols: 16, values: vehicles, origin: 'import', x: p3.x, y: p3.y });
  if (v) {
    money(v, 1, 3, 7, 3);
    money(v, 1, 4, 6, 4, '0.000000');
    money(v, 1, 5, 7, 10);
    money(v, 1, 11, 6, 11, '0%');
    money(v, 1, 12, 7, 13);
    money(v, 1, 14, 7, 14, '#,##0 "Kz"');
    bold(v, 7, 0, 7, 15);
    width(v, 0, 170);
  }
  const p4 = place();
  const checks = [
    ['Reference checks', ''],
    ['Basis', 'Customs value = CIF at the BNA reference rate of the customs clearance date; freight and insurance allocated by FOB share within the shipment (6 dp), rounding absorbed by the last vehicle; duty per model; fees fixed per vehicle; landed cost rounded to the kwanza; IVA excluded (recoverable).'],
    ['Allocations tie to the invoices', '=CHECK(AND(ROUND(Shipments::G2 - Shipments::D2, 2) = 0, ROUND(Shipments::G3 - Shipments::D3, 2) = 0, ROUND(Shipments::H2 - Shipments::E2, 2) = 0, ROUND(Shipments::H3 - Shipments::E3, 2) = 0), "Freight and insurance fully allocated per shipment")'],
    ['Landed cost ties to its components', '=CHECK(ABS(Vehicles::O8 - (Vehicles::K8 + Vehicles::M8 + SUMIF(Vehicles::O2:O7, ">0", Vehicles::N2:N7))) <= 0.5 * COUNT(Vehicles::O2:O7), "Landed total = CIF + duty + fees within kwanza rounding")'],
    ['Every vehicle has a rate', '=CHECK(COUNTIF(Vehicles::P2:P7, "no rate") = 0, "Every vehicle has an FX rate on its customs date")'],
    ['No duplicate VINs', '=CHECK(COUNTUNIQUE(Vehicles::A2:A7) = COUNTA(Vehicles::A2:A7), "VINs are unique")'],
    ['Vehicles priced', '=COUNTIF(Vehicles::P2:P7, "ok")'],
    ['Landed cost, priced vehicles', '=Vehicles::O8'],
  ];
  const c = addTable({ name: 'Checks', rows: checks.length, cols: 2, values: checks, origin: 'import', x: p4.x, y: p4.y });
  if (c) {
    book.apply({ type: 'set_header_rows', table: c, header_rows: 0 });
    bold(c, 0, 0, 0, 0);
    width(c, 0, 230);
    width(c, 1, 520);
    money(c, 7, 1, 7, 1, '#,##0 "Kz"');
  }
}

function refBankRec() {
  // identifiers: some references are numeric-looking with leading zeros; Key normalises both sides
  const key = (col: string, row: number) => `=IF(ISNUMBER(${col}${row}), RIGHT("000000" & ${col}${row}, 6), ${col}${row})`;
  const ledger = [
    ['Reference', 'Key', 'Date', 'Description', 'Amount'],
    ['TRF-1001', key('A', 2), '2026-03-02', 'Customer receipt — Luanda Sul', '4500000'],
    ['TRF-1002', key('A', 3), '2026-03-03', 'Supplier payment — Macon', '-2200000'],
    ['="000123"', key('A', 4), '2026-03-04', 'Cheque 000123 — rent', '-850000'],
    ['TRF-1003', key('A', 5), '2026-03-05', 'Customer receipt — Benguela', '1275000'],
    ['REV-1', key('A', 6), '2026-03-06', 'Posting in error', '318500'],
    ['REV-1R', key('A', 7), '2026-03-06', 'Reversal of REV-1', '-318500'],
    ['TRF-1004', key('A', 8), '2026-03-09', 'Customer receipt — Huambo (in transit)', '640000'],
    ['Total', '', '', '', '=SUM(E2:E8)'],
  ];
  const statement = [
    ['Reference', 'Key', 'Date', 'Amount', 'Times posted'],
    ['TRF-1001', key('A', 2), '2026-03-03', '4500000', '=SUMPRODUCT(($B$2:$B$8 = B2) * 1)'],
    ['TRF-1002', key('A', 3), '2026-03-03', '-2200000', '=SUMPRODUCT(($B$2:$B$8 = B3) * 1)'],
    ['TRF-1002', key('A', 4), '2026-03-03', '-2200000', '=SUMPRODUCT(($B$2:$B$8 = B4) * 1)'],
    ['000123', key('A', 5), '2026-03-05', '-850000', '=SUMPRODUCT(($B$2:$B$8 = B5) * 1)'],
    ['TRF-1003', key('A', 6), '2026-03-05', '1275000', '=SUMPRODUCT(($B$2:$B$8 = B6) * 1)'],
    ['FEE-03', key('A', 7), '2026-03-09', '-12750', '=SUMPRODUCT(($B$2:$B$8 = B7) * 1)'],
    ['INT-03', key('A', 8), '2026-03-09', '3100', '=SUMPRODUCT(($B$2:$B$8 = B8) * 1)'],
    ['Total', '', '', '=SUM(D2:D8)', ''],
  ];
  const l = addTable({ name: 'Ledger', rows: ledger.length, cols: 5, values: ledger, origin: 'import' });
  const p1 = place();
  const st = addTable({ name: 'Statement', rows: statement.length, cols: 5, values: statement, origin: 'import', x: p1.x, y: p1.y });
  if (l) {
    money(l, 1, 4, 8, 4);
    book.apply({ type: 'set_format', table: l, r0: 1, c0: 2, r1: 7, c1: 2, format: { number_format: 'yyyy-mm-dd' } });
    bold(l, 8, 0, 8, 4);
    width(l, 3, 260);
  }
  if (st) {
    money(st, 1, 3, 8, 3);
    book.apply({ type: 'set_format', table: st, r0: 1, c0: 2, r1: 7, c1: 2, format: { number_format: 'yyyy-mm-dd' } });
    bold(st, 8, 0, 8, 3);
  }
  const p2 = place();
  // one row per key on either side: amounts summed per side, difference, status
  const match = [
    ['Key', 'Ledger', 'Statement', 'Difference', 'Status'],
  ];
  const keys = ['TRF-1001', 'TRF-1002', '000123', 'TRF-1003', 'REV-1', 'REV-1R', 'TRF-1004', 'FEE-03', 'INT-03'];
  keys.forEach((k, i) => {
    const row = i + 2;
    // exact text comparison on the normalised key (SUMIF would read "000123" as the number 123)
    match.push([`="${k}"`, `=SUMPRODUCT((Ledger::B2:B8 = A${row}) * Ledger::E2:E8)`, `=SUMPRODUCT((Statement::B2:B8 = A${row}) * Statement::D2:D8)`, `=ROUND(B${row} - C${row}, 2)`, `=IF(D${row} = 0, "Matched", IF(B${row} = 0, "Only in statement", IF(C${row} = 0, "Only in ledger", "Different")))`]);
  });
  match.push(['Total', '=SUM(B2:B10)', '=SUM(C2:C10)', '=ROUND(B11 - C11, 2)', '']);
  const m = addTable({ name: 'Matching', rows: match.length, cols: 5, values: match, origin: 'import', x: p2.x, y: p2.y });
  if (m) {
    money(m, 1, 1, 11, 3);
    bold(m, 11, 0, 11, 4);
    book.apply({
      type: 'set_cond_formats',
      table: m,
      rules: [
        { r0: 1, c0: 4, r1: 9, c1: 4, kind: 'text', op: 'eq', values: ['Matched'], fill: '#dcfce7' },
        { r0: 1, c0: 4, r1: 9, c1: 4, kind: 'text', op: 'ne', values: ['Matched'], fill: '#fee2e2' },
      ],
    });
  }
  const p3 = place();
  const explained = [
    ['Explained items', 'Amount', 'Basis'],
    ['Bank fee not yet in ledger', '=-SUMIF(Statement::B2:B8, "FEE-03", Statement::D2:D8)', 'statement only'],
    ['Interest not yet in ledger', '=-SUMIF(Statement::B2:B8, "INT-03", Statement::D2:D8)', 'statement only'],
    ['Receipt in transit', '=SUMIF(Ledger::B2:B8, "TRF-1004", Ledger::E2:E8)', 'ledger only'],
    ['Duplicate statement posting', '=-SUMIF(Statement::B2:B8, "TRF-1002", Statement::D2:D8) + SUMIF(Ledger::B2:B8, "TRF-1002", Ledger::E2:E8)', 'statement posted twice'],
    ['Posting and reversal', '=SUMIF(Ledger::B2:B8, "REV-1", Ledger::E2:E8) + SUMIF(Ledger::B2:B8, "REV-1R", Ledger::E2:E8)', 'nets to zero in the ledger'],
    ['Total explained', '=SUM(B2:B6)', ''],
    ['Difference (ledger − statement)', '=Matching::D11', ''],
    ['Unexplained', '=ROUND(B8 - B7, 2)', ''],
    ['Reconciled', '=CHECK(B9 = 0, "Explained items equal the difference exactly")', ''],
    ['Leading zeros kept', '=CHECK(Matching::E4 = "Matched", "Cheque 000123 matches across sides")', ''],
    ['No duplicate postings', '=CHECK(MAX(Statement::E2:E8) = 1, "No statement reference is posted twice")', ''],
  ];
  const e = addTable({ name: 'Explained', rows: explained.length, cols: 3, values: explained, origin: 'import', x: p3.x, y: p3.y });
  if (e) {
    money(e, 1, 1, 8, 1);
    bold(e, 6, 0, 8, 1);
    width(e, 0, 250);
    width(e, 2, 220);
  }
}

function refCash13w() {
  // weeks start on Monday 2028-02-14: week 3 (2028-02-28 … 03-05) contains the leap day
  const weeks = 13;
  const header = ['AOA', ...Array.from({ length: weeks }, (_, i) => `W${i + 1}`)];
  const col = (i: number) => String.fromCharCode(66 + i); // B..N
  const row = (label: string, f: (i: number) => string) => [label, ...Array.from({ length: weeks }, (_, i) => f(i))];
  const sheet = [
    header,
    row('Week starting', (i) => (i === 0 ? '2028-02-14' : `=${col(i - 1)}2 + 7`)),
    row('Opening cash', (i) => (i === 0 ? '=Inputs::B2' : `=${col(i - 1)}12`)),
    row('Customer receipts (plan)', (i) => String([9500000, 8200000, 7800000, 10400000, 9100000, 8800000, 12000000, 9300000, 8700000, 9900000, 10100000, 8600000, 11200000][i])),
    row('Customer receipts (expected)', (i) => `=ROUND(${col(i)}4 * Inputs::B3, 0)`),
    row('Other receipts', (i) => String([0, 0, 1500000, 0, 0, 0, 0, 2000000, 0, 0, 0, 0, 0][i])),
    row('Supplier payments', (i) => String([-6200000, -5900000, -6100000, -7400000, -6000000, -5800000, -8300000, -6400000, -6000000, -6900000, -7100000, -5700000, -7600000][i])),
    row('Payroll', (i) => String([0, 0, -4800000, 0, 0, 0, -4800000, 0, 0, 0, -4800000, 0, 0][i])),
    row('Taxes', (i) => String([0, -2650000, 0, 0, 0, -2650000, 0, 0, 0, -2650000, 0, 0, 0][i])),
    row('Capex', (i) => String([0, 0, 0, -3000000, 0, 0, 0, 0, 0, 0, 0, -3000000, 0][i])),
    row('Net movement', (i) => `=${col(i)}5 + ${col(i)}6 + ${col(i)}7 + ${col(i)}8 + ${col(i)}9 + ${col(i)}10`),
    row('Closing cash', (i) => `=${col(i)}3 + ${col(i)}11`),
    row('Chain holds', (i) => (i === 0 ? '=TRUE' : `=${col(i)}3 = ${col(i - 1)}12`)),
  ];
  const inputs = [
    ['Input', 'Value', 'Note'],
    ['Opening cash W1', '125000000', 'bank balances 2028-02-14, AOA'],
    ['Collection rate', '0.9', 'share of planned receipts expected (scenario)'],
    ['Minimum cash', '20000000', 'covenant / comfort level'],
  ];
  const inp = addTable({ name: 'Inputs', rows: inputs.length, cols: 3, values: inputs, origin: 'import' });
  if (inp) {
    money(inp, 1, 1, 1, 1, '#,##0');
    money(inp, 2, 1, 2, 1, '0%');
    money(inp, 3, 1, 3, 1, '#,##0');
    width(inp, 2, 280);
  }
  const p1 = place();
  const fc = addTable({ name: 'Forecast', rows: sheet.length, cols: weeks + 1, values: sheet, origin: 'import', x: p1.x, y: p1.y });
  if (fc) {
    book.apply({ type: 'set_format', table: fc, r0: 1, c0: 1, r1: 1, c1: weeks, format: { number_format: 'd mmm' } });
    money(fc, 2, 1, 11, weeks, '#,##0');
    bold(fc, 11, 0, 11, weeks);
    width(fc, 0, 220);
  }
  const p2 = place();
  const checks = [
    ['Reference checks', ''],
    ['Closing ties to the chain', '=CHECK(Forecast::N12 = Inputs::B2 + SUM(Forecast::B11:N11), "Closing W13 = opening W1 + sum of net movements")'],
    ['Every week opens on the previous close', '=CHECK(COUNTIF(Forecast::B13:N13, FALSE) = 0, "Each week opens on the previous close")'],
    ['Leap day in week 3', '=CHECK(AND(DATE(2028,2,29) >= Forecast::D2, DATE(2028,2,29) <= Forecast::D2 + 6), "29 February 2028 falls in week 3")'],
    ['Minimum cash respected', '=CHECK(MIN(Forecast::B12:N12) >= Inputs::B4, "Closing cash stays above the minimum in every week")'],
    ['Lowest closing cash', '=MIN(Forecast::B12:N12)'],
    ['Closing cash W13', '=Forecast::N12'],
  ];
  const c = addTable({ name: 'Checks', rows: checks.length, cols: 2, values: checks, origin: 'import', x: p2.x, y: p2.y });
  if (c) {
    book.apply({ type: 'set_header_rows', table: c, header_rows: 0 });
    bold(c, 0, 0, 0, 0);
    width(c, 0, 260);
    width(c, 1, 420);
    money(c, 5, 1, 6, 1, '#,##0 "Kz"');
  }
}

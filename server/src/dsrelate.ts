// Related data: does another dataset of the same client continue this one (same layout, the next period),
// overlap it (the same documents again), or refer to it (a receipts file naming these invoices)? Each
// answer is measured — shared distinct values per pair of key columns, label overlap, period order — and
// becomes a suggested merge analysis that the person can run: append the series, or reconcile.
import type { DatabaseSync } from 'node:sqlite';
import { renameSync, rmSync } from 'node:fs';
import type { ColumnMeta, Roles } from './dssteps.js';

export interface RelateSide {
  id: string;
  name: string;
  run: string;
  columns: ColumnMeta[];
  roles: Roles;
  rows: number;
}
export interface RelateInput {
  base: RelateSide;
  others: RelateSide[];
}
export interface KeyMatch {
  a: string;
  aLabel: string;
  b: string;
  bLabel: string;
  common: number;
  aDistinct: number;
  bDistinct: number;
  /** a's values are unique per row (a document number, not a customer) */
  aUnique: boolean;
}
export interface Suggestion {
  kind: 'append' | 'reconcile' | 'compare';
  title: string;
  text: string;
  key?: { a: string; b: string };
  score: number;
}
export interface Relation {
  other: string;
  name: string;
  layout: 'same' | 'similar' | 'different';
  labelOverlap: number;
  period: { a: [string | null, string | null]; b: [string | null, string | null]; order: 'before' | 'after' | 'overlap' | 'unknown' };
  keys: KeyMatch[];
  suggestions: Suggestion[];
}
export interface RelateOutput {
  relations: Relation[];
  ms: number;
}

const q = (k: string) => `"${k.replace(/"/g, '')}"`;
const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const fmt = (n: number) => n.toLocaleString('en-GB');
const money = (v: number, unit?: string) => `${Math.round(v).toLocaleString('en-GB')}${unit ? ` ${unit}` : ''}`;
const signed = (v: number, unit?: string) => `${Math.round(v) > 0 ? '+' : ''}${money(v, unit)}`;
/** SQL text of a value, whole numbers without the “.0” SQLite gives a REAL */
const txt = (x: string) => `(CASE WHEN typeof(${x}) = 'real' AND ${x} = CAST(${x} AS INTEGER) THEN CAST(CAST(${x} AS INTEGER) AS TEXT) ELSE CAST(${x} AS TEXT) END)`;
/** labels of document-number columns (Nº interno, Nº documento, invoice no., ref…) */
const DOC_LABEL = /n[º°o]\b|n[º°]|num|doc|fact|fatura|factura|invoice|agt|ref/i;

function candidates(db: DatabaseSync, schema: string, s: RelateSide): ColumnMeta[] {
  // the schema goes in as the pragma's argument: “b.pragma_table_info('work')” would read the first attached “work”
  const present = new Set((db.prepare(`SELECT name FROM pragma_table_info('work', ?)`).all(schema) as { name: string }[]).map((r) => r.name));
  const roleKeys = new Set([s.roles.customerCode, s.roles.id, s.roles.customer].filter(Boolean) as string[]);
  return s.columns
    .filter((c) => present.has(c.key) && (c.type === 'identifier' || roleKeys.has(c.key) || (c.type === 'number' && DOC_LABEL.test(c.label))))
    .sort((a, b) => Number(roleKeys.has(b.key)) - Number(roleKeys.has(a.key)))
    .slice(0, 8);
}

/** distinct normalised values of a column, in a temp table (letters and digits only, upper case: “FT 2026/12” = “ft2026 12”) */
function distinctOf(db: DatabaseSync, schema: string, key: string, name: string): { n: number; unique: boolean; rows: number } {
  db.exec(`DROP TABLE IF EXISTS temp.${name}; CREATE TEMP TABLE ${name} (v TEXT PRIMARY KEY) WITHOUT ROWID`);
  db.exec(`INSERT OR IGNORE INTO temp.${name} SELECT upper(gw_key(${q(key)})) FROM ${schema}.work WHERE ${q(key)} IS NOT NULL AND gw_key(${q(key)}) <> '' LIMIT 400000`);
  const n = (db.prepare(`SELECT count(*) n FROM temp.${name}`).get() as { n: number }).n;
  const rows = (db.prepare(`SELECT count(*) n FROM ${schema}.work WHERE ${q(key)} IS NOT NULL`).get() as { n: number }).n;
  return { n, unique: rows > 0 && n >= rows * 0.98, rows };
}

function periodOf(db: DatabaseSync, schema: string, s: RelateSide): [string | null, string | null] {
  if (!s.roles.date) return [null, null];
  try {
    const r = db.prepare(`SELECT min(${q(s.roles.date)}) a, max(${q(s.roles.date)}) b FROM ${schema}.work`).get() as { a: string | null; b: string | null };
    return [r.a, r.b];
  } catch {
    return [null, null];
  }
}

export function relate(input: RelateInput, open: (p: string) => DatabaseSync): RelateOutput {
  const t0 = Date.now();
  const db = open(':memory:');
  const relations: Relation[] = [];
  try {
    db.function('gw_key', { deterministic: true }, (v: unknown) => (v === null || v === undefined ? null : String(v).normalize('NFD').replace(/[^\p{L}\p{N}]+/gu, '')) as never);
    db.prepare('ATTACH DATABASE ? AS a').run(input.base.run);
    const aCols = candidates(db, 'a', input.base);
    const aStats = new Map(aCols.map((c, i) => [c.key, { ...distinctOf(db, 'a', c.key, `a${i}`), t: `a${i}` }]));
    const aPeriod = periodOf(db, 'a', input.base);
    const aLabels = new Set(input.base.columns.map((c) => norm(c.source?.header ?? c.label)));
    for (const other of input.others) {
      db.prepare('ATTACH DATABASE ? AS b').run(other.run);
      try {
        const bCols = candidates(db, 'b', other);
        const keys: KeyMatch[] = [];
        bCols.forEach((bc, j) => {
          const bs = distinctOf(db, 'b', bc.key, `b${j}`);
          for (const ac of aCols) {
            const as = aStats.get(ac.key)!;
            if (!as.n || !bs.n) continue;
            const common = (db.prepare(`SELECT count(*) n FROM temp.${as.t} x JOIN temp.b${j} y ON y.v = x.v`).get() as { n: number }).n;
            if (common >= Math.max(3, Math.min(as.n, bs.n) * 0.05)) keys.push({ a: ac.key, aLabel: ac.label, b: bc.key, bLabel: bc.label, common, aDistinct: as.n, bDistinct: bs.n, aUnique: as.unique });
          }
        });
        keys.sort((x, y) => y.common / Math.min(y.aDistinct, y.bDistinct) - x.common / Math.min(x.aDistinct, x.bDistinct));
        const bLabels = new Set(other.columns.map((c) => norm(c.source?.header ?? c.label)));
        const inter = [...aLabels].filter((l) => bLabels.has(l)).length;
        const labelOverlap = inter / Math.max(1, Math.max(aLabels.size, bLabels.size));
        const layout = labelOverlap >= 0.9 ? 'same' : labelOverlap >= 0.6 ? 'similar' : 'different';
        const bPeriod = periodOf(db, 'b', other);
        const order: Relation['period']['order'] = !aPeriod[0] || !bPeriod[0] ? 'unknown' : bPeriod[0]! > aPeriod[1]! ? 'after' : bPeriod[1]! < aPeriod[0]! ? 'before' : 'overlap';
        const suggestions: Suggestion[] = [];
        // the document number: the one the recipe declares (its uniqueness is checked on every run) when
        // it is largely shared, else any unique document-like number
        const cover = (k: (typeof keys)[number]) => k.common / Math.max(1, Math.min(k.aDistinct, k.bDistinct));
        const idKey =
          keys.find((k) => k.aUnique && k.a === input.base.roles.id && cover(k) >= 0.9) ??
          keys.find((k) => k.aUnique && (k.a === input.base.roles.id || DOC_LABEL.test(k.aLabel)));
        if (layout !== 'different') {
          const dup = idKey ? ` ${fmt(idKey.common)} ${idKey.aLabel} values appear in both — they are counted once, the later file wins.` : '';
          if (order === 'after' || order === 'before')
            suggestions.push({ kind: 'append', score: 0.9 + labelOverlap / 10, title: `Continue the series with “${other.name}”`, text: `Same layout (${Math.round(labelOverlap * 100)}% of the columns), ${order === 'after' ? 'the next' : 'the previous'} period (${bPeriod[0]} to ${bPeriod[1]}). Appending gives one series from ${(order === 'after' ? aPeriod[0] : bPeriod[0])} to ${(order === 'after' ? bPeriod[1] : aPeriod[1])} with its trend.${dup}` });
          else if (idKey)
            suggestions.push({ kind: 'compare', score: 0.88, key: { a: idKey.a, b: idKey.b }, title: `Compare the documents with “${other.name}”`, text: `Same layout and overlapping period (${bPeriod[0]} to ${bPeriod[1]}): likely another export of the same register. ${fmt(idKey.common)} ${idKey.aLabel} values are in both. Matching them document by document shows which changed (status, amounts, dates), which are new here and which are missing — before anything is combined.` });
          else suggestions.push({ kind: 'compare', score: 0.6, title: `Compare with “${other.name}” (same period)`, text: `Same layout and overlapping period (${bPeriod[0]} to ${bPeriod[1]}): likely another export of the same register. No document number is shared, so open its results to compare the totals side by side.` });
        }
        const ref = keys.find((k) => k.aUnique && k !== undefined && layout === 'different' && k.common >= k.bDistinct * 0.2);
        if (ref) suggestions.push({ kind: 'reconcile', score: 0.85, key: { a: ref.a, b: ref.b }, title: `Reconcile “${other.name}” against these documents`, text: `${fmt(ref.common)} of the ${fmt(ref.bDistinct)} ${ref.bLabel} values in “${other.name}” are ${ref.aLabel} values here. Matching them shows what is paid, partly paid or still open — and which documents marked open are in fact settled.` });
        const cust = keys.find((k) => k.a === input.base.roles.customerCode && !k.aUnique);
        if (cust && !suggestions.length) suggestions.push({ kind: 'compare', score: 0.5, key: { a: cust.a, b: cust.b }, title: `Same customers as “${other.name}”`, text: `${fmt(cust.common)} customers (${cust.aLabel}) are in both; a per-customer comparison sets the two side by side.` });
        relations.push({ other: other.id, name: other.name, layout, labelOverlap: Math.round(labelOverlap * 100) / 100, period: { a: aPeriod, b: bPeriod, order }, keys: keys.slice(0, 6), suggestions: suggestions.sort((x, y) => y.score - x.score) });
      } finally {
        db.exec('DETACH DATABASE b');
      }
    }
  } finally {
    db.close();
  }
  return { relations: relations.sort((x, y) => (y.suggestions[0]?.score ?? 0) - (x.suggestions[0]?.score ?? 0)), ms: Date.now() - t0 };
}

// ------------------------------------------------------------------ merge analyses
export interface CombineInput {
  kind: 'append' | 'reconcile' | 'compare';
  base: RelateSide;
  other: RelateSide;
  key?: { a: string; b: string };
  out: string;
}
export interface CombineOutput {
  kind: CombineInput['kind'];
  rows: number;
  tables: { key: string; label: string; rows: number; columns: ColumnMeta[] }[];
  notes: string[];
  roles: Roles;
  ms: number;
}

/** b's column for each of a's: the same key, else the header it came from (a renamed column still matches), else the label */
function alignColumns(base: RelateSide, other: RelateSide, aPresent: Set<string>, bPresent: Set<string>): { c: ColumnMeta; b: string | undefined }[] {
  const byHeader = new Map(other.columns.filter((c) => bPresent.has(c.key)).map((c) => [norm(c.source?.header ?? c.label), c.key]));
  const byLabel = new Map(other.columns.filter((c) => bPresent.has(c.key)).map((c) => [norm(c.label), c.key]));
  return base.columns.filter((c) => aPresent.has(c.key)).map((c) => ({ c, b: bPresent.has(c.key) ? c.key : byHeader.get(norm(c.source?.header ?? c.label)) ?? byLabel.get(norm(c.label)) }));
}

/** Run a merge analysis into its own database: “append” makes one series (aligned on the column labels,
 *  a document in both counted once), “reconcile” matches the other file's amounts to these documents. */
export function combine(input: CombineInput, open: (p: string) => DatabaseSync): CombineOutput {
  const t0 = Date.now();
  const tmp = `${input.out}.part`;
  rmSync(tmp, { force: true });
  const db = open(tmp);
  const notes: string[] = [];
  const tables: CombineOutput['tables'] = [];
  try {
    db.function('gw_key', { deterministic: true }, (v: unknown) => (v === null || v === undefined ? null : String(v).normalize('NFD').replace(/[^\p{L}\p{N}]+/gu, '').toUpperCase()) as never);
    db.prepare('ATTACH DATABASE ? AS a').run(input.base.run);
    db.prepare('ATTACH DATABASE ? AS b').run(input.other.run);
    // each side's own columns (a schema prefix on the pragma would read the first attached “work” for both)
    const aPresent = new Set((db.prepare(`SELECT name FROM pragma_table_info('work', 'a')`).all() as { name: string }[]).map((r) => r.name));
    const bPresent = new Set((db.prepare(`SELECT name FROM pragma_table_info('work', 'b')`).all() as { name: string }[]).map((r) => r.name));
    let roles: Roles = { ...input.base.roles };
    let rowsOut: number | undefined;
    if (input.kind === 'compare') {
      rowsOut = compareExports(db, input, aPresent, bPresent, tables, notes);
    } else if (input.kind === 'append') {
      const map = alignColumns(input.base, input.other, aPresent, bPresent);
      const cols = map.map((m) => m.c);
      const missing = map.filter((m) => !m.b).map((m) => m.c.label);
      if (missing.length) notes.push(`Not in “${input.other.name}”: ${missing.join(', ')} (blank for its rows).`);
      const list = (side: 'a' | 'b') => map.map((m) => (side === 'a' ? `a.work.${q(m.c.key)}` : m.b ? `b.work.${q(m.b)}` : 'NULL')).join(', ');
      db.exec(`CREATE TABLE work (_file TEXT, _row INTEGER, ${cols.map((c) => q(c.key)).join(', ')})`);
      const id = input.base.roles.id && aPresent.has(input.base.roles.id) ? input.base.roles.id : undefined;
      const idB = id ? map.find((m) => m.c.key === id)?.b : undefined;
      db.exec(`INSERT INTO work SELECT '${input.other.name.replace(/'/g, "''")}', b.work._row, ${list('b')} FROM b.work`);
      const before = (db.prepare('SELECT count(*) n FROM work').get() as { n: number }).n;
      if (id && idB) {
        const r = db.prepare(`INSERT INTO work SELECT '${input.base.name.replace(/'/g, "''")}', a.work._row, ${list('a')} FROM a.work WHERE a.work.${q(id)} IS NULL OR a.work.${q(id)} NOT IN (SELECT ${q(id)} FROM work WHERE ${q(id)} IS NOT NULL)`).run();
        const dropped = input.base.rows - Number(r.changes);
        if (dropped > 0) notes.push(`${fmt(dropped)} documents of “${input.base.name}” are also in “${input.other.name}” (same ${cols.find((c) => c.key === id)?.label}): the later export is kept.`);
      } else db.exec(`INSERT INTO work SELECT '${input.base.name.replace(/'/g, "''")}', a.work._row, ${list('a')} FROM a.work`);
      const rows = (db.prepare('SELECT count(*) n FROM work').get() as { n: number }).n;
      notes.push(`${fmt(rows - before)} rows from “${input.base.name}” and ${fmt(before)} from “${input.other.name}”: ${fmt(rows)} in the series.`);
      tables.push({ key: 'work', label: 'Combined series', rows, columns: [{ key: '_file', label: 'File', type: 'text' }, ...cols] });
      const A = roles.amount;
      const D = roles.date;
      if (A && D && aPresent.has(A) && aPresent.has(D)) {
        const M = roles.month && aPresent.has(roles.month) ? q(roles.month) : `substr(${q(D)}, 1, 7)`;
        db.exec(`CREATE TABLE out_monthly AS SELECT ${M} AS month, count(*) AS documents, round(total(CASE WHEN ${q(A)} > 0 THEN ${q(A)} END), 2) AS invoiced, round(-total(CASE WHEN ${q(A)} < 0 THEN ${q(A)} END), 2) AS credited, round(total(${q(A)}), 2) AS net, group_concat(DISTINCT _file) AS files FROM work GROUP BY 1 ORDER BY 1`);
        const unit = cols.find((c) => c.key === A)?.unit;
        tables.push({ key: 'monthly', label: 'Combined monthly summary', rows: (db.prepare('SELECT count(*) n FROM out_monthly').get() as { n: number }).n, columns: [{ key: 'month', label: 'Month', type: 'text' }, { key: 'documents', label: 'Documents', type: 'number' }, { key: 'invoiced', label: 'Invoiced', type: 'number', unit }, { key: 'credited', label: 'Credit notes', type: 'number', unit }, { key: 'net', label: 'Net amount', type: 'number', unit }, { key: 'files', label: 'Files', type: 'text' }] });
      }
    } else {
      const k = input.key!;
      const ob = input.other.roles;
      const bAmt = ob.amount && bPresent.has(ob.amount) ? ob.amount : input.other.columns.find((c) => c.type === 'number' && bPresent.has(c.key))?.key;
      const bDate = ob.date && bPresent.has(ob.date) ? ob.date : input.other.columns.find((c) => c.type === 'date' && bPresent.has(c.key))?.key;
      const A = roles.amount!;
      const NAME = roles.customer && aPresent.has(roles.customer) ? roles.customer : roles.customerCode;
      if (!bAmt) throw new Error(`“${input.other.name}” has no amount column to reconcile`);
      db.exec(`CREATE TEMP TABLE got AS SELECT gw_key(${q(k.b)}) k, total(${q(bAmt)}) v, count(*) n${bDate ? `, max(${q(bDate)}) d` : ', NULL d'} FROM b.work WHERE ${q(k.b)} IS NOT NULL GROUP BY 1; CREATE INDEX temp.got_k ON got(k)`);
      const unitA = input.base.columns.find((c) => c.key === A)?.unit;
      const st = roles.status && aPresent.has(roles.status) ? roles.status : undefined;
      db.exec(`CREATE TABLE out_reconcile AS SELECT a.work._row AS _row, a.work.${q(k.a)} AS document, ${NAME ? `a.work.${q(NAME)}` : 'NULL'} AS customer, ${roles.date ? `a.work.${q(roles.date)}` : 'NULL'} AS issued, ${st ? `a.work.${q(st)}` : 'NULL'} AS status, round(a.work.${q(A)}, 2) AS amount, round(coalesce(g.v, 0), 2) AS received, round(a.work.${q(A)} - coalesce(g.v, 0), 2) AS outstanding, g.d AS last_receipt, coalesce(g.n, 0) AS receipts,
        CASE WHEN g.k IS NULL THEN 'not received' WHEN abs(a.work.${q(A)} - g.v) < 0.01 THEN 'paid' WHEN g.v < a.work.${q(A)} THEN 'partly paid' ELSE 'over-paid' END AS result
        FROM a.work LEFT JOIN got g ON g.k = gw_key(a.work.${q(k.a)}) WHERE a.work.${q(A)} > 0`);
      const n = (db.prepare('SELECT count(*) n FROM out_reconcile').get() as { n: number }).n;
      const cols: ColumnMeta[] = [{ key: 'document', label: input.base.columns.find((c) => c.key === k.a)?.label ?? 'Document', type: 'identifier' }, { key: 'customer', label: 'Customer', type: 'text' }, { key: 'issued', label: 'Issued', type: 'date' }, { key: 'status', label: 'Status in the register', type: 'text' }, { key: 'amount', label: 'Amount', type: 'number', unit: unitA }, { key: 'received', label: 'Received', type: 'number', unit: unitA }, { key: 'outstanding', label: 'Outstanding', type: 'number', unit: unitA }, { key: 'last_receipt', label: 'Last receipt', type: 'date' }, { key: 'receipts', label: 'Receipts', type: 'number' }, { key: 'result', label: 'Result', type: 'text' }];
      tables.push({ key: 'reconcile', label: 'Documents and receipts', rows: n, columns: cols });
      db.exec(`CREATE TABLE out_summary AS SELECT result, ${st ? 'status' : "'' AS status"}, count(*) AS documents, round(total(amount), 2) AS amount, round(total(received), 2) AS received, round(total(outstanding), 2) AS outstanding FROM out_reconcile GROUP BY 1, 2 ORDER BY 4 DESC`);
      tables.push({ key: 'summary', label: 'Reconciliation summary', rows: (db.prepare('SELECT count(*) n FROM out_summary').get() as { n: number }).n, columns: [{ key: 'result', label: 'Result', type: 'text' }, { key: 'status', label: 'Status in the register', type: 'text' }, { key: 'documents', label: 'Documents', type: 'number' }, { key: 'amount', label: 'Amount', type: 'number', unit: unitA }, { key: 'received', label: 'Received', type: 'number', unit: unitA }, { key: 'outstanding', label: 'Outstanding', type: 'number', unit: unitA }] });
      db.exec(`CREATE TABLE out_unmatched AS SELECT b.work._row AS _row, b.work.${q(k.b)} AS reference, round(b.work.${q(bAmt)}, 2) AS amount${bDate ? `, b.work.${q(bDate)} AS received_on` : ''} FROM b.work WHERE gw_key(b.work.${q(k.b)}) NOT IN (SELECT gw_key(${q(k.a)}) FROM a.work WHERE ${q(k.a)} IS NOT NULL)`);
      const um = db.prepare('SELECT count(*) n, total(amount) v FROM out_unmatched').get() as { n: number; v: number };
      tables.push({ key: 'unmatched', label: 'Receipts without a document', rows: um.n, columns: [{ key: 'reference', label: input.other.columns.find((c) => c.key === k.b)?.label ?? 'Reference', type: 'identifier' }, { key: 'amount', label: 'Amount', type: 'number', unit: unitA }, ...(bDate ? [{ key: 'received_on', label: 'Received on', type: 'date' as const }] : [])] });
      const s = db.prepare(`SELECT result, count(*) n, total(amount) a, total(received) r FROM out_reconcile GROUP BY 1`).all() as { result: string; n: number; a: number; r: number }[];
      const get = (x: string) => s.find((y) => y.result === x) ?? { n: 0, a: 0, r: 0 };
      notes.push(`${fmt(n)} documents: ${fmt(get('paid').n)} paid, ${fmt(get('partly paid').n)} partly paid, ${fmt(get('over-paid').n)} over-paid, ${fmt(get('not received').n)} with nothing received.`);
      if (st && roles.openValue) {
        const mis = db.prepare(`SELECT count(*) n, total(amount) v FROM out_reconcile WHERE status = ? AND result IN ('paid', 'over-paid')`).get(roles.openValue) as { n: number; v: number };
        if (mis.n) notes.push(`${fmt(mis.n)} documents (${Math.round(mis.v).toLocaleString('en-GB')}${unitA ? ` ${unitA}` : ''}) are “${roles.openValue}” in the register but fully received: the status is not being updated.`);
      }
      if (um.n) notes.push(`${fmt(um.n)} receipts (${Math.round(um.v).toLocaleString('en-GB')}${unitA ? ` ${unitA}` : ''}) name no document in this file.`);
      roles = { ...roles };
    }
    db.exec('DETACH DATABASE a; DETACH DATABASE b');
    db.close();
    renameSync(tmp, input.out);
    return { kind: input.kind, rows: rowsOut ?? tables[0]?.rows ?? 0, tables, notes, roles, ms: Date.now() - t0 };
  } catch (e) {
    try {
      db.close();
    } catch {
      /* closed */
    }
    rmSync(tmp, { force: true });
    throw e;
  }
}

const CHANGES_CAP = 500_000;

/** Two exports of the same register: match the documents on their number and report, column by column,
 *  what differs; which documents are only here; which of the other's documents, dated within this file's
 *  period, are missing. Only columns read from both files are compared (computed ones, such as days open,
 *  depend on the day of the run). Returns the number of documents in both. */
function compareExports(db: DatabaseSync, input: CombineInput, aPresent: Set<string>, bPresent: Set<string>, tables: CombineOutput['tables'], notes: string[]): number {
  const k = input.key!;
  if (!aPresent.has(k.a) || !bPresent.has(k.b)) throw new Error('the document number is not in both files');
  const ra = input.base.roles;
  const rb = input.other.roles;
  const has = (s: Set<string>, c?: string) => (c && s.has(c) ? c : undefined);
  const NAME = has(aPresent, ra.customer) ?? has(aPresent, ra.customerCode);
  const bNAME = has(bPresent, rb.customer) ?? has(bPresent, rb.customerCode);
  const D = has(aPresent, ra.date);
  const bD = has(bPresent, rb.date);
  const A = has(aPresent, ra.amount);
  const bA = has(bPresent, rb.amount);
  const unit = input.base.columns.find((c) => c.key === A)?.unit;
  const keyLabel = input.base.columns.find((c) => c.key === k.a)?.label ?? 'Document';
  const map = alignColumns(input.base, input.other, aPresent, bPresent);
  const cmp = map.filter((m) => m.b && m.c.key !== k.a && m.c.source && !m.c.key.startsWith('_'));
  const bType = new Map(input.other.columns.map((c) => [c.key, c.type]));
  const onlyA = map.filter((m) => !m.b && m.c.source).map((m) => m.c.label);
  const usedB = new Set(map.map((m) => m.b).filter(Boolean));
  const onlyB = input.other.columns.filter((c) => bPresent.has(c.key) && c.source && !usedB.has(c.key)).map((c) => c.label);
  db.exec(`CREATE TEMP TABLE ka AS SELECT gw_key(${q(k.a)}) k, min(rowid) r, count(*) n FROM a.work WHERE ${q(k.a)} IS NOT NULL GROUP BY 1 HAVING k <> '';
    CREATE INDEX temp.ka_k ON ka(k);
    CREATE TEMP TABLE kb AS SELECT gw_key(${q(k.b)}) k, min(rowid) r, count(*) n FROM b.work WHERE ${q(k.b)} IS NOT NULL GROUP BY 1 HAVING k <> '';
    CREATE INDEX temp.kb_k ON kb(k);
    CREATE TEMP TABLE pair AS SELECT ka.k k, ka.r ra, kb.r rb FROM ka JOIN kb ON kb.k = ka.k;`);
  const both = (db.prepare('SELECT count(*) n FROM temp.pair').get() as { n: number }).n;
  const JOIN = 'FROM temp.pair p JOIN a.work ON a.work.rowid = p.ra JOIN b.work ON b.work.rowid = p.rb';
  // differences, column by column
  db.exec('CREATE TABLE out_changes (_row INTEGER, document TEXT, customer TEXT, field TEXT, there TEXT, here TEXT)');
  const fields: { label: string; n: number; key: string; b: string; num: boolean }[] = [];
  let kept = 0;
  for (const m of cmp) {
    const av = `a.work.${q(m.c.key)}`;
    const bv = `b.work.${q(m.b!)}`;
    const num = m.c.type === 'number' && bType.get(m.b!) === 'number';
    const diff = num
      ? `((${av} IS NULL) <> (${bv} IS NULL) OR abs(${av} - ${bv}) >= 0.005)`
      : `coalesce(trim(CAST(${av} AS TEXT)), '') <> coalesce(trim(CAST(${bv} AS TEXT)), '')`;
    const n = (db.prepare(`SELECT count(*) n ${JOIN} WHERE ${diff}`).get() as { n: number }).n;
    if (!n) continue;
    fields.push({ label: m.c.label, n, key: m.c.key, b: m.b!, num });
    const room = CHANGES_CAP - kept;
    if (room <= 0) continue;
    const r = db.prepare(`INSERT INTO out_changes SELECT a.work._row, ${txt(`a.work.${q(k.a)}`)}, ${NAME ? `a.work.${q(NAME)}` : 'NULL'}, ?, ${txt(bv)}, ${txt(av)} ${JOIN} WHERE ${diff} LIMIT ${room}`).run(m.c.label);
    kept += Number(r.changes);
  }
  const changedDocs = (db.prepare('SELECT count(DISTINCT document) n FROM out_changes').get() as { n: number }).n;
  db.exec('CREATE TABLE out_fields (field TEXT, documents INTEGER, share REAL)');
  const ins = db.prepare('INSERT INTO out_fields VALUES (?, ?, ?)');
  for (const f of [...fields].sort((x, y) => y.n - x.n)) ins.run(f.label, f.n, both ? Math.round((f.n / both) * 1000) / 10 : 0);
  const cols = (defs: [string, string, ColumnMeta['type'], string?][]): ColumnMeta[] => defs.map(([key, label, type, u]) => ({ key, label, type, ...(u ? { unit: u } : {}) }));
  tables.push({ key: 'fields', label: 'Differences by column', rows: fields.length, columns: cols([['field', 'Column', 'text'], ['documents', 'Documents that differ', 'number'], ['share', '% of the documents in both', 'number']]) });
  // status movements (open → paid…), with the amount they carry
  const st = fields.find((f) => f.key === ra.status);
  if (st) {
    db.exec(`CREATE TABLE out_status AS SELECT CAST(b.work.${q(st.b)} AS TEXT) AS there, CAST(a.work.${q(st.key)} AS TEXT) AS here, count(*) AS documents${A ? `, round(total(a.work.${q(A)}), 2) AS amount` : ''} ${JOIN} WHERE coalesce(trim(CAST(a.work.${q(st.key)} AS TEXT)), '') <> coalesce(trim(CAST(b.work.${q(st.b)} AS TEXT)), '') GROUP BY 1, 2 ORDER BY 3 DESC`);
    const n = (db.prepare('SELECT count(*) n FROM out_status').get() as { n: number }).n;
    tables.push({ key: 'status', label: 'Status changes', rows: n, columns: cols([['there', `In “${input.other.name}”`, 'text'], ['here', 'In this file', 'text'], ['documents', 'Documents', 'number'], ...(A ? [['amount', 'Amount', 'number', unit] as [string, string, ColumnMeta['type'], string?]] : [])]) });
  }
  tables.push({ key: 'changes', label: 'Every difference', rows: kept, columns: cols([['document', keyLabel, 'identifier'], ['customer', 'Customer', 'text'], ['field', 'Column', 'text'], ['there', `In “${input.other.name}”`, 'text'], ['here', 'In this file', 'text']]) });
  // documents on one side only
  db.exec(`CREATE TABLE out_only_here AS SELECT a.work._row AS _row, a.work.${q(k.a)} AS document, ${NAME ? `a.work.${q(NAME)}` : 'NULL'} AS customer, ${D ? `a.work.${q(D)}` : 'NULL'} AS issued, ${A ? `round(a.work.${q(A)}, 2)` : 'NULL'} AS amount FROM temp.ka JOIN a.work ON a.work.rowid = ka.r LEFT JOIN temp.kb ON kb.k = ka.k WHERE kb.k IS NULL`);
  const here = db.prepare('SELECT count(*) n, total(amount) v FROM out_only_here').get() as { n: number; v: number };
  const per = D ? (db.prepare(`SELECT substr(min(${q(D)}), 1, 10) a, substr(max(${q(D)}), 1, 10) b FROM a.work`).get() as { a: string | null; b: string | null }) : { a: null, b: null };
  const within = bD && per.a && per.b ? `AND substr(b.work.${q(bD)}, 1, 10) BETWEEN '${per.a}' AND '${per.b}'` : '';
  db.exec(`CREATE TABLE out_only_there AS SELECT b.work._row AS _row, b.work.${q(k.b)} AS document, ${bNAME ? `b.work.${q(bNAME)}` : 'NULL'} AS customer, ${bD ? `b.work.${q(bD)}` : 'NULL'} AS issued, ${bA ? `round(b.work.${q(bA)}, 2)` : 'NULL'} AS amount FROM temp.kb JOIN b.work ON b.work.rowid = kb.r LEFT JOIN temp.ka ON ka.k = kb.k WHERE ka.k IS NULL ${within}`);
  const there = db.prepare('SELECT count(*) n, total(amount) v FROM out_only_there').get() as { n: number; v: number };
  const outside = within ? (db.prepare(`SELECT count(*) n FROM temp.kb LEFT JOIN temp.ka ON ka.k = kb.k WHERE ka.k IS NULL`).get() as { n: number }).n - there.n : 0;
  const docCols = (side: string) => cols([['document', keyLabel, 'identifier'], ['customer', 'Customer', 'text'], ['issued', 'Issued', 'date'], ['amount', 'Amount', 'number', unit]]).map((c) => (c.key === 'document' ? { ...c, label: `${keyLabel} (${side})` } : c));
  tables.push({ key: 'only_here', label: 'Only in this file', rows: here.n, columns: docCols('here') });
  tables.push({ key: 'only_there', label: `Missing from this file`, rows: there.n, columns: docCols(`in “${input.other.name}”`) });
  // the story, in order of importance
  notes.push(`${fmt(both)} documents are in both files (matched on ${keyLabel}); ${cmp.length} columns compared.`);
  if (!fields.length) notes.push(`All ${fmt(both)} agree in every column compared.`);
  else {
    notes.push(`${fmt(changedDocs)}${kept >= CHANGES_CAP ? '+' : ''} of them differ in at least one column: ${fields.slice(0, 5).map((f) => `${f.label} (${fmt(f.n)})`).join(', ')}.`);
    if (st) {
      const top = db.prepare('SELECT * FROM out_status LIMIT 3').all() as { there: string | null; here: string | null; documents: number; amount?: number }[];
      notes.push(`Status changes: ${top.map((s) => `${fmt(s.documents)} “${s.there ?? '(blank)'}” → “${s.here ?? '(blank)'}”${s.amount !== undefined ? ` (${money(s.amount, unit)})` : ''}`).join('; ')}.`);
    }
    // every amount-like column that changed, with the net effect (the amount role itself is often derived, signed)
    for (const f of fields.filter((x) => x.num && x.key !== ra.id && !DOC_LABEL.test(x.label)).slice(0, 3)) {
      const d = db.prepare(`SELECT total(a.work.${q(f.key)} - b.work.${q(f.b)}) v ${JOIN} WHERE abs(coalesce(a.work.${q(f.key)}, 0) - coalesce(b.work.${q(f.b)}, 0)) >= 0.005`).get() as { v: number };
      const u = input.base.columns.find((c) => c.key === f.key)?.unit ?? unit;
      notes.push(`${f.label} differs on ${fmt(f.n)} documents: ${signed(d.v, u)} net (this file minus “${input.other.name}”).`);
    }
  }
  notes.push(here.n ? `${fmt(here.n)} documents are only in this file${A ? ` (${money(here.v, unit)})` : ''}.` : 'No document is only in this file.');
  if (there.n) notes.push(`${fmt(there.n)} documents of “${input.other.name}”${within ? ` dated ${per.a} to ${per.b}` : ''} are missing from this file${bA ? ` (${money(there.v, unit)})` : ''}.`);
  else notes.push(`None of the documents of “${input.other.name}”${within ? ` dated ${per.a} to ${per.b}` : ''} is missing.`);
  if (outside > 0) notes.push(`${fmt(outside)} more documents of “${input.other.name}” are dated outside this file's period and were not compared.`);
  if (onlyA.length || onlyB.length) notes.push(`Not compared (in one file only): ${[...onlyA.map((l) => `${l} (here)`), ...onlyB.map((l) => `${l} (there)`)].join(', ')}.`);
  return both;
}

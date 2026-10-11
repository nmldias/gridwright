// The rule-based proposer: from a sheet's profile to a first recipe, every step with the reason and the
// figures behind it. It works without a model; the assistant (dsassist.ts) reviews and extends it.
// It proposes only what the profile shows — a number column written as text, a constant currency,
// a code written with several names, a document type with credit notes, an open status — and the
// outputs a finance reader expects from such a register: customers, months, ageing, exceptions.

import type { ColumnProfile, SheetProfile } from './dsprofile.js';
import { slug } from './dsprofile.js';
import type { Roles, Step } from './dssteps.js';

export interface Proposal {
  steps: Step[];
  roles: Roles;
  /** short findings in plain words, for the first screen of the guided import */
  findings: { level: 'info' | 'warning'; text: string }[];
}

const CREDIT = /cr[eé]dit|\bnc\b|devolu|refund|estorno|abono|return/i;
const OPEN = /^(aberta?o?|em aberto|open|pendente|pending|unpaid|por pagar|outstanding|n[aã]o pag[ao])$/i;
const CANCELLED = /cancel|anulad|void|annul/i;
const CURRENCY = /^(moeda|currency|divisa|curr|ccy|cur)$/i;
const ISSUE_DATE = /emiss|issue|invoice date|data (da )?fact|data doc|document date|^data$|^date$/i;
const DUE_DATE = /venc|due|prazo|maturity/i;
const AMOUNT = /valor|total|amount|montante|pre[cç]o|price|custo|cost|saldo|balance|l[ií]quido|net|bruto|gross/i;
const DOC_TYPE = /tipo|type|esp[eé]cie|kind/i;
const STATUS = /status|estado|situa[cç][aã]o|state/i;
const CUSTOMER = /cliente|customer|client|seguradora|payer|pagador|entidade|account name|nome/i;
/** a label naming a code rather than a name: “Código Cliente”, “Customer ID”, “Nº Cliente”, “Ref. Cliente”, “NIF” */
const CODE_LABEL = /(^|[\s_.-])(c[oó]d(igo)?|code|id|n[ºo°.]|num(ero|ber)?|n[uú]mero|ref(er[eê]ncia)?|nif|nuit|conta|account)([\s_.-]|$)/i;
const PK_LABEL = /interno|internal|^id$|record|registo|linha|line id/i;
const INSURER = ['SEGURO', 'SEGUROS', 'SEGURADORA', 'INSURANCE', 'ASSURANCE', 'ASSURANCES', 'MUTUA', 'MÚTUA', 'SAÚDE', 'SAUDE', 'HEALTH'];
const PRIVATE = ['PARTICULAR', 'PARTICULARES', 'PRIVADO', 'PRIVATE', 'PACIENTE', 'PATIENT', 'CONSUMIDOR FINAL'];

const fmt = (n: number) => Math.round(n).toLocaleString('en-GB');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A regular expression for a value shape (letters → \p{L}+, digits → \d+, the rest literally). */
export function shapeRegex(shape: string): string {
  let out = '^';
  for (const ch of shape) out += ch === 'A' ? '\\p{L}+' : ch === '9' ? '\\d+' : ch === ' ' ? ' ' : esc(ch);
  return `${out}$`;
}

export function propose(p: SheetProfile): Proposal {
  const steps: Step[] = [];
  const findings: Proposal['findings'] = [];
  const roles: Roles = {};
  let n = 0;
  const id = () => `s${String(++n).padStart(2, '0')}`;
  const push = (s: Record<string, unknown>) => steps.push({ by: 'rule', enabled: true, ...s, id: id() } as Step);
  const used = p.columns.filter((c) => c.inferred !== 'empty');
  const taken = new Set(used.map((c) => c.key));
  const newKey = (label: string) => slug(label, taken);
  const L = (c: ColumnProfile) => `“${c.label}”`;
  const share = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '0%');

  // 1. read
  const empty = p.columns.filter((c) => c.inferred === 'empty');
  push({ type: 'header', sheet: p.index, row: p.headerRow, columns: used.map((c) => ({ index: c.index, key: c.key, label: c.label })), why: `The header is on row ${p.headerRow}${p.headerCandidates.length > 1 ? ` (other candidates: ${p.headerCandidates.filter((r) => r !== p.headerRow).join(', ')})` : ''}; ${fmt(p.rows)} data rows${empty.length ? `; ${empty.length} empty columns left out (${empty.map((c) => c.label).join(', ')})` : ''}.` });
  findings.push({ level: 'info', text: `${fmt(p.rows)} rows × ${used.length} columns in “${p.name}”, header on row ${p.headerRow}.` });

  // 2. tidy text
  const untidy = used.filter((c) => c.untidy > 0);
  if (untidy.length) push({ type: 'trim', columns: 'all', why: `Stray spaces or hidden characters in ${untidy.map((c) => `${c.label} (${fmt(c.untidy)})`).join(', ')} would make equal values look different.` });
  if (p.totalsRows.length) push({ type: 'drop_rows', when: 'totals', why: `Rows that are totals, not documents (first at row ${p.totalsRows[0]}), would be counted twice.` });

  // 3. types
  const numbers = used.filter((c) => c.inferred === 'number');
  for (const c of numbers) {
    const text = c.numText.pt + c.numText.en + c.numText.plain + c.numText.ambiguous;
    if (!text) continue;
    push({ type: 'convert', column: c.key, to: 'number', locale: c.locale ?? 'auto', why: `${fmt(text)} of ${fmt(c.filled)} values in ${L(c)} are numbers written as text in the ${c.locale === 'en' ? 'English (1,234.56)' : 'Portuguese (1.234,56)'} format, e.g. “${c.top.find((t) => typeof t.value === 'string')?.value ?? ''}”; ${fmt(c.storage.number)} are numbers already. As text they cannot be added up.` });
    findings.push({ level: 'warning', text: `${L(c)}: ${share(text, c.filled)} of the amounts are text (${c.locale === 'en' ? '1,234.56' : '1.234,56'}), converted to numbers.` });
  }
  for (const c of used.filter((x) => x.inferred === 'date' && x.dateText > 0)) push({ type: 'convert', column: c.key, to: 'date', dayFirst: true, why: `${fmt(c.dateText)} dates in ${L(c)} are written as text (day first), rewritten as ISO dates.` });
  for (const c of used.filter((x) => x.inferred === 'identifier' && x.storage.number > 0 && x.storage.text > 0)) {
    push({ type: 'convert', column: c.key, to: 'identifier', why: `${L(c)} mixes ${fmt(c.storage.number)} numbers with ${fmt(c.storage.text)} text codes; kept all as text codes so they match across files.` });
  }

  // 4. roles
  const dates = used.filter((c) => c.inferred === 'date');
  const issue = dates.find((c) => ISSUE_DATE.test(c.label) && !DUE_DATE.test(c.label)) ?? dates[0];
  const due = dates.find((c) => c !== issue && DUE_DATE.test(c.label));
  const amounts = numbers.filter((c) => AMOUNT.test(c.label)).sort((a, b) => (b.sum ?? 0) - (a.sum ?? 0));
  const amount = amounts[0] ?? numbers.sort((a, b) => (b.sum ?? 0) - (a.sum ?? 0))[0];
  const cats = used.filter((c) => c.inferred === 'category');
  const docType = cats.find((c) => DOC_TYPE.test(c.label) && c.top.some((t) => CREDIT.test(String(t.value)))) ?? cats.find((c) => c.top.some((t) => CREDIT.test(String(t.value))) && c.distinct <= 12);
  const status = cats.find((c) => c !== docType && STATUS.test(c.label)) ?? cats.find((c) => c !== docType && c.top.some((t) => OPEN.test(String(t.value).trim())));
  const pair = p.pairs.find((x) => CUSTOMER.test(p.columns.find((c) => c.key === x.name)?.label ?? '')) ?? p.pairs[0];
  // without a code/name pair (a clean file has none to report): the customer is the name column, not “Código Cliente”
  const textual = (c: (typeof used)[number]) => c.inferred === 'text' || c.inferred === 'category';
  const customerName = pair
    ? used.find((c) => c.key === pair.name)
    : (used.find((c) => textual(c) && CUSTOMER.test(c.label) && !CODE_LABEL.test(c.label)) ?? used.find((c) => textual(c) && CUSTOMER.test(c.label)));
  const customerCode = pair
    ? used.find((c) => c.key === pair.code)
    : used.find((c) => c !== customerName && c.inferred !== 'number' && c.inferred !== 'date' && CUSTOMER.test(c.label) && CODE_LABEL.test(c.label));
  const pk = used.find((c) => c.inferred === 'identifier' && c.distinct === c.filled && c.filled === p.rows && PK_LABEL.test(c.label)) ?? used.find((c) => c.inferred === 'identifier' && c.distinct === c.filled && c.filled === p.rows);
  if (issue) roles.date = issue.key;
  if (amount) roles.amount = amount.key;
  if (docType) roles.docType = docType.key;
  if (status) roles.status = status.key;
  if (customerCode) roles.customerCode = customerCode.key;
  if (customerName) roles.customer = customerName.key;
  if (pk) roles.id = pk.key;

  // 5. constant columns: a currency becomes the unit of the amounts
  for (const c of used.filter((x) => x.constant)) {
    const v = String(c.top[0]?.value ?? '');
    if (CURRENCY.test(c.label) || /^[A-Z]{3}$/.test(v)) {
      roles.unit = v;
      push({ type: 'drop_column', column: c.key, keepAs: 'unit', why: `${L(c)} is ${v} on all ${fmt(c.filled)} rows: it is the unit of the amounts, not information about each document.` });
      findings.push({ level: 'info', text: `Every amount is in ${v} (${L(c)} never changes).` });
    } else push({ type: 'drop_column', column: c.key, keepAs: 'note', enabled: false, why: `${L(c)} is “${v}” on every row; it can be dropped (kept as a note).` });
  }

  // 6. equal columns
  for (const e of p.equal) {
    const a = used.find((c) => c.key === e.a)!;
    const b = used.find((c) => c.key === e.b)!;
    push({ type: 'check', kind: 'equal_columns', column: b.key, other: a.key, severity: 'info', label: `${b.label} equals ${a.label}`, why: `${b.label} is the same as ${a.label} on ${fmt(e.equal)} of ${fmt(e.of)} rows${a.inferred === 'date' ? ': no payment terms are recorded, so age is measured from the issue date' : ''}.` });
    if (a.inferred === 'date') findings.push({ level: 'warning', text: `${b.label} = ${a.label} on every row: the file records no payment terms; overdue days are counted from issue.` });
  }

  // 7. one name per customer
  let customer = customerName?.key;
  let group: string | undefined;
  if (pair && customerName && customerCode && (pair.codesWithManyNames || pair.namesWithManyCodes)) {
    const into = { key: newKey(`${customerName.label} standard`), label: `${customerName.label} (standard)` };
    const groupInto = pair.namesWithManyCodes ? { key: newKey(`${customerName.label} group`), label: `${customerName.label} group` } : undefined;
    const ex = pair.examples[0];
    push({ type: 'canonical', code: customerCode.key, name: customerName.key, into, groupInto, why: `${fmt(pair.codesWithManyNames)} codes in ${L(customerCode)} are written with more than one name${ex ? ` (e.g. ${ex.code}: “${ex.names[0]}” ${fmt(ex.counts[0])} rows, “${ex.names[1]}” ${fmt(ex.counts[1])})` : ''}; each code keeps the name it is used with most.${groupInto ? ` ${fmt(pair.namesWithManyCodes)} names are used by several codes (e.g. ${pair.groups[0]?.name}: ${pair.groups[0]?.codes.join(', ')}); the group joins them for analysis.` : ''}` });
    customer = into.key;
    group = groupInto?.key;
    roles.customer = into.key;
    findings.push({ level: 'warning', text: `${fmt(pair.codesWithManyNames)} customer codes have several spellings; ${fmt(pair.namesWithManyCodes)} customers appear under several codes.` });
  }

  // 8. customer type
  if (customerName) {
    const topNames = customerName.top.map((t) => String(t.value).toUpperCase());
    const ins = topNames.filter((v) => INSURER.some((w) => v.includes(w))).length;
    const prv = topNames.filter((v) => PRIVATE.some((w) => v.includes(w))).length;
    if (ins >= 2 || (ins && prv)) {
      const into = { key: newKey('customer type'), label: 'Customer type' };
      push({ type: 'classify', column: customer ?? customerName.key, into, rules: [{ contains: PRIVATE, value: 'Private' }, { contains: INSURER, value: 'Insurer' }], otherwise: 'Company / other', why: `Most of the largest customers are insurers${prv ? ' and one is private patients' : ''}: a type column splits insurers from private patients and other payers.` });
      roles.customerType = into.key;
    }
  }

  // 9. checks: the record key, references, blanks, shapes
  if (pk) push({ type: 'check', kind: 'unique', column: pk.key, severity: 'error', label: `${pk.label} is unique`, why: `${L(pk)} identifies each row (${fmt(pk.distinct)} values, none repeated): any repeat in a later file means a document was exported twice.` });
  for (const c of used.filter((x) => x.inferred === 'identifier' && x !== pk && x !== customerCode)) {
    const blankShare = c.blanks / Math.max(1, p.rows);
    // a reference to another document repeats by nature (a credit note and its invoice): no duplicate check
    const reference = /\bref|refer[eê]ncia|reference|encounter|epis[oó]dio|episode|processo|order|pedido/i.test(c.label);
    if (!reference && c.duplicates > 0 && c.duplicates <= c.filled * 0.05) {
      if (docType && c.duplicates > 10) push({ type: 'duplicates', columns: [docType.key, c.key], action: 'flag', why: `${L(c)} repeats ${fmt(c.duplicates)} times; numbering is usually per document type, so it is checked within ${docType.label}.` });
      else push({ type: 'check', kind: 'unique', column: c.key, severity: 'warning', label: `${c.label} is unique`, why: `${L(c)} is nearly unique (${fmt(c.duplicates)} repeats in ${fmt(c.filled)}).` });
    }
    if (c.blanks > 0 && blankShare <= 0.01) push({ type: 'check', kind: 'required', column: c.key, severity: 'warning', label: `${c.label} is filled`, why: `${L(c)} is blank on ${fmt(c.blanks)} rows of ${fmt(p.rows)}.` });
    const main = c.shapes[0];
    if (main && main.count >= c.filled * 0.98 && main.count < c.filled && c.storage.text > 0) push({ type: 'check', kind: 'pattern', column: c.key, pattern: shapeRegex(main.shape), severity: 'info', label: `${c.label} looks like “${main.shape}”`, why: `${fmt(main.count)} of ${fmt(c.filled)} values follow one pattern (${main.shape}; A = letters, 9 = digits); the ${fmt(c.filled - main.count)} others are listed.` });
  }
  if (customerCode) {
    const main = customerCode.shapes[0];
    if (main && main.count < customerCode.filled && main.count >= customerCode.filled * 0.9) push({ type: 'check', kind: 'pattern', column: customerCode.key, pattern: shapeRegex(main.shape), severity: 'info', label: `${customerCode.label} looks like “${main.shape}”`, why: `${fmt(customerCode.filled - main.count)} rows use a code without the usual form (${main.shape}), e.g. ${customerCode.shapes[1] ? `shape ${customerCode.shapes[1].shape}` : ''}.` });
  }

  // 10. signed amounts, cancelled documents, month
  let net = amount?.key;
  const creditValues = docType ? docType.top.map((t) => String(t.value)).filter((v) => CREDIT.test(v)) : [];
  if (amount && docType && creditValues.length && !(amount.negatives ?? 0)) {
    const into = { key: newKey('net amount'), label: 'Net amount' };
    const cn = docType.top.filter((t) => creditValues.includes(String(t.value))).reduce((a, t) => a + t.count, 0);
    push({ type: 'signed', column: amount.key, negateWhen: [{ column: docType.key, op: 'in', values: creditValues }], into, why: `${fmt(cn)} ${creditValues.join(' / ')} documents carry positive amounts; they reduce revenue, so they count negative in the net amount.` });
    net = into.key;
    roles.gross = amount.key;
    roles.amount = into.key;
    findings.push({ level: 'warning', text: `${fmt(cn)} credit notes have positive amounts; a net amount counts them negative.` });
  }
  const cancelled = status ? status.top.map((t) => String(t.value)).filter((v) => CANCELLED.test(v)) : [];
  if (status && cancelled.length) {
    const cnt = status.top.filter((t) => cancelled.includes(String(t.value))).reduce((a, t) => a + t.count, 0);
    push({ type: 'filter', where: [{ column: status.key, op: 'not_in', values: cancelled }], why: `${fmt(cnt)} documents are ${cancelled.join(' / ')}: they did not happen, so they are left out of the totals (each stays listed in the audit).` });
  }
  const openValue = status?.top.map((t) => String(t.value)).find((v) => OPEN.test(v.trim()));
  if (openValue) roles.openValue = openValue;
  if (issue) {
    const into = { key: newKey('month'), label: 'Month' };
    push({ type: 'derive', into, kind: 'month', from: issue.key, why: `Monthly totals and trends need the month of ${L(issue)} (${issue.min} to ${issue.max}).` });
    roles.month = into.key;
  }

  // 11. outputs
  const cnt = (label: string) => ({ fn: 'count' as const, label });
  if (customerCode || customer) {
    const groupBy = [
      ...(customerCode ? [{ column: customerCode.key, label: customerCode.label }] : []),
      ...(customer ? [{ column: customer, label: 'Customer' }] : []),
      ...(roles.customerType ? [{ column: roles.customerType, label: 'Type' }] : []),
      ...(group ? [{ column: group, label: 'Group' }] : []),
    ];
    push({
      type: 'table', key: 'customers', label: 'Customers', role: 'dimension', place: true, groupBy,
      measures: [cnt('Documents'), ...(net ? [{ fn: 'sum' as const, column: net, label: 'Net amount' }] : []), ...(issue ? [{ fn: 'min' as const, column: issue.key, label: 'First document' }, { fn: 'max' as const, column: issue.key, label: 'Last document' }] : [])],
      why: 'One row per customer code: the dimension that joins this register to receipts, contracts or a ledger.',
    });
  }
  if (roles.month && net) {
    const credit = docType && creditValues.length ? [{ column: docType.key, op: 'in' as const, values: creditValues }] : undefined;
    const notCredit = docType && creditValues.length ? [{ column: docType.key, op: 'not_in' as const, values: creditValues }] : undefined;
    push({
      type: 'table', key: 'monthly', label: 'Monthly summary', role: 'summary', place: true, groupBy: [{ column: roles.month, label: 'Month' }],
      measures: [
        cnt('Documents'),
        ...(credit ? [{ fn: 'sum' as const, column: amount!.key, label: 'Invoiced', where: notCredit }, { fn: 'sum' as const, column: amount!.key, label: 'Credit notes', where: credit }] : []),
        { fn: 'sum' as const, column: net, label: 'Net amount' },
        ...(customerCode ? [{ fn: 'count_distinct' as const, column: customerCode.key, label: 'Customers' }] : []),
        ...(openValue && status ? [{ fn: 'sum' as const, column: net, label: 'Still open', where: [{ column: status.key, op: 'eq' as const, value: openValue }] }] : []),
      ],
      why: 'Month by month: invoiced, credited, net, and how much of each month is still open — the base for trends.',
    });
  }
  if (customer && net) push({ type: 'table', key: 'top_customers', label: 'Top customers', role: 'summary', place: true, groupBy: [{ column: group ?? customer, label: 'Customer' }, ...(roles.customerType ? [{ column: roles.customerType, label: 'Type' }] : [])], measures: [{ fn: 'sum', column: net, label: 'Net amount' }, { fn: 'share', column: net, label: 'Share' }, cnt('Documents')], orderBy: [{ by: 'Net amount', desc: true }], limit: 20, why: 'Concentration: how much of the net amount the largest customers carry.' });
  if (docType && status && net) push({ type: 'pivot', key: 'status_by_type', label: 'Status by document type', place: true, rows: docType.key, columns: status.key, value: net, fn: 'sum', why: `${docType.label} against ${status.label}: what is open, closed and cancelled for each kind of document.` });
  if (issue && net && status && openValue) {
    push({ type: 'ageing', key: 'open_ageing', label: 'Open documents by age', place: true, date: issue.key, amount: net, asOf: 'max', buckets: [30, 60, 90, 180, 365], where: [{ column: status.key, op: 'eq', value: openValue }], why: `Documents still “${openValue}”, by days since ${issue.label} at the last date in the file.` });
    if (customer) push({ type: 'ageing', key: 'open_ageing_by_customer', label: 'Open documents by customer and age', place: true, date: issue.key, amount: net, asOf: 'max', buckets: [30, 60, 90, 180, 365], per: group ?? customer, limit: 50, where: [{ column: status.key, op: 'eq', value: openValue }], why: 'Who owes what, and for how long: the 50 customers with the most open.' });
  }
  push({ type: 'table', key: 'documents', label: 'Documents (clean)', role: 'fact', place: p.rows <= 50_000, groupBy: [], measures: [], why: `Every cleaned document row with its row in the original file${p.rows > 50_000 ? '; kept in the dataset (too large to place in a sheet) and queried from there' : ''}.` });
  push({ type: 'exceptions', key: 'exceptions', label: 'Exceptions', place: true, why: 'Everything the steps could not read or the checks flagged, with the rows in the file.' });
  return { steps, roles, findings };
}

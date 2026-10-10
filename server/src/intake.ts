// Intake: bring material in and make it trustworthy before it becomes a table. A file (CSV, TSV,
// Excel, ODS, XML, JSON), pasted text or a read-only SQL result is parsed in this process with
// size and cell limits, never executed (formulas are reduced to their values, macros ignored,
// cells are data); profiled column by column (type, blanks, unique values, units, ranges);
// sanitised with every change counted (numbers in either locale → one canonical form, dates →
// ISO, identifiers kept as text with their leading zeros, totals rows set aside, empty and
// ragged rows handled); related to what the situation already holds (the next snapshot of a
// series, a re-delivery or correction of the same period, an older period, a different entity
// with the same columns, something new, an exact duplicate); and retained as it arrived, keyed by
// its content hash, so that the original can be inspected later and a re-delivery is recognised.
// Nothing is written to the workbook until a person (or an explicit policy) chooses how to place
// it; placement then goes through the same log as every other change, with origin "import".

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import * as XLSX from 'xlsx';
import { addRecord, checkDocument, comparePeriods, loadState, noteEvent, type ContextRecord } from './companion.js';
import { engineAvailable, errorMessage, openDocument, tableMetas, type CellViewJson, type TableMetaView } from './headless.js';
import { appendEntry, readAll, type Author, type LogEntry } from './history.js';
import { validateActions, type Action } from './proposals.js';
import { runQuery, type ColumnKind, type QueryResult } from './sql.js';
import { crashPoint, DATA_DIR, listConnections, readFile } from './storage.js';
import { tenantOfDoc } from './access.js';
import { ACCOUNTS, getTenant } from './tenancy.js';

export const MAX_INTAKE_BYTES = Number(process.env.GRIDWRIGHT_INTAKE_MAX_MB ?? 25) * 1024 * 1024;
const MAX_CELLS = 1_000_000;
const MAX_ROWS = 200_000;
const MAX_COLS = 256;

export type IntakeFormat = 'csv' | 'tsv' | 'text' | 'xlsx' | 'xlsm' | 'xls' | 'ods' | 'xml' | 'json' | 'sql';

export interface IntakeColumn {
  index: number;
  header: string;
  type: 'identifier' | 'number' | 'date' | 'boolean' | 'text' | 'empty';
  filled: number;
  blanks: number;
  unique: number;
  /** unit or currency read off the header or the values (Kz, AOA, USD, %, days) */
  unit?: string;
  sample: string[];
  /** cells normalised (locale numbers, dates, trimmed text) */
  normalised: number;
  /** text found where the column is numeric — kept as text, reported, never silently dropped */
  textInNumber: number;
  /** identifiers that carry leading zeros (kept as text) */
  leadingZeros: number;
  min?: number;
  max?: number;
  minDate?: string;
  maxDate?: string;
  /** a column whose every value is the same: an entity or scope marker (branch, company, currency) */
  constant?: string;
  /** the kind the source declared (a database column type), when there is one */
  declared?: ColumnKind;
}

export interface IntakeSet {
  name: string;
  /** rows as cell inputs for the engine (header first): canonical numbers, ISO dates, 'identifiers */
  rows: string[][];
  dataRows: number;
  cols: number;
  columns: IntakeColumn[];
  headerDetected: boolean;
  totalsRow?: { index: number; text: string };
  quarantined: { row: number; reason: string; values: string[] }[];
  emptyRowsDropped: number;
  raggedRows: number;
  formulasReduced: number;
  /** cells that read like instructions to a model — counted, kept as data, never obeyed */
  instructionLikeCells: number;
  notes: string[];
  relation: Relation;
}

export interface Relation {
  kind: 'first' | 'next' | 'same-period' | 'older' | 'different-entity' | 'duplicate' | 'unrelated';
  /** the table this set relates to, when one does */
  table?: { id: number; name: string };
  series?: string;
  currentPeriod?: string;
  sharedColumns: number;
  identifiers?: { column: string; overlap: number; ofFile: number; ofTable: number; added: number; removed: number };
  entity?: { column: string; file: string; table?: string };
  /** what the companion recommends and why — the person decides */
  recommended: 'update' | 'new' | 'history' | 'skip';
  reason: string;
  /** a table name for a new placement, when the file suggests one (a different entity) */
  name?: string;
}

export interface IntakeProfile {
  key: string;
  doc: string;
  name: string;
  format: IntakeFormat;
  size: number;
  arrivedAt: string;
  by: string;
  origin: 'user' | 'inbox' | 'sql' | 'agent';
  family: string;
  period?: string;
  periodFrom: 'name' | 'column' | 'none';
  sets: IntakeSet[];
  sanitised: string[];
  warnings: string[];
  status: 'profiled' | 'applied' | 'declined';
  applied?: { at: string; by: string; decision: string; tables: { set: string; table: number; name: string; placed: 'new' | 'update' | 'history' }[]; records: string[]; seqs: number[]; /** completed from the log after an interruption or a repeated request: nothing was committed twice */ recovered?: true };
  /** for a SQL snapshot: the connection and the query (never credentials) */
  query?: { connection: string; sql: string; rows: number; truncated: boolean; kinds?: ColumnKind[] };
  /** a refresh the companion held for a person: which checks failed (set when the profile is read back) */
  held?: { version: number; checks: { name: string; ok: boolean; detail: string }[] };
  original?: string;
}

const DIR = (doc: string) => join(DATA_DIR, 'intake', doc);
const safeId = (id: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(id);
const now = () => new Date().toISOString();

// ------------------------------------------------------------------ names and periods
const DATE_TOKEN = /(\d{4}-\d{2}-\d{2}|\d{8}|\d{2}-\d{2}-\d{4}|\d{4}-\d{2}|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)[a-z]*[-_ ]?\d{2,4}|\bw\d{1,2}\b)/gi;
const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12', janeiro: '01', fevereiro: '02', março: '03', marco: '03', abril: '04', maio: '05', junho: '06', julho: '07', agosto: '08', setembro: '09', outubro: '10', novembro: '11', dezembro: '12' };

/** The period a file name carries: 2026-10-13, 20261013, 13-10-2026, 2026-10, Oct-2026, outubro 2026, W41. */
export function periodFromName(name: string): string | undefined {
  const base = name.replace(/\.[^.]+$/, '');
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(base);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /(?:^|\D)(\d{4})(\d{2})(\d{2})(?:\D|$)/.exec(base);
  if (m && Number(m[2]) <= 12 && Number(m[3]) <= 31) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /(\d{2})-(\d{2})-(\d{4})/.exec(base);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = /(\d{4})-(\d{2})(?!\d)/.exec(base);
  if (m && Number(m[2]) <= 12) return `${m[1]}-${m[2]}`;
  m = /\b([a-zç]{3,9})[-_ ]?(\d{4})\b/i.exec(base);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[2]}-${MONTHS[m[1].toLowerCase()]}`;
  m = /\bw(\d{1,2})\b/i.exec(base);
  if (m) return `W${m[1].padStart(2, '0')}`;
  return undefined;
}
/** The series a file belongs to: its name without date tokens, extension and separators. */
export function familyOf(name: string): string {
  const base = basename(name).replace(/\.[^.]+$/, '');
  const stripped = base.replace(DATE_TOKEN, ' ').replace(/\((\d+|copy|c[oó]pia)\)/gi, ' ').replace(/\b(copy|c[oó]pia)\b/gi, ' ').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (stripped || base).toLowerCase();
}

// ------------------------------------------------------------------ parsing
interface RawSet {
  name: string;
  rows: string[][];
  formulas: number;
  notes: string[];
  /** the declared kind of each column when the source is a database: a text column is never read as numbers */
  hints?: (ColumnKind | undefined)[];
}

function detectDelimiter(text: string): string {
  const head = text.split(/\r?\n/).slice(0, 20).filter((l) => l.trim());
  let best = ',';
  let bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const counts = head.map((l) => l.split(d).length - 1);
    const min = Math.min(...counts);
    const score = min > 0 ? min * 10 + (counts.every((c) => c === counts[0]) ? 5 : 0) : -1;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** RFC 4180-style parsing: quotes, doubled quotes, embedded newlines; delimiter detected. */
export function parseDelimited(text: string, delimiter?: string): string[][] {
  const d = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === d) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (rows.length > MAX_ROWS) break;
    } else cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function parseWorkbook(buf: Buffer, name: string): RawSet[] {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false, cellFormula: true, sheetStubs: false, dense: false });
  const out: RawSet[] = [];
  let cells = 0;
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet || !sheet['!ref']) continue;
    const range = XLSX.utils.decode_range(sheet['!ref']);
    cells += (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1);
    if (cells > MAX_CELLS) throw new Error(`the workbook has more than ${MAX_CELLS.toLocaleString('en-GB')} cells; split it or import a sheet at a time`);
    const grid: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
    let formulas = 0;
    for (const addr of Object.keys(sheet)) {
      if (addr[0] === '!') continue;
      if ((sheet[addr] as { f?: string }).f) formulas++;
    }
    const rows = grid.slice(0, MAX_ROWS).map((r) => r.slice(0, MAX_COLS).map((v) => (v === null || v === undefined ? '' : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v))));
    const notes: string[] = [];
    if (formulas) notes.push(`${formulas} formula cell${formulas === 1 ? '' : 's'} reduced to the values the file carried`);
    out.push({ name: sheetName, rows, formulas, notes });
  }
  if (/\.xlsm$/i.test(name)) for (const s of out) s.notes.push('macros are not executed; values only');
  return out;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const isObj = (v: Json): v is { [k: string]: Json } => !!v && typeof v === 'object' && !Array.isArray(v);
const scalar = (v: Json) => v === null || typeof v !== 'object';

/** The largest list of records in a JSON/XML tree: an array of objects whose values are mostly scalars. */
function recordLists(v: Json, path: string, out: { path: string; items: { [k: string]: Json }[] }[], depth = 0) {
  if (depth > 6) return;
  if (Array.isArray(v)) {
    const items = v.filter(isObj);
    if (items.length >= 1 && items.length >= v.length * 0.8) out.push({ path, items });
    for (const x of v.slice(0, 50)) if (!scalar(x)) recordLists(x, path, out, depth + 1);
  } else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) if (!scalar(x)) recordLists(x, path ? `${path}.${k}` : k, out, depth + 1);
  }
}

function flatten(o: { [k: string]: Json }, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (scalar(v)) out[key.replace(/^@_/, '')] = v === null ? '' : String(v);
    else if (isObj(v) && prefix.split('.').length < 2) Object.assign(out, flatten(v, key));
    else out[key] = JSON.stringify(v).slice(0, 200);
  }
  return out;
}

function setsFromTree(tree: Json, label: string): RawSet[] {
  const lists: { path: string; items: { [k: string]: Json }[] }[] = [];
  recordLists(tree, '', lists);
  if (!lists.length) throw new Error(`no list of records found in the ${label} (expected repeated elements or an array of objects)`);
  lists.sort((a, b) => b.items.length - a.items.length);
  const out: RawSet[] = [];
  for (const l of lists.slice(0, 3)) {
    const flat = l.items.slice(0, MAX_ROWS).map((it) => flatten(it));
    const headers: string[] = [];
    for (const f of flat) for (const k of Object.keys(f)) if (!headers.includes(k)) headers.push(k);
    const rows = [headers.slice(0, MAX_COLS), ...flat.map((f) => headers.slice(0, MAX_COLS).map((h) => f[h] ?? ''))];
    out.push({ name: l.path.split('.').pop() || label, rows, formulas: 0, notes: [`records read from ${label} path “${l.path || '(root)'}”`] });
  }
  return out;
}

function parseXml(text: string): RawSet[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(text.slice(0, 4000))) throw new Error('XML with a DOCTYPE or entity declarations is not accepted');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, parseAttributeValue: false, trimValues: true, processEntities: false });
  const tree = parser.parse(text) as Json;
  return setsFromTree(tree, 'XML');
}

function parseJson(text: string): RawSet[] {
  const tree = JSON.parse(text) as Json;
  return setsFromTree(tree, 'JSON');
}

function formatOf(name: string, text?: string): IntakeFormat {
  const ext = extname(name).toLowerCase();
  if (ext === '.xlsx') return 'xlsx';
  if (ext === '.xlsm') return 'xlsm';
  if (ext === '.xls') return 'xls';
  if (ext === '.ods') return 'ods';
  if (ext === '.xml') return 'xml';
  if (ext === '.json') return 'json';
  if (ext === '.tsv') return 'tsv';
  if (ext === '.csv') return 'csv';
  const head = (text ?? '').trimStart().slice(0, 200);
  if (head.startsWith('<')) return 'xml';
  if (head.startsWith('[') || head.startsWith('{')) return 'json';
  return 'text';
}

// ------------------------------------------------------------------ profiling and sanitising
const ID_HEADER = /\b(vin|id|ref|reference|chassis|invoice|factura|fatura|cheque|no\.?|number|num|n[úu]mero|code|c[oó]digo|matr[ií]cula|plate|nif|sku|account|conta)\b/i;
const DATE_HEADER = /\b(date|data|as of|snapshot|entrada|entry|received|arrival|due|vencimento|emiss[aã]o)\b/i;
const AMOUNT_HEADER = /\b(cost|amount|value|price|total|valor|custo|montante|pre[cç]o|margin|margem|landed|cif|fob|balance|saldo)\b/i;
const UNIT_IN_HEADER = /\((kz|aoa|usd|eur|€|\$|%|days|dias|kg|units?)\)|\b(kz|aoa|usd|eur|days|dias)\b/i;
const INSTRUCTION_LIKE = /\b(ignore (all |the )?(previous|prior|above) instructions|system prompt|you are (an?|the) (ai|assistant|model)|approve (this|the) (change|proposal)|disable (the )?checks?|as an ai)\b/i;
/** a header as words: landed_cost and snapshot_date are read like "landed cost" and "snapshot date" */
const words = (h: string) => h.replace(/[_]+/g, ' ');

export interface Parsed {
  kind: 'number' | 'date' | 'boolean' | 'text' | 'empty';
  input: string;
  unit?: string;
  normalised: boolean;
  leadingZeros?: boolean;
}

/** Number text in either locale, with a unit or symbol around it, to a canonical "1234.5"; null when it is not a number. */
export function parseNumber(raw: string): { value: number; unit?: string } | null {
  let s = raw.replace(/[ \s]/g, '');
  if (!s) return null;
  let unit: string | undefined;
  let pct = false;
  if (s.endsWith('%')) {
    pct = true;
    s = s.slice(0, -1);
    unit = '%';
  }
  for (const sym of ['Kz', 'kz', 'AOA', 'USD', 'EUR', '€', '$', '£']) {
    if (s.startsWith(sym)) {
      s = s.slice(sym.length);
      unit = sym.toUpperCase() === 'KZ' ? 'Kz' : sym;
    } else if (s.endsWith(sym)) {
      s = s.slice(0, -sym.length);
      unit = sym.toUpperCase() === 'KZ' ? 'Kz' : sym;
    }
  }
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (!s || !/^[-+]?[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  let canon = s;
  if (hasDot && hasComma) canon = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (hasComma) {
    const parts = s.split(',');
    // one comma followed by exactly three digits is a thousands separator ("1,500"); otherwise a decimal comma ("1,5")
    canon = parts.length === 2 && parts[1].length === 3 ? s.replace(',', '') : parts.length > 2 ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (hasDot) {
    const parts = s.split('.');
    // "1.234.567" is thousands; "1.5" is decimal; "1.500" is ambiguous and read as a decimal (an Excel export writes "1500")
    if (parts.length > 2 && parts.slice(1).every((p) => p.length === 3)) canon = s.replace(/\./g, '');
  }
  const n = Number(canon);
  if (!Number.isFinite(n)) return null;
  return { value: (neg ? -n : n) / (pct ? 100 : 1), unit };
}

const pad = (n: number) => String(n).padStart(2, '0');
/** dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy, yyyy-mm-dd, yyyy/mm/dd, an Excel serial in a date column → ISO date. */
export function parseDate(raw: string, serialOk = false): string | null {
  const s = raw.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(s);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T].*)?$/.exec(s);
  if (m) return +m[2] <= 12 ? `${m[3]}-${pad(+m[2])}-${pad(+m[1])}` : null;
  if (serialOk && /^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial > 20000 && serial < 80000) {
      const d = new Date(Math.round((serial - 25569) * 86400000));
      return d.toISOString().slice(0, 10);
    }
  }
  return null;
}

const BOOL = /^(yes|no|y|n|sim|n[ãa]o|true|false)$/i;

/** Profile one raw set: header, totals, empty rows, per-column type, canonical cell inputs. */
export function profileSet(raw: RawSet, family: string): Omit<IntakeSet, 'relation'> {
  const notes = [...raw.notes];
  const cleaned = raw.rows.map((r) => r.map((c) => (c ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim()));
  let emptyRowsDropped = 0;
  const nonEmpty = cleaned.filter((r) => {
    const keep = r.some((c) => c !== '');
    if (!keep) emptyRowsDropped++;
    return keep;
  });
  if (!nonEmpty.length) throw new Error('the file has no rows');
  // the header row sets the width: trailing empties trimmed, a row that carries more is held back, a shorter one padded
  const trimEnd = (r: string[]) => {
    let n = r.length;
    while (n > 0 && r[n - 1] === '') n--;
    return r.slice(0, n);
  };
  const first = trimEnd(nonEmpty[0]);
  const textish = first.filter((c) => c && !parseNumber(c) && !parseDate(c)).length;
  const filledFirst = first.filter(Boolean);
  const headerDetected = textish >= Math.max(1, Math.ceil(filledFirst.length * 0.6)) && new Set(filledFirst.map((c) => c.toLowerCase())).size === filledFirst.length;
  const width = Math.min(MAX_COLS, headerDetected ? first.length : Math.max(...nonEmpty.map((r) => trimEnd(r).length)));
  let raggedRows = 0;
  const quarantined: IntakeSet['quarantined'] = [];
  const rows: string[][] = [];
  for (let i = 0; i < nonEmpty.length; i++) {
    const r = trimEnd(nonEmpty[i]);
    if (r.length > width) {
      quarantined.push({ row: i + 1, reason: `${r.length} cells for ${width} columns — more than the header allows`, values: r.slice(0, 12) });
      continue;
    }
    if (r.length !== width) raggedRows++;
    rows.push([...r, ...new Array(Math.max(0, width - r.length)).fill('')]);
  }
  const headers = headerDetected ? rows[0].map((c, i) => c || `Column ${i + 1}`) : rows[0].map((_, i) => `Column ${i + 1}`);
  if (!headerDetected) notes.push('no header row recognised: columns are named Column 1…; rename them in the table');
  const body = headerDetected ? rows.slice(1) : rows;
  // a totals row at the foot is evidence of the file, not a record
  let totalsRow: IntakeSet['totalsRow'];
  if (body.length > 1) {
    const last = body[body.length - 1];
    const label = last.find((c) => c && !parseNumber(c)) ?? '';
    if (/^(total|totais|totals?|soma|sum|grand total)\b/i.test(label)) {
      totalsRow = { index: body.length, text: last.filter(Boolean).join(' | ').slice(0, 120) };
      body.pop();
      notes.push(`a totals row (“${label}”) was set aside: it is a check on the file, not a record`);
    }
  }
  // per-column profile
  const columns: IntakeColumn[] = [];
  const out: string[][] = [headers];
  const parsedCells: Parsed[][] = body.map(() => []);
  for (let c = 0; c < width; c++) {
    const header = headers[c];
    const values = body.map((r) => r[c] ?? '');
    const filledVals = values.filter((v) => v !== '');
    const counts = { number: 0, date: 0, boolean: 0, text: 0 };
    const idLike = ID_HEADER.test(words(header));
    const dateLike = DATE_HEADER.test(words(header));
    // a declared kind (a database column) is the contract: text is text whatever it looks like, numbers are canonical
    const declared = raw.hints?.[c];
    const parsed: Parsed[] = values.map((v) => {
      if (v === '') return { kind: 'empty', input: '', normalised: false };
      if (declared === 'text' || declared === 'binary' || declared === 'json') return { kind: 'text', input: v, normalised: false };
      if (declared === 'boolean' || (!declared && BOOL.test(v))) return BOOL.test(v) ? { kind: 'boolean', input: v.toLowerCase(), normalised: v !== v.toLowerCase() } : { kind: 'text', input: v, normalised: false };
      if (declared === 'number') {
        const n = Number(v);
        // 16 or more digits cannot be held exactly as a number: kept as text, every digit intact
        return Number.isFinite(n) && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v) && v.replace(/[-.]/g, '').length < 16 ? { kind: 'number', input: String(n), normalised: String(n) !== v } : { kind: 'text', input: v, normalised: false };
      }
      const date = parseDate(v, dateLike || declared === 'date' || declared === 'datetime');
      if (date && (dateLike || declared === 'date' || declared === 'datetime' || /[-/.]/.test(v))) return { kind: 'date', input: date, normalised: date !== v };
      if (declared) return { kind: 'text', input: v, normalised: false };
      const num = idLike ? null : parseNumber(v);
      if (num) {
        const canon = String(num.value);
        return { kind: 'number', input: canon, unit: num.unit, normalised: canon !== v };
      }
      return { kind: 'text', input: v, normalised: false };
    });
    for (const p of parsed) if (p.kind !== 'empty') counts[p.kind]++;
    const filled = filledVals.length;
    const mostly = (k: keyof typeof counts) => filled > 0 && counts[k] >= filled * 0.8;
    let type: IntakeColumn['type'] = filled === 0 ? 'empty' : mostly('number') ? 'number' : mostly('date') ? 'date' : mostly('boolean') ? 'boolean' : 'text';
    if (declared === 'number' && filled > 0 && counts.number > 0) type = 'number';
    if ((declared === 'date' || declared === 'datetime') && filled > 0 && counts.date > 0) type = 'date';
    const unique = new Set(filledVals.map((v) => v.toLowerCase())).size;
    // an identifier: named like one, or a text column whose values are all distinct codes
    if (type === 'text' && filled >= 2 && (idLike || (unique >= filled * 0.95 && filledVals.every((v) => /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(v) && /\d/.test(v))))) type = 'identifier';
    if (idLike && type === 'number') type = 'identifier';
    let normalised = 0;
    let textInNumber = 0;
    let leadingZeros = 0;
    let unit: string | undefined = UNIT_IN_HEADER.exec(words(header))?.[1] ?? UNIT_IN_HEADER.exec(words(header))?.[2];
    if (unit) unit = unit.toUpperCase() === 'KZ' ? 'Kz' : unit;
    let min: number | undefined;
    let max: number | undefined;
    let minDate: string | undefined;
    let maxDate: string | undefined;
    for (let r = 0; r < body.length; r++) {
      const p = parsed[r];
      const v = values[r];
      let input = p.input;
      if (type === 'identifier') {
        // identifiers are text: leading zeros and every digit survive; the apostrophe keeps the engine from reading a number
        input = v;
        if (/^0\d+/.test(v)) leadingZeros++;
        if (v && (parseNumber(v) || /^\d/.test(v))) input = `'${v}`;
        if (input !== v) normalised++;
      } else if (type === 'number') {
        if (p.kind === 'number') {
          if (p.normalised) normalised++;
          if (p.unit && !unit) unit = p.unit;
          const n = Number(p.input);
          min = min === undefined ? n : Math.min(min, n);
          max = max === undefined ? n : Math.max(max, n);
        } else if (p.kind !== 'empty') {
          textInNumber++;
          input = v;
        }
      } else if (type === 'date') {
        if (p.kind === 'date') {
          if (p.normalised) normalised++;
          minDate = minDate === undefined || p.input < minDate ? p.input : minDate;
          maxDate = maxDate === undefined || p.input > maxDate ? p.input : maxDate;
        } else input = v;
      } else if (type === 'boolean') {
        if (p.kind === 'boolean' && p.normalised) normalised++;
        if (p.kind !== 'boolean') input = v;
      } else {
        input = v;
        // a text that would be read as a number by the engine (a code like 1E5, or 007) stays text
        if (v && parseNumber(v)) {
          input = `'${v}`;
          normalised++;
        }
      }
      parsedCells[r][c] = { ...p, input };
    }
    const constant = filled >= 2 && filled === body.length && unique === 1 && type !== 'number' && type !== 'date' ? filledVals[0] : undefined;
    columns.push({ index: c, header, type, filled, blanks: body.length - filled, unique, unit, sample: filledVals.slice(0, 3).map((v) => v.slice(0, 40)), normalised, textInNumber, leadingZeros, min, max, minDate, maxDate, constant, declared });
  }
  let instructionLikeCells = 0;
  for (let r = 0; r < body.length; r++) {
    out.push(parsedCells[r].map((p) => p.input));
    for (const v of body[r]) if (v && INSTRUCTION_LIKE.test(v)) instructionLikeCells++;
  }
  if (instructionLikeCells) notes.push(`${instructionLikeCells} cell${instructionLikeCells === 1 ? '' : 's'} read like instructions to a model; they are data and change nothing`);
  if (raw.hints?.some(Boolean)) {
    const declaredText = columns.filter((c) => c.declared === 'text').length;
    const declaredNum = columns.filter((c) => c.declared === 'number').length;
    notes.push(`column types taken from the source's own declarations (${declaredText} text, ${declaredNum} numeric): a text column of digits stays text, a numeric column is read as numbers`);
  }
  const n = columns.reduce((a, c) => a + c.normalised, 0);
  if (n) notes.push(`${n} cell${n === 1 ? '' : 's'} normalised (locale numbers, dates, identifiers kept as text)`);
  const t = columns.reduce((a, c) => a + c.textInNumber, 0);
  if (t) notes.push(`${t} text value${t === 1 ? '' : 's'} in numeric columns kept as text (they will show as “cannot assess”, never as zero)`);
  if (raggedRows) notes.push(`${raggedRows} row${raggedRows === 1 ? ' shorter than the header was' : 's shorter than the header were'} padded with blanks`);
  if (emptyRowsDropped) notes.push(`${emptyRowsDropped} empty row${emptyRowsDropped === 1 ? '' : 's'} dropped`);
  if (quarantined.length) notes.push(`${quarantined.length} row${quarantined.length === 1 ? '' : 's'} quarantined (wider than the header): listed, not placed`);
  return { name: family, rows: out, dataRows: out.length - 1, cols: width, columns, headerDetected, totalsRow, quarantined, emptyRowsDropped, raggedRows, formulasReduced: raw.formulas, instructionLikeCells, notes };
}

// ------------------------------------------------------------------ relating to the situation
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

function tableHeaders(cells: CellViewJson[], t: TableMetaView): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of cells) if (c.r === t.header_rows - 1 && c.v && 's' in c.v && c.v.s.trim()) out.set(norm(c.v.s), c.c);
  return out;
}
function columnValues(cells: CellViewJson[], t: TableMetaView, col: number, lower = true): string[] {
  const out: string[] = [];
  for (const c of cells) if (c.c === col && c.r >= t.header_rows && c.v) out.push('s' in c.v ? (lower ? c.v.s.trim().toLowerCase() : c.v.s.trim()) : 'n' in c.v ? String(c.v.n) : 'b' in c.v ? String(c.v.b) : '');
  return out.filter(Boolean);
}

function relate(doc: string, set: Omit<IntakeSet, 'relation'>, family: string, period: string | undefined, key: string, state = loadState(doc)): Relation {
  const none: Relation = { kind: 'first', sharedColumns: 0, recommended: 'new', reason: 'nothing in the situation has these columns: a new table' };
  if (!engineAvailable() || !readFile(doc)) return none;
  // an exact re-delivery is recognised by content, whatever the name
  const dup = state.records.find((r) => r.kind === 'source' && r.intake === key && r.status !== 'retired');
  const live = (r: ContextRecord) => r.status !== 'retired' && r.status !== 'superseded' && r.status !== 'resolved';
  const seriesOf = new Map<number, ContextRecord>();
  for (const r of state.records) if (r.kind === 'source' && live(r)) for (const l of r.links ?? []) if (typeof l.table === 'number') seriesOf.set(l.table, r);
  const fileHeaders = set.columns.map((c) => norm(c.header));
  const fileId = set.columns.find((c) => c.type === 'identifier');
  const fileEntity = set.columns.find((c) => c.constant && !AMOUNT_HEADER.test(words(c.header)) && !DATE_HEADER.test(words(c.header)));
  const { book } = openDocument(doc);
  try {
    let best: Relation | null = null;
    for (const t of tableMetas(book)) {
      if (t.pivot || t.header_rows < 1) continue;
      const cells = JSON.parse(book.cells(t.id)) as CellViewJson[];
      const have = tableHeaders(cells, t);
      if (!have.size) continue;
      const shared = fileHeaders.filter((h) => have.has(h)).length;
      if (shared < Math.ceil(fileHeaders.length * 0.6) || shared < Math.ceil(have.size * 0.6)) continue;
      const src = seriesOf.get(t.id);
      const sameSeries = !!src && src.source === family;
      let identifiers: Relation['identifiers'];
      if (fileId && have.has(norm(fileId.header))) {
        const tv = new Set(columnValues(cells, t, have.get(norm(fileId.header))!));
        const fv = new Set(set.rows.slice(1).map((r) => (r[fileId.index] ?? '').replace(/^'/, '').trim().toLowerCase()).filter(Boolean));
        let common = 0;
        for (const v of fv) if (tv.has(v)) common++;
        identifiers = { column: fileId.header, overlap: fv.size ? common / fv.size : 0, ofFile: fv.size, ofTable: tv.size, added: fv.size - common, removed: tv.size - common };
      }
      let entity: Relation['entity'];
      if (fileEntity && have.has(norm(fileEntity.header))) {
        const tvals = columnValues(cells, t, have.get(norm(fileEntity.header))!, false);
        const tconst = tvals.length && tvals.every((v) => v.toLowerCase() === tvals[0].toLowerCase()) ? tvals[0] : undefined;
        entity = { column: fileEntity.header, file: fileEntity.constant!, table: tconst };
      }
      const currentPeriod = src?.period;
      const sameEntity = !entity || !entity.table || entity.table.toLowerCase() === entity.file.toLowerCase();
      const related = sameSeries || (identifiers ? identifiers.overlap >= 0.3 : false);
      let rel: Relation;
      if (!sameEntity || (identifiers && identifiers.overlap < 0.3 && !sameSeries && identifiers.ofTable >= 2)) {
        rel = { kind: 'different-entity', table: { id: t.id, name: t.name }, series: src?.source, currentPeriod, sharedColumns: shared, identifiers, entity, recommended: 'new', name: entity && !sameEntity ? (family.includes(entity.file.toLowerCase()) ? family.replace(entity.file.toLowerCase(), entity.file) : `${family} ${entity.file}`) : undefined, reason: entity && !sameEntity ? `same columns as ${t.name}, but ${entity.column} is “${entity.file}” here and “${entity.table}” there — a different entity, kept separate` : `same columns as ${t.name}, but ${identifiers ? `only ${Math.round(identifiers.overlap * 100)}% of the ${identifiers.column}s are in common` : 'no common identifiers'} and a different series — kept separate` };
      } else if (dup) {
        rel = { kind: 'duplicate', table: { id: t.id, name: t.name }, series: src?.source, currentPeriod, sharedColumns: shared, identifiers, entity, recommended: 'skip', reason: `this exact file was already added on ${dup.arrivedAt.slice(0, 10)}${dup.period ? ` as the ${dup.period} snapshot` : ''} — nothing to do` };
      } else if (related || !src) {
        const order = period && currentPeriod ? comparePeriods(period, currentPeriod) : null;
        if (order === null && period && currentPeriod) rel = { kind: 'same-period', table: { id: t.id, name: t.name }, series: src?.source, currentPeriod, sharedColumns: shared, identifiers, entity, recommended: 'update', reason: `the same series as ${t.name}; the periods (${period} and ${currentPeriod}) cannot be ordered — treated as a newer delivery` };
        else if (order === 0) rel = { kind: 'same-period', table: { id: t.id, name: t.name }, series: src?.source, currentPeriod, sharedColumns: shared, identifiers, entity, recommended: 'update', reason: `the same period (${period}) as the current ${t.name} snapshot: a correction or a re-delivery — it replaces that period's evidence, it does not count twice` };
        else if (order !== null && order < 0) rel = { kind: 'older', table: { id: t.id, name: t.name }, series: src?.source, currentPeriod, sharedColumns: shared, identifiers, entity, recommended: 'history', reason: `an older period (${period}) than the current ${t.name} snapshot (${currentPeriod}): kept as history beside it, the current one stands` };
        else rel = { kind: 'next', table: { id: t.id, name: t.name }, series: src?.source, currentPeriod, sharedColumns: shared, identifiers, entity, recommended: 'update', reason: `the next snapshot of ${t.name}${sameSeries ? ' (same series' : identifiers ? ` (${Math.round(identifiers.overlap * 100)}% of the ${identifiers.column}s in common` : ' (same columns'}${period ? `, ${period}${currentPeriod ? ` after ${currentPeriod}` : ''}` : ', period not set'}) — same table, formulas and watches kept${identifiers && (identifiers.added || identifiers.removed) ? `; ${identifiers.added} new, ${identifiers.removed} gone` : ''}` };
      } else continue;
      if (!best || rel.sharedColumns > best.sharedColumns) best = rel;
    }
    if (best) return best;
    if (dup) return { kind: 'duplicate', sharedColumns: 0, recommended: 'skip', reason: `this exact file was already added on ${dup.arrivedAt.slice(0, 10)} — nothing to do` };
    return none;
  } finally {
    book.free();
  }
}

// ------------------------------------------------------------------ storage of originals and profiles
function profilePath(doc: string, key: string) {
  return join(DIR(doc), `${key}.json`);
}
export function readProfile(doc: string, key: string): IntakeProfile | null {
  if (!safeId(doc) || !/^[a-f0-9]{16,64}$/.test(key)) return null;
  const p = profilePath(doc, key);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as IntakeProfile;
  } catch {
    return null;
  }
}
function writeProfile(p: IntakeProfile) {
  mkdirSync(DIR(p.doc), { recursive: true });
  const tmp = `${profilePath(p.doc, p.key)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(p, null, 1));
  renameSync(tmp, profilePath(p.doc, p.key));
}
export function listProfiles(doc: string): IntakeProfile[] {
  if (!safeId(doc) || !existsSync(DIR(doc))) return [];
  return readdirSync(DIR(doc))
    .filter((f) => f.endsWith('.json'))
    .map((f) => readProfile(doc, f.slice(0, -5)))
    .filter((p): p is IntakeProfile => !!p)
    .sort((a, b) => (a.arrivedAt < b.arrivedAt ? -1 : 1))
    .map((p) => ({ ...p, sets: p.sets.map((s) => ({ ...s, rows: [] })) }));
}
export function originalPath(doc: string, key: string): string | null {
  const p = readProfile(doc, key);
  if (!p || !p.original) return null;
  const path = join(DIR(doc), p.original);
  return existsSync(path) ? path : null;
}

// ------------------------------------------------------------------ intake
export interface IntakeInput {
  name: string;
  /** the file's bytes (base64) or its text */
  base64?: string;
  text?: string;
  origin?: IntakeProfile['origin'];
  /** the declared kind of each column of a delimited text that came from a database */
  kinds?: ColumnKind[];
}

/** Parse, profile, sanitise and relate — nothing placed. The original is retained under its content hash. */
export function intake(doc: string, by: Author, input: IntakeInput): IntakeProfile {
  if (!safeId(doc) || !readFile(doc)) throw new Error('document not found');
  const name = basename(String(input.name ?? 'pasted.txt')).slice(0, 160) || 'pasted.txt';
  const buf = input.base64 ? Buffer.from(String(input.base64), 'base64') : Buffer.from(String(input.text ?? ''), 'utf8');
  if (!buf.length) throw new Error('the file is empty');
  if (buf.length > MAX_INTAKE_BYTES) throw new Error(`the file is larger than ${Math.round(MAX_INTAKE_BYTES / 1024 / 1024)} MB (GRIDWRIGHT_INTAKE_MAX_MB)`);
  const key = createHash('sha256').update(buf).digest('hex').slice(0, 32);
  const existing = readProfile(doc, key);
  const text = /\.(xlsx|xlsm|xls|ods)$/i.test(name) ? undefined : buf.toString('utf8');
  const format = formatOf(name, text);
  let raws: RawSet[];
  if (format === 'xlsx' || format === 'xlsm' || format === 'xls' || format === 'ods') raws = parseWorkbook(buf, name);
  else if (format === 'xml') raws = parseXml(text!);
  else if (format === 'json') raws = parseJson(text!);
  else raws = [{ name: '', rows: parseDelimited(text!, format === 'tsv' ? '\t' : undefined), formulas: 0, notes: [], hints: input.kinds }];
  const family = familyOf(name);
  const periodName = periodFromName(name);
  const state = loadState(doc);
  const sets: IntakeSet[] = [];
  const warnings: string[] = [];
  let period = periodName;
  let periodFrom: IntakeProfile['periodFrom'] = periodName ? 'name' : 'none';
  for (const raw of raws) {
    const prof = profileSet(raw, raws.length > 1 && raw.name ? `${family} ${raw.name}` : family);
    if (!period) {
      // the data's own dates: the latest "as of" date in a date column named like one
      const dcol = prof.columns.find((c) => c.type === 'date' && DATE_HEADER.test(words(c.header)) && c.maxDate);
      if (dcol) {
        period = dcol.maxDate;
        periodFrom = 'column';
      }
    }
    const relation = relate(doc, prof, family, period, key, state);
    sets.push({ ...prof, relation });
  }
  if (!period) warnings.push('no period recognised in the file name or a date column: set the period the data describes, or it will be dated by its arrival only');
  for (const s of sets) if (s.relation.kind === 'duplicate') warnings.push(s.relation.reason);
  const sanitised = sets.flatMap((s) => s.notes);
  const profile: IntakeProfile = {
    key,
    doc,
    name,
    format,
    size: buf.length,
    arrivedAt: now(),
    by: by.name || by.login || 'someone',
    origin: input.origin ?? 'user',
    family,
    period,
    periodFrom,
    sets,
    sanitised,
    warnings,
    status: existing?.status === 'applied' ? 'applied' : 'profiled',
    applied: existing?.applied,
    original: `${key}${extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin'}`,
  };
  mkdirSync(DIR(doc), { recursive: true });
  const orig = join(DIR(doc), profile.original!);
  if (!existsSync(orig)) writeFileSync(orig, buf);
  writeProfile(profile);
  return profile;
}

/** A read-only query result as a snapshot: the policy of the SQL panel, then the same profiling; nothing is placed yet. */
export async function intakeQuery(doc: string, by: Author, connectionId: string, sql: string, who: { visible: (c: { id: string }) => boolean; authorize: (c: { id: string }, sql: string) => void }): Promise<IntakeProfile> {
  const c = listConnections().find((x) => x.id === connectionId && who.visible(x));
  if (!c) throw new Error('connection not found');
  who.authorize(c, sql);
  const r: QueryResult = await runQuery(c, sql, 50_000);
  // the result's values are already under their declared kinds (sql.ts); the kinds travel with the text so the profiler keeps the contract
  const rows = [r.columns, ...r.rows.map((row) => row.map((v) => (v === null || v === undefined ? '' : String(v))))];
  const text = rows.map((row) => row.map((v) => `"${v.replace(/"/g, '""')}"`).join(',')).join('\n');
  // the series is the table the query reads (its first FROM), else the connection: the snapshot's name carries no date, so
  // the period comes from a date column in the result, or the day it arrived
  const from = /\bfrom\s+([a-zA-Z_][\w.]*)/i.exec(sql)?.[1]?.split('.').pop() ?? '';
  const base = (from || c.name).replace(/[^\w-]+/g, '-').toLowerCase();
  const name = `${base}.csv`;
  const p = intake(doc, by, { name, text, origin: 'sql', kinds: r.kinds });
  p.query = { connection: c.name, sql: sql.slice(0, 2000), rows: r.rowCount, truncated: r.truncated, kinds: r.kinds };
  if (!p.period) p.period = now().slice(0, 10);
  writeProfile(p);
  return p;
}

// ------------------------------------------------------------------ placing
export interface Placement {
  /** which set of the profile (default: all) and how to place each */
  decisions: { set?: string; action: 'update' | 'new' | 'history' | 'skip'; table?: number; name?: string }[];
  period?: string;
}

const columnFormats = (set: IntakeSet): { col: number; format: string }[] => set.columns.filter((c) => c.type === 'date' || (c.type === 'number' && AMOUNT_HEADER.test(words(c.header)))).map((c) => ({ col: c.index, format: c.type === 'date' ? 'yyyy-mm-dd' : c.unit === 'Kz' || c.unit === 'AOA' ? '#,##0.00 "Kz"' : c.unit === 'USD' || c.unit === '$' ? '$#,##0.00' : c.unit === 'EUR' || c.unit === '€' ? '€#,##0.00' : '#,##0.00' }));

const letters = (c: number) => {
  let s = '';
  let n = c;
  for (;;) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    if (n < 26) break;
    n = Math.floor(n / 26) - 1;
  }
  return s;
};

type PlacementHook = (profile: IntakeProfile, by: Author, placed: NonNullable<IntakeProfile['applied']>['tables']) => void;
let placementHook: PlacementHook | null = null;
/** Called after every placement (sources.ts turns a placed SQL snapshot into a source definition with its recipe). */
export function setPlacementHook(fn: PlacementHook | null) {
  placementHook = fn;
}
let declineHook: ((profile: IntakeProfile, by: Author) => void) | null = null;
export function setDeclineHook(fn: typeof declineHook) {
  declineHook = fn;
}

/** A profile a person decided not to place: it stays on record (the original kept) and is not offered again. */
export function declineIntake(doc: string, by: Author, key: string): IntakeProfile {
  const p = readProfile(doc, key);
  if (!p) throw new Error('intake not found');
  if (p.status === 'applied') throw new Error('already placed');
  p.status = 'declined';
  writeProfile(p);
  try {
    declineHook?.(p, by);
  } catch (e) {
    console.error('decline hook failed:', errorMessage(e));
  }
  return p;
}

/** The originals and profiles of a document go with it when it is deleted (they are reachable through nothing else). */
export function deleteIntake(doc: string) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(doc)) return;
  rmSync(DIR(doc), { recursive: true, force: true });
}

/** Place a profiled intake as a person decided: through the log, one operation after another, then the source record, the check and the first reading. */
export function applyIntake(doc: string, by: Author, key: string, placement: Placement, notify?: (entries: LogEntry[]) => void): IntakeProfile {
  const p = readProfile(doc, key);
  if (!p) throw new Error('intake not found');
  if (p.status === 'applied') throw new Error(`already placed on ${p.applied?.at.slice(0, 10)}`);
  const period = placement.period ? String(placement.period).slice(0, 40) : p.period;
  const actions: Action[] = [];
  const plan: { set: IntakeSet; action: 'update' | 'new' | 'history'; table?: number; name: string }[] = [];
  for (const set of p.sets) {
    const d = placement.decisions.find((x) => !x.set || x.set === set.name) ?? { action: set.relation.recommended === 'skip' ? 'skip' : set.relation.recommended };
    if (d.action === 'skip') continue;
    if (!set.rows.length) throw new Error('nothing to place');
    if (d.action === 'update') {
      const table = d.table ?? set.relation.table?.id;
      if (typeof table !== 'number') throw new Error('update needs a table');
      plan.push({ set, action: 'update', table, name: set.relation.table?.name ?? String(table) });
    } else {
      const name = (d.name ?? (d.action === 'history' && period ? `${set.name} ${period}` : set.relation.name ?? set.name)).slice(0, 120);
      plan.push({ set, action: d.action, name });
    }
  }
  if (!plan.length) throw new Error('nothing to place (every set skipped)');
  const { book } = openDocument(doc);
  const metas = tableMetas(book);
  book.free();
  // two passes: the tables and their values first, then the column formats (a new table must exist before it can be formatted)
  const formats: Action[] = [];
  for (const item of plan) {
    const rows = item.set.rows.length;
    const cols = item.set.cols;
    if (item.action === 'update') {
      const meta = metas.find((m) => m.id === item.table);
      if (!meta) throw new Error(`table ${item.table} not found`);
      // the same table keeps its id, name, formulas elsewhere and watches: what the new snapshot does not cover is cleared first
      const blank: string[][] = Array.from({ length: Math.max(meta.rows, rows) }, () => new Array(Math.max(meta.cols, cols)).fill(''));
      actions.push({ action: 'set_cells', table: meta.name, ref: 'A1', values: blank });
      actions.push({ action: 'resize_table', table: meta.name, rows, cols });
      actions.push({ action: 'set_cells', table: meta.name, ref: 'A1', values: item.set.rows.map((r) => [...r, ...new Array(cols - r.length).fill('')]) });
      for (const f of columnFormats(item.set)) formats.push({ action: 'set_format', table: meta.name, ref: `${letters(f.col)}2:${letters(f.col)}${rows}`, format: { number_format: f.format } });
    } else {
      let name = item.name;
      let n = 2;
      while (metas.some((m) => m.name.toLowerCase() === name.toLowerCase()) || plan.some((o) => o !== item && o.action !== 'update' && o.name.toLowerCase() === name.toLowerCase() && plan.indexOf(o) < plan.indexOf(item))) name = `${item.name} ${n++}`;
      item.name = name;
      actions.push({ action: 'add_table', name, rows, cols, values: item.set.rows });
      for (const f of columnFormats(item.set)) formats.push({ action: 'set_format', table: name, ref: `${letters(f.col)}2:${letters(f.col)}${rows}`, format: { number_format: f.format } });
    }
  }
  const entries: LogEntry[] = [];
  const origin = p.origin === 'sql' ? 'sql' : 'import';
  const note = `intake ${p.key}: ${p.name}`;
  // the log is the authority: a placement already in it (an interruption after the commit, a second tap, a retry)
  // is not committed again — the source record and the profile are completed from what the log holds
  const prior = readAll(doc).filter((e) => e.note === note && e.op);
  if (prior.length) {
    const added = prior.filter((e) => e.op!.type === 'add_table').map((e) => String(e.op!.name));
    let n = 0;
    for (const item of plan) if (item.action !== 'update') item.name = added[n++] ?? item.name;
    entries.push(...prior);
  } else {
    const commit = (acts: Action[], strict: boolean) => {
      if (!acts.length) return;
      const v = validateActions(doc, acts);
      if (v.errors.length && strict) throw new Error(`cannot place: ${v.errors.join('; ')}`);
      // commit through the log, as every change is; the editors receive the operations in order
      for (const op of v.ops) {
        const seq = appendEntry(doc, { author: by, origin, op, note });
        entries.push({ seq, ts: now(), author: by, origin, op });
      }
    };
    commit(actions, true);
    commit(formats, false);
    crashPoint('intake:placed');
    notify?.(entries);
  }
  // which tables now hold the sets: updates keep their id; new tables are found by name
  const after = openDocument(doc);
  const metasAfter = tableMetas(after.book);
  after.book.free();
  const placed: NonNullable<IntakeProfile['applied']>['tables'] = [];
  const records: string[] = [];
  const state = loadState(doc);
  for (const item of plan) {
    const table = item.action === 'update' ? item.table! : metasAfter.find((m) => m.name === item.name)?.id;
    if (typeof table !== 'number') continue;
    // a record this placement already made (before an interruption) is kept, not made twice
    const had = state.records.find((r) => r.kind === 'source' && r.intake === p.key && r.links?.some((l) => l.table === table));
    if (had) {
      placed.push({ set: item.set.name, table, name: item.name, placed: item.action });
      records.push(had.id);
      continue;
    }
    placed.push({ set: item.set.name, table, name: item.action === 'update' ? item.name : item.name, placed: item.action });
    const idCol = item.set.columns.find((c) => c.type === 'identifier');
    const ent = item.set.columns.find((c) => c.constant && !AMOUNT_HEADER.test(words(c.header)) && !DATE_HEADER.test(words(c.header)));
    const fields = item.set.columns.map((c) => c.header);
    const text = `${item.action === 'update' ? 'Updated' : 'Imported'} ${item.name} from ${p.name}: ${item.set.dataRows} row${item.set.dataRows === 1 ? '' : 's'}${fields.length ? ` (${fields.slice(0, 12).join(', ')}${fields.length > 12 ? ', …' : ''})` : ''}`;
    // a snapshot placed as an update belongs to the table's series, whatever the file was called (a "corrected" export is still the inventory)
    const series = item.action === 'update' ? (item.set.relation.series ?? p.family) : item.action === 'history' ? `${item.set.relation.series ?? p.family} (history)` : p.family;
    const r = addRecord(doc, by, p.origin === 'agent' ? 'agent' : 'user', { kind: 'source', text, source: series, period, links: [{ table }], intake: p.key, coverage: { rows: item.set.dataRows, identifiers: idCol ? idCol.unique : undefined, idColumn: idCol?.header, entity: ent ? `${ent.header}: ${ent.constant}` : undefined } });
    records.push(r.id);
  }
  p.status = 'applied';
  p.period = period;
  p.applied = { at: now(), by: by.name || by.login || 'someone', decision: plan.map((x) => `${x.action}:${x.name}`).join(', '), tables: placed, records, seqs: entries.map((e) => e.seq), recovered: prior.length ? true : undefined };
  writeProfile(p);
  try {
    placementHook?.(p, by, placed);
  } catch (e) {
    console.error('placement hook failed:', errorMessage(e));
  }
  // the checks run now (cross-checks between sources, watches on the new snapshot) and the first reading is recorded
  try {
    checkDocument(doc, 'intake', placed.map((x) => x.table));
  } catch (e) {
    console.error('check after intake failed:', errorMessage(e));
  }
  for (const t of placed) {
    try {
      firstReading(doc, t.table, by);
    } catch (e) {
      console.error('first reading failed:', errorMessage(e));
    }
  }
  return p;
}

// ------------------------------------------------------------------ the first reading
export interface Reading {
  table: number;
  name: string;
  period?: string;
  figures: { label: string; formula: string; value: number | string | boolean | null; note?: string }[];
  text: string;
}

const q = (name: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`);
const col = (table: string, header: string) => `${q(table)}[${header}]`;
const fmtN = (v: number) => (Number.isInteger(v) ? v.toLocaleString('en-GB') : v.toLocaleString('en-GB', { maximumFractionDigits: 2 }));

/** What one snapshot says, with each figure's formula as evidence — and what it cannot say: a trend, from one observation. */
export function readingOf(doc: string, tableId: number): Reading | null {
  if (!engineAvailable() || !readFile(doc)) return null;
  const s = loadState(doc);
  const { book } = openDocument(doc);
  try {
    const t = tableMetas(book).find((m) => m.id === tableId);
    if (!t || t.header_rows < 1) return null;
    const cells = JSON.parse(book.cells(t.id)) as CellViewJson[];
    const headers = tableHeaders(cells, t);
    const prof = (h: string) => {
      const c = headers.get(h)!;
      const vals = cells.filter((x) => x.c === c && x.r >= t.header_rows && x.v);
      return { numbers: vals.filter((x) => 'n' in x.v!).length, yesNo: vals.filter((x) => 's' in x.v! && /^(yes|no|sim|n[ãa]o)$/i.test((x.v as { s: string }).s)).length, max: Math.max(0, ...vals.map((x) => ('n' in x.v! ? (x.v as { n: number }).n : 0))) };
    };
    const names = [...headers.keys()];
    const original = (h: string) => cells.find((x) => x.r === t.header_rows - 1 && x.c === headers.get(h))!.v as { s: string };
    const eval_ = (formula: string) => {
      try {
        const v = JSON.parse(book.preview(t.id, formula)) as { n?: number; b?: boolean; s?: string; e?: string } | null;
        if (!v) return null;
        if ('e' in v && v.e) return `#${v.e}`;
        return 'n' in v ? (v.n ?? null) : 'b' in v ? !!v.b : 's' in v ? (v.s ?? null) : null;
      } catch (e) {
        return `#${errorMessage(e)}`;
      }
    };
    const figures: Reading['figures'] = [];
    const dataRows = Math.max(0, t.rows - t.header_rows);
    const idH = names.find((h) => ID_HEADER.test(words(h)) && prof(h).numbers < 1);
    const keyH = idH ?? names[0];
    const rowWord = /vehic|viatur|carro|stock|invent/i.test(t.name) ? 'vehicles' : 'rows';
    const countF = `=COUNTA(${col(t.name, original(keyH).s)})`;
    const count = eval_(countF);
    figures.push({ label: rowWord, formula: countF, value: count });
    const amountH = names.find((h) => AMOUNT_HEADER.test(words(h)) && prof(h).numbers >= Math.max(1, dataRows * 0.5) && !/days|dias/i.test(h));
    const daysH = names.find((h) => /\b(days?|age|ageing|aging|dias|idade)\b/i.test(h) && prof(h).numbers >= Math.max(1, dataRows * 0.5));
    const flagH = names.find((h) => prof(h).yesNo >= Math.max(1, dataRows * 0.8) && /reserv|hold|sold|exclu|vendid|block/i.test(h)) ?? names.find((h) => prof(h).yesNo >= Math.max(1, dataRows * 0.8));
    if (amountH) {
      const f = `=SUM(${col(t.name, original(amountH).s)})`;
      figures.push({ label: `total ${original(amountH).s} (capital tied up)`, formula: f, value: eval_(f) });
      const b = `=COUNTIFS(${col(t.name, original(amountH).s)}, ""${keyH !== amountH ? `, ${col(t.name, original(keyH).s)}, "<>"` : ''})`;
      const blanks = eval_(b);
      figures.push({ label: `${rowWord} with no ${original(amountH).s}`, formula: b, value: blanks, note: typeof blanks === 'number' && blanks > 0 ? 'the total is provisional' : undefined });
    }
    if (daysH) {
      const limit = prof(daysH).max >= 90 ? 90 : 30;
      const cond = flagH ? `, ${col(t.name, original(flagH).s)}, "no"` : '';
      const f = `=COUNTIFS(${col(t.name, original(daysH).s)}, ">${limit}"${cond})`;
      figures.push({ label: `${rowWord} over ${limit} days${flagH ? ` (excluding ${original(flagH).s} = yes)` : ''}`, formula: f, value: eval_(f) });
      if (amountH) {
        const g = `=SUMIFS(${col(t.name, original(amountH).s)}, ${col(t.name, original(daysH).s)}, ">${limit}"${cond})`;
        figures.push({ label: `${original(amountH).s} of those over ${limit} days`, formula: g, value: eval_(g) });
      }
    }
    if (flagH) {
      const f = `=COUNTIF(${col(t.name, original(flagH).s)}, "yes")`;
      figures.push({ label: `${original(flagH).s} = yes`, formula: f, value: eval_(f) });
    }
    const period = (() => {
      for (const r of s.records) if (r.kind === 'source' && r.status !== 'retired' && r.status !== 'superseded') for (const l of r.links ?? []) if (l.table === t.id && r.period) return r.period;
      return undefined;
    })();
    const singular = (label: string, v: unknown) => (v === 1 && label.startsWith(rowWord) ? label.replace(rowWord, rowWord === 'vehicles' ? 'vehicle' : 'row') : label);
    const parts = figures.map((f) => `${typeof f.value === 'number' ? fmtN(f.value) : String(f.value ?? '—')} ${singular(f.label, f.value)}${f.note ? ` — ${f.note}` : ''}`);
    const text = `${t.name}${period ? ` (${period})` : ''}: ${parts.join('; ')}. One snapshot: what it holds, not how it is moving — a trend needs the next one.`;
    return { table: t.id, name: t.name, period, figures, text };
  } finally {
    book.free();
  }
}

/** Record the first reading of a table as an event — the companion's first contribution, with formulas behind every figure. */
export function firstReading(doc: string, tableId: number, by: Author): Reading | null {
  const r = readingOf(doc, tableId);
  if (!r) return null;
  noteEvent(doc, { kind: 'reading', text: `First reading — ${r.text}`, by: by.name || 'someone', level: 'quiet' });
  return r;
}

// ------------------------------------------------------------------ the inbox adapter
/**
 * Files placed in GRIDWRIGHT_INBOX (one directory, read on request — not watched): what is there, with
 * family and period. With accounts every client has its own folder inside it, named by the client's
 * slug (GRIDWRIGHT_INBOX/<slug>/), and sees only that one.
 */
export function inboxRoot(tenant?: string): string | null {
  const root = (process.env.GRIDWRIGHT_INBOX ?? '').trim();
  if (!root || !existsSync(root)) return null;
  if (!ACCOUNTS) return resolve(root);
  const slug = tenant ? getTenant(tenant)?.slug : undefined;
  if (!slug) return null;
  const dir = resolve(root, slug);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  return dir;
}
export interface InboxFile {
  name: string;
  size: number;
  modified: string;
  family: string;
  period?: string;
}
export function listInbox(tenant?: string): InboxFile[] {
  const root = inboxRoot(tenant);
  if (!root) return [];
  const out: InboxFile[] = [];
  for (const f of readdirSync(root)) {
    if (f.startsWith('.') || !/\.(csv|tsv|txt|xlsx|xlsm|xls|ods|xml|json)$/i.test(f)) continue;
    const st = statSync(join(root, f));
    if (st.isFile() && st.size <= MAX_INTAKE_BYTES) out.push({ name: f, size: st.size, modified: st.mtime.toISOString(), family: familyOf(f), period: periodFromName(f) });
  }
  return out.sort((a, b) => (a.modified < b.modified ? -1 : 1));
}
/** Take one file from the inbox into a document's intake (the file stays until it is placed, then moves to taken/). */
export function intakeFromInbox(doc: string, by: Author, name: string): IntakeProfile {
  const root = inboxRoot(tenantOfDoc(doc));
  if (!root) throw new Error('no inbox configured (GRIDWRIGHT_INBOX)');
  const safe = basename(name);
  const path = resolve(root, safe);
  if (!path.startsWith(root + '/') || !existsSync(path) || !statSync(path).isFile()) throw new Error('no such file in the inbox');
  const buf = readFileSync(path);
  return intake(doc, by, { name: safe, base64: buf.toString('base64'), origin: 'inbox' });
}
export function inboxTaken(name: string, key: string, doc: string) {
  const root = inboxRoot(tenantOfDoc(doc));
  if (!root) return;
  const safe = basename(name);
  const path = resolve(root, safe);
  if (!path.startsWith(root + '/') || !existsSync(path)) return;
  const taken = join(root, 'taken');
  mkdirSync(taken, { recursive: true });
  renameSync(path, join(taken, `${key}-${safe}`));
}

// Display formatting of cell values — the same rules as the engine's TEXT() (format_text in
// core/src/formula/eval.rs; e2e/numerics.mjs checks they agree): `0`, `0.00`, `#,##0`,
// `#,##0.00`, `0%`, `€#,##0.00`, `#,##0.00 "Kz"`, `#.##0,00` (decimal comma), `#,##0,`
// (thousands), sections `positive;negative;zero;text` (accounting formats), `yyyy-mm-dd`,
// `dd/mm/yyyy hh:mm`, `d mmm yyyy`, `dddd`, and the legacy `currency:EUR` shortcut.

import type { CellValue, CellView, Format } from '../engine/types';
import { fixedAbs, formatNumberPlain } from '../engine/types';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function serialToDate(serial: number): Date {
  return new Date(Math.round((serial - 25569) * 86400000));
}

export function dateToSerial(d: Date): number {
  return d.getTime() / 86400000 + 25569;
}

function pad(n: number, w = 2) {
  return String(n).padStart(w, '0');
}

export function formatDate(serial: number, pattern: string): string {
  const d = serialToDate(serial);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const secs = Math.round((serial - Math.floor(serial)) * 86400);
  const hh = Math.floor(secs / 3600);
  const mi = Math.floor(secs / 60) % 60;
  const ss = secs % 60;
  const wd = (Math.floor(serial) - 25569 + 3 + 7000) % 7; // Monday = 0
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i].toLowerCase();
    if (pattern[i] === '"') {
      i++;
      while (i < pattern.length && pattern[i] !== '"') out += pattern[i++];
      i++;
      continue;
    }
    if ('ymdhs'.includes(c)) {
      let run = 1;
      while (i + run < pattern.length && pattern[i + run].toLowerCase() === c) run++;
      switch (c) {
        case 'y':
          out += run >= 4 ? pad(y, 4) : pad(((y % 100) + 100) % 100);
          break;
        case 'm':
          if (run === 1) out += out.endsWith(':') ? String(mi) : String(m);
          else if (run === 2) out += out.endsWith(':') ? pad(mi) : pad(m);
          else if (run === 3) out += MONTHS[m - 1].slice(0, 3);
          else out += MONTHS[m - 1];
          break;
        case 'd':
          if (run === 1) out += String(day);
          else if (run === 2) out += pad(day);
          else if (run === 3) out += DAYS[wd].slice(0, 3);
          else out += DAYS[wd];
          break;
        case 'h':
          out += run === 1 ? String(hh) : pad(hh);
          break;
        case 's':
          out += run === 1 ? String(ss) : pad(ss);
          break;
      }
      i += run;
      continue;
    }
    out += pattern[i++];
  }
  return out;
}

function isDatePattern(p: string): boolean {
  const stripped = p.replace(/"[^"]*"/g, '').toLowerCase();
  return /yy|dd|mmm|hh|h:|d /.test(stripped);
}

/** The open workbook writes numbers with a decimal comma ("1.234,56"): set when it loads or changes. */
let decimalCommaDisplay = false;
export function setDecimalCommaDisplay(on: boolean) {
  decimalCommaDisplay = on;
}

/** The sections of a pattern (`positive;negative;zero;text`), split at `;` outside quotes,
 *  brackets and escapes. */
function splitSections(f: string): string[] {
  const out = [''];
  let inq = false;
  let inb = false;
  for (let i = 0; i < f.length; i++) {
    const c = f[i];
    if (c === '"' && !inb) inq = !inq;
    else if (c === '[' && !inq) inb = true;
    else if (c === ']' && !inq) inb = false;
    else if (c === '\\' && !inq && !inb) {
      out[out.length - 1] += c + (f[i + 1] ?? '');
      i++;
      continue;
    } else if (c === ';' && !inq && !inb) {
      out.push('');
      continue;
    }
    out[out.length - 1] += c;
  }
  return out;
}

type Tok = { lit: string } | { num: string } | { text: true };

/** Quoted text, `\x`, `_x` (a space), `*x` (fill: nothing), `[Red]` (ignored), `@`, `0 # ? . , %`. */
function tokenize(sec: string): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < sec.length; i++) {
    const c = sec[i];
    if (c === '"') {
      let lit = '';
      i++;
      while (i < sec.length && sec[i] !== '"') lit += sec[i++];
      out.push({ lit });
    } else if (c === '\\') {
      if (i + 1 < sec.length) out.push({ lit: sec[i + 1] });
      i++;
    } else if (c === '_') {
      out.push({ lit: ' ' });
      i++;
    } else if (c === '*') i++;
    else if (c === '[') {
      while (i < sec.length && sec[i] !== ']') i++;
    } else if (c === '@') out.push({ text: true });
    else if ('0#?.,%'.includes(c)) out.push({ num: c });
    else out.push({ lit: c });
  }
  return out;
}

function textSection(text: string, sec: string): string {
  return tokenize(sec)
    .map((t) => ('lit' in t ? t.lit : 'num' in t ? t.num : text))
    .join('');
}

type NumberSection = (x: number, signed: boolean, comma: boolean) => string;

/** One numeric section, compiled; mirrors format_number_section in eval.rs. `comma` (a
 *  decimal-comma workbook) shows every pattern as "1.234,56": the pattern still decides
 *  the decimals and the grouping. */
function compileSection(sec: string): NumberSection {
  if (sec.trim().toLowerCase() === 'general') {
    return (x, signed, comma) => {
      const s = formatNumberPlain(signed ? x : Math.abs(x));
      return comma ? s.replace('.', ',') : s;
    };
  }
  let prefix = '';
  let core = '';
  let suffix = '';
  let state = 0;
  let pct = false;
  for (const t of tokenize(sec)) {
    if ('num' in t) {
      if (t.num === '%' && state === 2) {
        pct = true;
        suffix += '%';
      } else if (state < 2) {
        state = 1;
        core += t.num;
      } else suffix += t.num;
    } else if ('lit' in t) {
      if (state === 0) prefix += t.lit;
      else {
        state = 2;
        suffix += t.lit;
      }
    }
  }
  if (!/[0#?]/.test(core)) {
    return (x, signed) => `${signed && x < 0 ? '-' : ''}${prefix}${core}${suffix}`;
  }
  if (core.includes('%')) pct = true;
  core = core.replace(/%/g, '');
  // commas after the last digit placeholder divide by 1000 each ("#,##0," "0.0,,")
  const trimmed = core.replace(/,+$/, '');
  let scale = 1000 ** (core.length - trimmed.length);
  core = trimmed;
  const lastDot = core.lastIndexOf('.');
  const lastComma = core.lastIndexOf(',');
  let decimalComma = false;
  if (lastDot >= 0 && lastComma >= 0) decimalComma = lastComma > lastDot;
  else if (lastComma >= 0) {
    const after = core.slice(lastComma + 1);
    decimalComma = after.length > 0 && /^0+$/.test(after);
  }
  const decSep = decimalComma ? ',' : '.';
  const grpSep = decimalComma ? '.' : ',';
  const at = core.indexOf(decSep);
  let intPat = at >= 0 ? core.slice(0, at) : core;
  const fracPat = at >= 0 ? core.slice(at + 1) : null;
  while (!decimalComma && intPat.endsWith(grpSep)) {
    intPat = intPat.slice(0, -1);
    scale *= 1000;
  }
  const grouped = intPat.includes(grpSep);
  const fracPh = [...(fracPat ?? '')].filter((c) => '0#?'.includes(c));
  const minDigits = [...intPat].filter((c) => c === '0').length;
  const slots = [...intPat].filter((c) => '0#?'.includes(c)).length;
  const leadQ = [...(intPat.match(/^[^0#]*/)?.[0] ?? '')].filter((c) => c === '?').length;
  return (x0, signed, comma) => {
    const ds = comma ? ',' : decSep;
    const gs = comma ? '.' : grpSep;
    const x = (pct ? x0 * 100 : x0) / scale;
    const body = fixedAbs(x, fracPh.length);
    const dot = body.indexOf('.');
    let intDigits = dot >= 0 ? body.slice(0, dot) : body;
    const frac = dot >= 0 ? [...body.slice(dot + 1)] : [];
    const nonzero = /[1-9]/.test(body);
    if (intDigits === '0') intDigits = '';
    if (intDigits.length < minDigits) intDigits = '0'.repeat(minDigits - intDigits.length) + intDigits;
    let g = intDigits;
    if (grouped) {
      g = '';
      for (let i = 0; i < intDigits.length; i++) {
        if (i > 0 && (intDigits.length - i) % 3 === 0) g += gs;
        g += intDigits[i];
      }
    }
    if (leadQ > 0 && intDigits.length < slots) g = ' '.repeat(Math.min(slots - intDigits.length, leadQ)) + g;
    for (let j = frac.length; j > 0; j--) {
      const ph = fracPh[j - 1];
      if (ph === '0' || frac[j - 1] !== '0') break;
      if (ph === '#') frac.splice(j - 1, 1);
      else frac[j - 1] = ' ';
    }
    const num = fracPat !== null ? `${g}${ds}${frac.join('')}` : g;
    const neg = signed && x < 0 && nonzero;
    return `${neg ? '-' : ''}${prefix}${num}${pct && !suffix.includes('%') ? '%' : ''}${suffix}`;
  };
}

type Compiled = { number: (n: number, comma: boolean) => string; text: ((s: string) => string) | null };
const fmtCache = new Map<string, Compiled>();

function compileNumber(pattern: string): Compiled {
  const cached = fmtCache.get(pattern);
  if (cached) return cached;
  let out: Compiled;
  const p = pattern.trim();
  if (p.startsWith('currency:')) {
    const code = p.slice(9).trim().toUpperCase() || 'USD';
    const symbol = code === 'AOA' ? 'Kz' : code === 'EUR' ? '€' : code === 'USD' ? '$' : code === 'GBP' ? '£' : code;
    out = compileNumber(code === 'AOA' ? `#,##0.00 "${symbol}"` : `${symbol}#,##0.00`);
  } else {
    const sections = splitSections(p);
    const fns = sections.slice(0, 3).map(compileSection);
    const n = sections.length;
    out = {
      number: (x, comma) => {
        if (n === 1) return fns[0](x, true, comma);
        if (x < 0) return fns[1](-x, false, comma);
        if (n >= 3 && x === 0) return fns[2](x, false, comma);
        return fns[0](x, true, comma);
      },
      text: n >= 4 ? (s) => textSection(s, sections[3]) : n === 1 && sections[0].includes('@') ? (s) => textSection(s, sections[0]) : null,
    };
  }
  if (fmtCache.size > 500) fmtCache.clear();
  fmtCache.set(pattern, out);
  return out;
}

/** Format a number with a spreadsheet-style pattern. `canonical` ignores the workbook's decimal
 *  comma: for text a program reads back (the assistant's view of the sheet), not for people. */
export function formatNumber(n: number, pattern?: string, canonical = false): string {
  const comma = decimalCommaDisplay && !canonical;
  const p = (pattern ?? '').trim();
  if (!p) {
    const s = formatNumberPlain(n);
    return comma ? s.replace('.', ',') : s;
  }
  if (isDatePattern(p)) return formatDate(n, p);
  return compileNumber(p).number(n, comma);
}

export function displayValue(v: CellValue, f?: Format, canonical = false): string {
  if (v === null || v === undefined) return '';
  if ('n' in v) return formatNumber(v.n, f?.number_format, canonical);
  if ('s' in v) {
    // a pattern's text section ("…;…;…;@") applies to text, as in TEXT()
    const p = f?.number_format?.trim();
    return p && !isDatePattern(p) ? (compileNumber(p).text?.(v.s) ?? v.s) : v.s;
  }
  if ('b' in v) return v.b ? 'TRUE' : 'FALSE';
  if ('e' in v) return v.e;
  return '';
}

export function displayOf(cell: CellView | undefined, canonical = false): string {
  if (!cell) return '';
  if (cell.v === null && cell.k !== 'value' && cell.i) {
    // pending/failed code cell without output
    return cell.err ? '#ERROR!' : '';
  }
  return displayValue(cell.v, cell.f, canonical);
}

export function alignOf(cell: CellView | undefined): 'left' | 'right' | 'center' {
  if (!cell) return 'left';
  if (cell.f?.align) return cell.f.align;
  if (cell.v && ('n' in cell.v || 'b' in cell.v)) return 'right';
  return 'left';
}

export const NUMBER_FORMATS: { label: string; value: string }[] = [
  { label: 'General', value: '' },
  { label: 'Number 0.00', value: '0.00' },
  { label: 'Integer', value: '0' },
  { label: 'Thousands 1,000', value: '#,##0' },
  { label: 'Thousands 1,000.00', value: '#,##0.00' },
  { label: 'Thousands 1.000,00 (pt)', value: '#.##0,00' },
  { label: 'Percent 0%', value: '0%' },
  { label: 'Percent 0.0%', value: '0.0%' },
  { label: 'Kz 1,000.00', value: '#,##0.00 "Kz"' },
  { label: '1.000,00 Kz (pt)', value: '#.##0,00 "Kz"' },
  { label: '€ 1,000.00', value: '€#,##0.00' },
  { label: '$ 1,000.00', value: '$#,##0.00' },
  { label: 'Date yyyy-mm-dd', value: 'yyyy-mm-dd' },
  { label: 'Date dd/mm/yyyy', value: 'dd/mm/yyyy' },
  { label: 'Date 8 Oct 2026', value: 'd mmm yyyy' },
  { label: 'Date & time', value: 'yyyy-mm-dd hh:mm' },
  { label: 'Time hh:mm', value: 'hh:mm' },
];

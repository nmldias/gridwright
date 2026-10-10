// Display formatting of cell values — the same rules as the engine's TEXT():
// `0`, `0.00`, `#,##0`, `#,##0.00`, `0%`, `€#,##0.00`, `#,##0.00 "Kz"`, `#.##0,00`
// (decimal comma), `yyyy-mm-dd`, `dd/mm/yyyy hh:mm`, `d mmm yyyy`, `dddd`, and the
// legacy `currency:EUR` shortcut.

import type { CellValue, CellView, Format } from '../engine/types';
import { formatNumberPlain } from '../engine/types';

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

const fmtCache = new Map<string, (n: number) => string>();

function compileNumber(pattern: string): (n: number) => string {
  const cached = fmtCache.get(pattern);
  if (cached) return cached;
  let fn: (n: number) => string;
  const p = pattern.trim();
  if (p.startsWith('currency:')) {
    const code = p.slice(9).trim().toUpperCase() || 'USD';
    const symbol = code === 'AOA' ? 'Kz' : code === 'EUR' ? '€' : code === 'USD' ? '$' : code === 'GBP' ? '£' : code;
    const inner = compileNumber(code === 'AOA' ? `#,##0.00 "${symbol}"` : `${symbol}#,##0.00`);
    fn = inner;
  } else {
    // split prefix / core / suffix
    let prefix = '';
    let core = '';
    let suffix = '';
    let state = 0;
    let inq = false;
    for (const c of p) {
      if (c === '"') {
        inq = !inq;
        if (state === 1) state = 2;
        continue;
      }
      const numeric = !inq && '0#.,%'.includes(c);
      if (state === 0 && numeric) {
        state = 1;
        core += c;
      } else if (state === 0) prefix += c;
      else if (state === 1 && numeric) core += c;
      else if (state === 1) {
        state = 2;
        suffix += c;
      } else suffix += c;
    }
    const pct = core.endsWith('%');
    const lastDot = core.lastIndexOf('.');
    const lastComma = core.lastIndexOf(',');
    let decimalComma = false;
    if (lastDot >= 0 && lastComma >= 0) decimalComma = lastComma > lastDot;
    else if (lastComma >= 0) {
      const after = core.slice(lastComma + 1).replace(/%$/, '');
      decimalComma = after.length > 0 && /^0+$/.test(after);
    }
    const decimals = decimalComma ? (core.split(',').pop() ?? '').split('0').length - 1 : (core.split('.')[1] ?? '').split('0').length - 1;
    const grouped = decimalComma ? core.includes('.') : core.includes(',');
    const decSep = decimalComma ? ',' : '.';
    const grpSep = decimalComma ? '.' : ',';
    fn = (n: number) => {
      const x = pct ? n * 100 : n;
      const body = Math.abs(x).toFixed(decimals);
      const [intPart, frac] = body.split('.');
      let g = intPart;
      if (grouped) {
        g = '';
        for (let i = 0; i < intPart.length; i++) {
          if (i > 0 && (intPart.length - i) % 3 === 0) g += grpSep;
          g += intPart[i];
        }
      }
      const num = frac !== undefined ? `${g}${decSep}${frac}` : g;
      const neg = x < 0 && /[1-9]/.test(num);
      return `${neg ? '-' : ''}${prefix}${num}${pct ? '%' : ''}${suffix}`;
    };
  }
  if (fmtCache.size > 500) fmtCache.clear();
  fmtCache.set(pattern, fn);
  return fn;
}

/** Format a number with a spreadsheet-style pattern. */
export function formatNumber(n: number, pattern?: string): string {
  if (!pattern) return formatNumberPlain(n);
  const p = pattern.trim();
  if (!p) return formatNumberPlain(n);
  if (isDatePattern(p)) return formatDate(n, p);
  return compileNumber(p)(n);
}

export function displayValue(v: CellValue, f?: Format): string {
  if (v === null || v === undefined) return '';
  if ('n' in v) return formatNumber(v.n, f?.number_format);
  if ('s' in v) return v.s;
  if ('b' in v) return v.b ? 'TRUE' : 'FALSE';
  if ('e' in v) return v.e;
  return '';
}

export function displayOf(cell: CellView | undefined): string {
  if (!cell) return '';
  if (cell.v === null && cell.k !== 'value' && cell.i) {
    // pending/failed code cell without output
    return cell.err ? '#ERROR!' : '';
  }
  return displayValue(cell.v, cell.f);
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

// Display formatting of cell values.

import type { CellValue, CellView, Format } from '../engine/types';
import { formatNumberPlain } from '../engine/types';

const nfCache = new Map<string, Intl.NumberFormat>();

function nf(key: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  let f = nfCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat('en-GB', opts);
    nfCache.set(key, f);
  }
  return f;
}

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
  const hh = d.getUTCHours();
  const mm = d.getUTCMinutes();
  const ss = d.getUTCSeconds();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return pattern
    .replace(/yyyy/gi, String(y))
    .replace(/yy/gi, pad(y % 100))
    .replace(/mmm/gi, months[m - 1])
    .replace(/mm(?!:)/g, pad(m))
    .replace(/dd/gi, pad(day))
    .replace(/hh/gi, pad(hh))
    .replace(/:mm/g, ':' + pad(mm))
    .replace(/ss/gi, pad(ss));
}

/** Format a number with a spreadsheet-style pattern. */
export function formatNumber(n: number, pattern?: string): string {
  if (!pattern) return formatNumberPlain(n);
  const p = pattern.trim();
  if (/yyyy|dd|mmm/i.test(p)) return formatDate(n, p);
  if (p.startsWith('currency:')) {
    const code = p.slice(9).trim().toUpperCase() || 'USD';
    try {
      return nf('cur' + code, { style: 'currency', currency: code }).format(n);
    } catch {
      return formatNumberPlain(n);
    }
  }
  const pct = p.endsWith('%');
  const decimals = (p.split('.')[1] ?? '').replace('%', '').length;
  const grouping = p.includes(',');
  const opts: Intl.NumberFormatOptions = {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: grouping,
  };
  const key = `${decimals}|${grouping}`;
  const out = nf(key, opts).format(pct ? n * 100 : n);
  return pct ? out + '%' : out;
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

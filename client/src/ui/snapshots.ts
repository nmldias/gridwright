// A file name usually says which series it belongs to and which period it describes:
// inventory-2026-10-13.xlsx is the "inventory" series, period 2026-10-13. Arrival is not the period.

const MONTHS: Record<string, string> = { jan: '01', feb: '02', fev: '02', mar: '03', apr: '04', abr: '04', may: '05', mai: '05', jun: '06', jul: '07', aug: '08', ago: '08', sep: '09', set: '09', oct: '10', out: '10', nov: '11', dec: '12', dez: '12' };
const DATE_TOKENS = /[-_. ]*(\d{4}[-_. ]?\d{2}[-_. ]?\d{2}|\d{2}[-_. ]\d{2}[-_. ]\d{4}|\d{4}[-_. ]?(?:0[1-9]|1[0-2])|(?:jan|feb|fev|mar|apr|abr|may|mai|jun|jul|aug|ago|sep|set|oct|out|nov|dec|dez)[a-z]*[-_. ]?\d{4}|[Ww]\d{1,2}[-_. ]?\d{0,4})(?![A-Za-z0-9])[-_. ]*/gi;

/** The period a file name carries: 2026-10-13, 20261013, 13-10-2026, 2026-10, Oct-2026, W41-2026 — or nothing. */
export function periodFromName(name: string): string | undefined {
  const n = name.replace(/\.[^.]+$/, '');
  let m = /(\d{4})[-_. ]?(\d{2})[-_. ]?(\d{2})(?!\d)/.exec(n);
  if (m && Number(m[2]) <= 12 && Number(m[3]) <= 31) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /(?<!\d)(\d{2})[-_. ](\d{2})[-_. ](\d{4})(?!\d)/.exec(n);
  if (m && Number(m[2]) <= 12 && Number(m[1]) <= 31) return `${m[3]}-${m[2]}-${m[1]}`;
  m = /(?<!\d)(\d{4})[-_. ]?(0[1-9]|1[0-2])(?!\d)/.exec(n);
  if (m) return `${m[1]}-${m[2]}`;
  m = /\b(jan|feb|fev|mar|apr|abr|may|mai|jun|jul|aug|ago|sep|set|oct|out|nov|dec|dez)[a-z]*[-_. ]?(\d{4})\b/i.exec(n);
  if (m) return `${m[2]}-${MONTHS[m[1].toLowerCase()]}`;
  m = /\b[Ww](\d{1,2})[-_. ]?(\d{4})?\b/.exec(n);
  if (m) return `${m[2] ? m[2] + ' ' : ''}week ${Number(m[1])}`;
  return undefined;
}

/** The series a file belongs to: its name without extension and without date tokens ("inventory-2026-10-13.xlsx" → "inventory"). */
export function familyOf(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '');
  const stripped = base.replace(DATE_TOKENS, ' ').replace(/\s+/g, ' ').trim();
  return stripped || base;
}

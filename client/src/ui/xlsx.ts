// Excel export: one sheet per table, values, formulas (cross-table references
// become sheet references), number formats and column widths.

import { cellKey, type CellView, type TableMeta } from '../engine/types';
import { getState } from '../state/store';

/** Excel sheet names: ≤31 chars, no []:*?/\ and unique. */
function sheetName(name: string, used: Set<string>): string {
  let base = name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let out = base;
  let n = 2;
  while (used.has(out.toLowerCase())) {
    const suffix = ` (${n++})`;
    out = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(out.toLowerCase());
  return out;
}

function excelSheetRef(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

/** Translate a Gridwright formula body to Excel syntax (Name::A1 → Name!A1, Name[Col] stays). */
function toExcelFormula(body: string, sheetOf: Map<string, string>): string {
  // quoted table names: 'My table'::A1  → 'My table'!A1
  let out = body.replace(/'((?:[^']|'')*)'::/g, (_m, name: string) => `${excelSheetRef(sheetOf.get(name.replace(/''/g, "'").toLowerCase()) ?? name.replace(/''/g, "'"))}!`);
  // bare table names: Sales::A1 → Sales!A1
  out = out.replace(/([A-Za-z_][A-Za-z0-9_]*)::/g, (_m, name: string) => `${excelSheetRef(sheetOf.get(name.toLowerCase()) ?? name)}!`);
  return out;
}

function excelNumberFormat(fmt?: string): string | undefined {
  if (!fmt) return undefined;
  if (fmt.startsWith('currency:')) {
    const code = fmt.slice(9).toUpperCase();
    return code === 'AOA' ? '#,##0.00 "Kz"' : code === 'EUR' ? '€#,##0.00' : code === 'USD' ? '$#,##0.00' : `#,##0.00 "${code}"`;
  }
  // decimal-comma patterns are a display convention here; Excel formats follow the locale
  if (/^#\.##0(,0+)?/.test(fmt)) return fmt.replace(/\./g, '\u0001').replace(/,/g, '.').replace(/\u0001/g, ',');
  return fmt;
}

export async function exportWorkbookXlsx(): Promise<void> {
  const XLSX = await import('xlsx');
  const st = getState();
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  const sheetOf = new Map<string, string>();
  const metas = Array.from(st.tables.values());
  for (const t of metas) sheetOf.set(t.name.toLowerCase(), sheetName(t.name, used));
  for (const t of metas) {
    const ws = buildSheet(XLSX, t, st.cells.get(t.id), sheetOf);
    XLSX.utils.book_append_sheet(wb, ws, sheetOf.get(t.name.toLowerCase()));
  }
  XLSX.writeFile(wb, `${st.fileName || 'workbook'}.xlsx`, { bookType: 'xlsx', compression: true });
}

export async function exportTableXlsx(tableId: number): Promise<void> {
  const XLSX = await import('xlsx');
  const st = getState();
  const t = st.tables.get(tableId);
  if (!t) return;
  const wb = XLSX.utils.book_new();
  const sheetOf = new Map<string, string>();
  for (const m of st.tables.values()) sheetOf.set(m.name.toLowerCase(), m.name.slice(0, 31));
  const ws = buildSheet(XLSX, t, st.cells.get(t.id), sheetOf);
  XLSX.utils.book_append_sheet(wb, ws, sheetName(t.name, new Set()));
  XLSX.writeFile(wb, `${t.name}.xlsx`, { bookType: 'xlsx', compression: true });
}

function buildSheet(XLSX: typeof import('xlsx'), t: TableMeta, cells: Map<number, CellView> | undefined, sheetOf: Map<string, string>) {
  const ws: Record<string, unknown> = {};
  let maxR = 0;
  let maxC = 0;
  for (let r = 0; r < t.rows; r++) {
    for (let c = 0; c < t.cols; c++) {
      const cell = cells?.get(cellKey(r, c));
      if (!cell) continue;
      const addr = XLSX.utils.encode_cell({ r, c });
      const v = cell.v;
      const out: Record<string, unknown> = {};
      if (v === null) {
        if (cell.k === 'formula') out.t = 's', (out.v = '');
        else continue;
      } else if ('n' in v) {
        out.t = 'n';
        out.v = v.n;
      } else if ('s' in v) {
        out.t = 's';
        out.v = v.s;
      } else if ('b' in v) {
        out.t = 'b';
        out.v = v.b;
      } else {
        out.t = 'e';
        out.v = v.e;
      }
      if (cell.k === 'formula' && !cell.s) out.f = toExcelFormula(cell.i.replace(/^=/, ''), sheetOf);
      const z = excelNumberFormat(cell.f?.number_format);
      if (z) out.z = z;
      ws[addr] = out;
      maxR = Math.max(maxR, r);
      maxC = Math.max(maxC, c);
    }
  }
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(maxR, t.rows - 1), c: Math.max(maxC, t.cols - 1) } });
  ws['!cols'] = t.col_widths.map((w) => ({ wpx: Math.round(w) }));
  ws['!rows'] = t.row_heights.map((h, i) => (t.hidden_rows.includes(i) ? { hidden: true } : { hpx: Math.round(h) }));
  return ws as import('xlsx').WorkSheet;
}

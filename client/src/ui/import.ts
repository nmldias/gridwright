// Importing files into the open document: Excel/ODS sheets and CSV become new tables — or, when a
// table with the same columns already exists, the next snapshot of it: same table, same formulas,
// same watches, new data. A Gridwright JSON file replaces the document. Shared by the document
// menu, the Files panel and the start card.

import { joinFile } from '../api/ws';
import * as book from '../engine/book';
import { addTable } from '../grid/actions';
import { cellAt, getState, setStatus, useStore } from '../state/store';
import { parseCsv } from './files';
import { recordImport } from './companion';
import { familyOf, periodFromName } from './snapshots';

export const IMPORT_ACCEPT = '.csv,.tsv,.txt,.json,.xlsx,.xlsm,.xls,.ods';

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** A table whose header row matches the file's: the file is its next snapshot. */
export function matchingTable(fields: string[]): { id: number; name: string; shared: number } | null {
  const st = getState();
  const want = fields.map(norm).filter(Boolean);
  if (want.length < 2) return null;
  let best: { id: number; name: string; shared: number } | null = null;
  for (const t of st.tables.values()) {
    if (t.pivot || t.header_rows < 1) continue;
    const have = new Set<string>();
    for (let c = 0; c < t.cols; c++) {
      const cell = cellAt(t.id, t.header_rows - 1, c);
      const h = cell?.v && 's' in cell.v ? norm(cell.v.s) : '';
      if (h) have.add(h);
    }
    if (!have.size) continue;
    const shared = want.filter((f) => have.has(f)).length;
    if (shared >= Math.ceil(want.length * 0.8) && shared >= Math.ceil(have.size * 0.6) && (!best || shared > best.shared)) best = { id: t.id, name: t.name, shared };
  }
  return best;
}

/** How to treat a file whose columns match a table: ask (default), always replace, always add. Tests set it. */
export function importPolicy(): 'ask' | 'replace' | 'new' {
  const p = (window as unknown as { __gw?: { importPolicy?: string } }).__gw?.importPolicy;
  return p === 'replace' || p === 'new' ? p : 'ask';
}

/** Replace a table's data with the next snapshot: same table id and name, so formulas and watches keep working. */
export function replaceTableData(table: number, values: string[][]) {
  const rows = values.length;
  const cols = Math.max(1, ...values.map((r) => r.length));
  const meta = getState().tables.get(table);
  if (!meta) return;
  // clear what the new snapshot does not cover, then write the block; one logged change per step, origin import
  const blank: string[][] = [];
  for (let r = 0; r < Math.max(meta.rows, rows); r++) blank.push(new Array(Math.max(meta.cols, cols)).fill(''));
  book.apply({ type: 'set_cells', table, row: 0, col: 0, values: blank }, { origin: 'import' });
  book.apply({ type: 'resize_table', table, rows, cols }, { origin: 'import' });
  book.apply({ type: 'set_cells', table, row: 0, col: 0, values: values.map((r) => [...r, ...new Array(cols - r.length).fill('')]) }, { origin: 'import' });
}

async function placeRows(f: File, suggestedName: string, values: string[][]): Promise<void> {
  const fields = values[0]?.map(String).filter(Boolean) ?? [];
  const dataRows = Math.max(0, values.length - 1);
  const period = periodFromName(f.name);
  const match = matchingTable(fields);
  let replace = false;
  if (match) {
    const policy = importPolicy();
    replace = policy === 'replace' || (policy === 'ask' && confirm(`“${f.name}” has the same columns as the table “${match.name}”.\n\nOK — update ${match.name} with this snapshot (same table, formulas and watches kept${period ? `, period ${period}` : ''}).\nCancel — add it as a new table.`));
  }
  if (match && replace) {
    replaceTableData(match.id, values);
    setStatus(`${match.name} updated from ${f.name}: ${dataRows} rows${period ? ` (${period})` : ''}`);
    await recordImport(f.name, match.id, match.name, dataRows, fields, { period, replaced: true });
    return;
  }
  const tid = addTable({ name: suggestedName, rows: values.length, cols: Math.max(...values.map((r) => r.length), 1), values, origin: 'import' });
  if (typeof tid === 'number') await recordImport(f.name, tid, suggestedName, dataRows, fields, { period });
}

export async function importFile(f: File): Promise<void> {
  useStore.setState({ start: false });
  if (/\.(xlsx|xlsm|xls|ods)$/i.test(f.name)) {
    const XLSX = await import('xlsx');
    const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellDates: false, cellFormula: true, sheetStubs: true });
    let n = 0;
    for (const name of wb.SheetNames) {
      const sheet = wb.Sheets[name];
      const rows: (string | number | boolean | null)[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
      if (!rows.length) continue;
      const values = rows.map((r) => r.map((v) => (v === null || v === undefined ? '' : String(v))));
      // formulas are imported as their cached values; SheetJS exposes formulas via cell.f when present
      for (const addr of Object.keys(sheet)) {
        if (addr[0] === '!') continue;
        const cell = sheet[addr] as { f?: string };
        if (cell.f) {
          const p = XLSX.utils.decode_cell(addr);
          if (values[p.r]) values[p.r][p.c] = '=' + cell.f;
        }
      }
      const tname = wb.SheetNames.length > 1 ? `${familyOf(f.name)} ${name}` : familyOf(f.name);
      await placeRows(f, tname, values);
      n++;
    }
    if (n > 1) setStatus(`Imported ${n} sheets from ${f.name}`);
    return;
  }
  const text = await f.text();
  if (f.name.toLowerCase().endsWith('.json')) {
    try {
      JSON.parse(text);
      await book.loadBook(text, f.name.replace(/\.gridwright\.json$|\.json$/i, ''), null);
      joinFile(null);
      setStatus(`Loaded ${f.name}`);
    } catch (e) {
      setStatus(`Not a Gridwright document: ${(e as Error).message}`);
    }
    return;
  }
  const rows = parseCsv(text);
  if (!rows.length) {
    setStatus('The file is empty.');
    return;
  }
  await placeRows(f, familyOf(f.name), rows);
}

/** Open the file picker and import what is chosen. */
export function pickAndImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = IMPORT_ACCEPT;
  input.style.display = 'none';
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) void importFile(f);
    input.remove();
  };
  document.body.appendChild(input);
  input.click();
}

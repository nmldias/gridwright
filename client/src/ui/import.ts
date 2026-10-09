// Importing files into the open document: Excel/ODS sheets and CSV become new tables, a Gridwright
// JSON file replaces the document. Shared by the document menu, the Files panel and the start card.

import { joinFile } from '../api/ws';
import * as book from '../engine/book';
import { addTable } from '../grid/actions';
import { setStatus, useStore } from '../state/store';
import { parseCsv } from './files';

export const IMPORT_ACCEPT = '.csv,.tsv,.txt,.json,.xlsx,.xlsm,.xls,.ods';

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
      addTable({ name: wb.SheetNames.length > 1 ? `${f.name.replace(/\.[^.]+$/, '')} ${name}` : f.name.replace(/\.[^.]+$/, ''), rows: values.length, cols: Math.max(...values.map((r) => r.length), 1), values, origin: 'import' });
      n++;
    }
    setStatus(`Imported ${n} sheet${n === 1 ? '' : 's'} from ${f.name}`);
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
  addTable({ name: f.name.replace(/\.(csv|tsv|txt)$/i, ''), rows: rows.length, cols: Math.max(...rows.map((r) => r.length)), values: rows, origin: 'import' });
  setStatus(`Imported ${rows.length} rows into a new table`);
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

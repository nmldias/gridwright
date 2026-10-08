// Types mirroring the Rust engine's JSON payloads.

export type TableId = number;

export type CellValue =
  | null
  | { n: number }
  | { s: string }
  | { b: boolean }
  | { e: string };

export type CellKind = 'value' | 'formula' | 'python' | 'javascript';

export interface Format {
  bold?: boolean;
  italic?: boolean;
  align?: 'left' | 'center' | 'right';
  number_format?: string;
  fill?: string;
  color?: string;
}

export interface CellView {
  r: number;
  c: number;
  i: string;
  k: CellKind;
  v: CellValue;
  f?: Format;
  s?: { row: number; col: number }; // spilled from
  ss?: [number, number]; // spill size (code cells)
  out?: string;
  err?: string;
}

export interface TableMeta {
  id: TableId;
  name: string;
  x: number;
  y: number;
  rows: number;
  cols: number;
  header_rows: number;
  col_widths: number[];
  row_heights: number[];
}

export interface Rect {
  table: TableId;
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export interface CellRef {
  table: TableId;
  row: number;
  col: number;
}

export interface Changes {
  cells: Record<string, CellView[]>;
  tables: TableMeta[];
  reload: TableId[];
  removed_tables: TableId[];
  rerun_code: CellRef[];
  error?: string;
  created: TableId[];
}

export type Op =
  | { type: 'set_cell'; table: TableId; row: number; col: number; input: string; kind?: CellKind }
  | { type: 'set_cells'; table: TableId; row: number; col: number; values: string[][] }
  | { type: 'clear_range'; table: TableId; r0: number; c0: number; r1: number; c1: number }
  | { type: 'set_format'; table: TableId; r0: number; c0: number; r1: number; c1: number; format: Format }
  | { type: 'resize_table'; table: TableId; rows: number; cols: number }
  | { type: 'move_table'; table: TableId; x: number; y: number }
  | { type: 'rename_table'; table: TableId; name: string }
  | { type: 'set_col_width'; table: TableId; col: number; width: number }
  | { type: 'set_row_height'; table: TableId; row: number; height: number }
  | { type: 'set_header_rows'; table: TableId; header_rows: number }
  | { type: 'insert_rows'; table: TableId; at: number; count: number }
  | { type: 'delete_rows'; table: TableId; at: number; count: number }
  | { type: 'insert_cols'; table: TableId; at: number; count: number }
  | { type: 'delete_cols'; table: TableId; at: number; count: number }
  | {
      type: 'add_table';
      id?: TableId;
      name?: string;
      x: number;
      y: number;
      rows: number;
      cols: number;
      values?: string[][];
    }
  | { type: 'delete_table'; table: TableId }
  | {
      type: 'code_result';
      table: TableId;
      row: number;
      col: number;
      output?: CellValue[][] | null;
      std_out?: string | null;
      std_err?: string | null;
      deps: Rect[];
    };

export function valueToString(v: CellValue): string {
  if (v === null || v === undefined) return '';
  if ('n' in v) return formatNumberPlain(v.n);
  if ('s' in v) return v.s;
  if ('b' in v) return v.b ? 'TRUE' : 'FALSE';
  if ('e' in v) return v.e;
  return '';
}

export function formatNumberPlain(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  const s = n.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

export function isErrorValue(v: CellValue): boolean {
  return !!v && typeof v === 'object' && 'e' in v;
}

export function cellKey(r: number, c: number): number {
  return r * 65536 + c;
}

export function colToLetters(col: number): string {
  let s = '';
  let c = col;
  for (;;) {
    s = String.fromCharCode(65 + (c % 26)) + s;
    if (c < 26) break;
    c = Math.floor(c / 26) - 1;
  }
  return s;
}

export function lettersToCol(s: string): number {
  let n = 0;
  for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function a1(r: number, c: number): string {
  return `${colToLetters(c)}${r + 1}`;
}

/** Parse "A1", "A1:B3", "Table 2::A1:B3", "'My table'::A1" → table name (optional) + rect (0-based). */
export function parseA1(ref: string): { table?: string; r0: number; c0: number; r1: number; c1: number } | null {
  let table: string | undefined;
  let body = ref.trim();
  const dc = body.lastIndexOf('::');
  if (dc >= 0) {
    table = body.slice(0, dc).trim().replace(/^'(.*)'$/, '$1');
    body = body.slice(dc + 2).trim();
  }
  const m = body.match(/^\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$/);
  if (!m) return null;
  const c0 = lettersToCol(m[1]);
  const r0 = parseInt(m[2], 10) - 1;
  const c1 = m[3] ? lettersToCol(m[3]) : c0;
  const r1 = m[4] ? parseInt(m[4], 10) - 1 : r0;
  return { table, r0: Math.min(r0, r1), c0: Math.min(c0, c1), r1: Math.max(r0, r1), c1: Math.max(c0, c1) };
}

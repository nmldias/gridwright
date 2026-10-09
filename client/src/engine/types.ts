// Types mirroring the Rust engine's JSON payloads.

export type TableId = number;

export type CellValue =
  | null
  | { n: number }
  | { s: string }
  | { b: boolean }
  | { e: string };

export type CellKind = 'value' | 'formula' | 'python' | 'javascript' | 'sql';

export const CODE_KINDS: CellKind[] = ['python', 'javascript', 'sql'];
export const isCodeKind = (k: CellKind | undefined) => !!k && CODE_KINDS.includes(k);

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
  ss?: [number, number]; // spill size (code cells and array formulas)
  out?: string;
  err?: string;
  conn?: string; // SQL cells: connection id
  refresh?: number; // code/SQL cells: refresh interval (s)
  inv?: boolean; // breaks a validation rule
}

export interface PivotValue {
  field: string;
  agg: 'sum' | 'count' | 'average' | 'min' | 'max' | 'countdistinct';
}
export interface PivotFilter {
  field: string;
  values: string[];
}
export interface PivotSpec {
  source: TableId;
  rows: string[];
  cols: string[];
  values: PivotValue[];
  filters: PivotFilter[];
  totals: boolean;
}

export interface ColumnFilter {
  col: number;
  values?: string[];
  op?: 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le' | 'contains' | 'not_contains' | 'starts' | 'ends' | 'blank' | 'not_blank';
  value?: string;
}

export type CondFormatKind = 'cell_is' | 'text' | 'color_scale' | 'top' | 'bottom' | 'duplicate' | 'blank' | 'not_blank' | 'formula';
export interface CondFormat {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
  kind: CondFormatKind;
  op?: string;
  values: string[];
  fill?: string;
  color?: string;
  bold?: boolean;
  min_color?: string;
  max_color?: string;
}

export type ValidationKind = 'list' | 'number' | 'integer' | 'date' | 'text_length' | 'custom';
export interface Validation {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
  kind: ValidationKind;
  op?: string;
  values: string[];
  allow_blank: boolean;
  strict: boolean;
  message?: string;
}

export interface NamedRange {
  name: string;
  reference: string;
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
  pivot?: PivotSpec;
  filters: ColumnFilter[];
  hidden_rows: number[];
  cond_formats: CondFormat[];
  validations: Validation[];
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
  names?: NamedRange[];
}

export type Op =
  | { type: 'set_cell'; table: TableId; row: number; col: number; input: string; kind?: CellKind; conn?: string | null; refresh?: number | null }
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
    }
  | { type: 'set_pivot'; table: TableId; spec: PivotSpec | null }
  | { type: 'set_filters'; table: TableId; filters: ColumnFilter[] }
  | { type: 'set_cond_formats'; table: TableId; rules: CondFormat[] }
  | { type: 'set_validations'; table: TableId; rules: Validation[] }
  | { type: 'set_name'; name: string; reference: string | null };

/** Ops that change the shape of a table (row/column indices shift). */
export const STRUCTURAL_OPS = new Set<Op['type']>(['resize_table', 'insert_rows', 'delete_rows', 'insert_cols', 'delete_cols', 'delete_table', 'add_table', 'set_pivot', 'rename_table', 'set_header_rows']);

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

/** Table-qualified reference text for a rectangle, quoting names with spaces. */
export function refText(tableName: string, r0: number, c0: number, r1: number, c1: number): string {
  const simple = /^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName);
  const q = simple ? tableName : `'${tableName.replace(/'/g, "''")}'`;
  return `${q}::${a1(r0, c0)}${r0 !== r1 || c0 !== c1 ? ':' + a1(r1, c1) : ''}`;
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

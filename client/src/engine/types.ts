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
  wrap?: boolean;
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
  runtime?: string; // Python cells: 'server' runs on the host's CPython; absent = browser (Pyodide)
  gpu?: boolean; // Python cells on the server: ask for cuDF
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

/** A signed-off rectangle (who, when, note, fingerprint of the values at that moment). */
export interface Signoff {
  id: number;
  r0: number;
  c0: number;
  r1: number;
  c1: number;
  by: string;
  login: string;
  at: string;
  note: string;
  hash: string;
  locked: boolean;
}

export interface Merge {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export type ChartKind = 'bar' | 'hbar' | 'line' | 'area' | 'stacked' | 'waterfall';
export interface ChartSeries {
  name: string;
  range: string;
  color?: string;
}
export interface ChartReference {
  value: number;
  label: string;
}
/** A chart object on the canvas; data comes from the referenced ranges. */
export interface Chart {
  id: number;
  kind: ChartKind;
  title: string;
  subtitle: string;
  exhibit: string;
  source: string;
  x: number;
  y: number;
  w: number;
  h: number;
  categories: string;
  series: ChartSeries[];
  highlight?: number | null;
  reference?: ChartReference | null;
  show_values: boolean;
  stat_cards: boolean;
  /** bound to a table's fields (an analytical chart) instead of ranges */
  analytic?: ChartAnalytic | null;
}

/** A measure of an analytical query (core/src/analytic.rs `MeasureSpec`). */
export interface MeasureSpec {
  name?: string;
  field?: string;
  /** sum | count | count_distinct | average | min | max | ratio */
  agg: string;
  numerator?: string;
  denominator?: string;
  /** header of a column holding each row's currency code */
  currency?: string;
}
export interface ChartAnalytic {
  table: string;
  /** dimension hierarchy, outermost first */
  dims: string[];
  measures: MeasureSpec[];
  sort?: '' | 'key' | 'value_desc' | 'value_asc';
}
/** A canonical cell value as the engine serialises it. */
export type KeyValue = null | { n: number } | { s: string } | { b: boolean } | { e: string };
export interface AnalyticSelection {
  field: string;
  values: KeyValue[];
}
export interface AnalyticQuery {
  table: string;
  dims?: string[];
  measures?: MeasureSpec[];
  selections?: AnalyticSelection[];
  key?: string[];
  members?: boolean;
  respect_table_filters?: boolean;
  sort?: string;
}
export interface MeasureValue {
  value: number | null;
  status: 'ok' | 'incomplete' | 'no_data' | 'mixed_currency' | 'div0';
  n: number;
  missing: number;
  invalid: number;
  currency?: string;
  by_currency?: { currency: string; value: number; n: number }[];
}
export interface AnalyticAnswer {
  error?: string;
  table: string;
  dims: string[];
  measures: { name: string; agg: string; additive: boolean }[];
  groups: { key: KeyValue[]; label: string[]; rows: number; members?: number[]; values: MeasureValue[] }[];
  total: MeasureValue[];
  excluded: { rows: number; by_selection: number; by_table_filter: number; values: MeasureValue[] };
  population: { rows: number; included: number; excluded: number; blank: number };
  reconciliation: { measure: string; status: 'ok' | 'differs' | 'not_assessable'; total: number | null; sum_of_groups: number | null }[];
  issues: { kind: string; text: string; rows?: number[]; count: number }[];
}
/** Decomposition tree (roadmap 7.4, core/src/decompose.rs). A step on a node's path: one value of
 * `field` (canonical key; null = (blank)), or the Other node of that level. */
export interface DecompStep {
  field: string;
  key?: KeyValue;
  other?: boolean;
}
export interface DecompSplitSpec {
  path: DecompStep[];
  field: string;
}
export interface DecompSuggestSpec {
  at: DecompStep[];
  /** '' | 'high_value' (default) | 'relative' */
  rule?: string;
  /** explicit candidates in this order; empty = automatic */
  fields?: string[];
  min_rows?: number | null;
}
export interface DecompQuery {
  table: string;
  measure: MeasureSpec;
  selections?: AnalyticSelection[];
  respect_table_filters?: boolean;
  key?: string[];
  top_n?: number;
  splits: DecompSplitSpec[];
  suggest?: DecompSuggestSpec | null;
}
export interface DecompParts {
  numerator: number;
  denominator: number;
}
export interface DecompCheck {
  kind: 'sum' | 'children_do_not_sum';
  status: 'ok' | 'differs' | 'not_assessable' | 'recomputed';
  parent: number | null;
  sum_of_children: number | null;
  rows_ok: boolean;
  parts_ok?: boolean;
  by_currency?: { currency: string; parent: number; sum_of_children: number; status: string }[];
  text: string;
}
export interface DecompSplit {
  field: string;
  items: number;
  sort: 'value_desc' | 'key';
  mixed_signs: boolean;
  children: DecompNode[];
  check: DecompCheck;
}
export interface DecompNode {
  id: string;
  kind: 'root' | 'value' | 'other' | 'blank';
  label: string;
  key: KeyValue;
  k?: number;
  folded?: KeyValue[];
  rank: number | null;
  pinned: boolean;
  path: DecompStep[];
  selections: AnalyticSelection[];
  rows: number;
  value: MeasureValue;
  parts?: DecompParts;
  share?: number;
  split?: DecompSplit;
}
export interface DecompCandidate {
  field: string;
  score: number | null;
  items: number;
  node: string | null;
  node_key: KeyValue;
  value: number | null;
  mean: number | null;
  skipped: string | null;
}
export interface DecompSuggestion {
  at: DecompStep[];
  node_id: string;
  rule: 'high_value' | 'relative';
  rule_text: string;
  field: string | null;
  best: DecompCandidate | null;
  runner_up: DecompCandidate | null;
  candidates: DecompCandidate[];
  text: string;
}
export interface DecompTree {
  table: string;
  measure: { name: string; agg: string; additive: boolean };
  top_n: number;
  root: DecompNode;
  excluded: AnalyticAnswer['excluded'];
  population: AnalyticAnswer['population'];
  issues: AnalyticAnswer['issues'];
  unresolved: { path: DecompStep[]; field: string; reason: string }[];
  suggestion: DecompSuggestion | null;
}
export interface AnalyticRecords {
  error?: string;
  table: string;
  fields: string[];
  measures: { name: string; agg: string; additive: boolean }[];
  total: MeasureValue[];
  count: number;
  truncated: boolean;
  records: { row: number; values: KeyValue[] }[];
}

export interface Trace {
  precedents: Rect[];
  dependents: CellRef[];
}

export interface CheckView {
  table: TableId;
  row: number;
  col: number;
  label: string;
  ok: boolean;
  error: boolean;
}

export interface SignoffStatus {
  id: number;
  stale: boolean;
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
  signoffs: Signoff[];
  merges: Merge[];
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
  charts?: Chart[];
  created_chart?: number;
  /** the workbook's decimal-comma setting, when it changed */
  decimal_comma?: boolean;
  /** undo/redo: restore ops that reproduce the change on other clients */
  ops?: Op[];
}

export interface RestoredCell {
  table: TableId;
  row: number;
  col: number;
  cell?: unknown | null;
}
export interface RestoredTable {
  id: TableId;
  table?: unknown | null;
}

export type Op =
  | { type: 'set_cell'; table: TableId; row: number; col: number; input: string; kind?: CellKind; conn?: string | null; refresh?: number | null; runtime?: string | null; gpu?: boolean | null }
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
  | { type: 'set_name'; name: string; reference: string | null }
  | { type: 'add_signoff'; table: TableId; r0: number; c0: number; r1: number; c1: number; by: string; login: string; at: string; note: string; locked: boolean }
  | { type: 'remove_signoff'; table: TableId; id: number }
  | { type: 'set_signoff_locked'; table: TableId; id: number; locked: boolean }
  | { type: 'merge_cells'; table: TableId; r0: number; c0: number; r1: number; c1: number }
  | { type: 'unmerge_cells'; table: TableId; r0: number; c0: number; r1: number; c1: number }
  | { type: 'add_chart'; chart: Chart }
  | { type: 'update_chart'; chart: Chart }
  | { type: 'delete_chart'; id: number }
  | { type: 'restore_cells'; cells: RestoredCell[] }
  | { type: 'restore_tables'; tables: RestoredTable[] }
  | { type: 'restore_names'; names: NamedRange[] }
  | { type: 'restore_charts'; charts: Chart[] }
  /** type and show numbers with a decimal comma ("1.234,56") in this workbook */
  | { type: 'set_decimal_comma'; on: boolean };

/** Ops that change the shape of a table (row/column indices shift). */
export const STRUCTURAL_OPS = new Set<Op['type']>(['resize_table', 'insert_rows', 'delete_rows', 'insert_cols', 'delete_cols', 'delete_table', 'add_table', 'set_pivot', 'rename_table', 'set_header_rows', 'restore_tables']);

/** Ops that only shift indices (the pending ops of other clients can be transformed against them). */
export const SHIFT_OPS = new Set<Op['type']>(['insert_rows', 'delete_rows', 'insert_cols', 'delete_cols']);

export const EMPTY_CHART: Chart = { id: 0, kind: 'bar', title: '', subtitle: '', exhibit: '', source: '', x: 0, y: 0, w: 560, h: 380, categories: '', series: [], highlight: null, reference: null, show_values: true, stat_cards: true };

export function valueToString(v: CellValue): string {
  if (v === null || v === undefined) return '';
  if ('n' in v) return formatNumberPlain(v.n);
  if ('s' in v) return v.s;
  if ('b' in v) return v.b ? 'TRUE' : 'FALSE';
  if ('e' in v) return v.e;
  return '';
}

/** A finite number as 15 significant digits: `digits` (< 10^15, exact in a double) × 10^`exp`.
 *  Mirrors `dec15` in core/src/formula/numerics.rs; ties at the 16th digit go away from zero. */
export function dec15(x: number): { neg: boolean; digits: number; exp: number } {
  const [m, e] = Math.abs(x).toExponential(14).split('e');
  const digits = Number(m.replace('.', ''));
  return { neg: x < 0 && digits !== 0, digits, exp: Number(e) - 14 };
}

/** |x| with exactly `places` decimals, rounded half away from zero on its 15-digit value
 *  (TEXT(1.005,"0.00") is 1.01). Mirrors `fixed_abs` in numerics.rs. */
export function fixedAbs(x: number, places: number): string {
  if (!Number.isFinite(x)) return String(Math.abs(x));
  const d = dec15(x);
  let m = d.digits;
  let scale = d.exp;
  if (d.exp < -places) {
    const k = -places - d.exp;
    if (k >= 16) m = 0;
    else {
      const p = 10 ** k;
      const q = Math.floor(d.digits / p);
      m = q + (d.digits - q * p >= p / 2 ? 1 : 0);
    }
    scale = -places;
  }
  let s = String(m);
  if (m !== 0) s += '0'.repeat(Math.max(0, scale + places));
  if (places === 0) return s;
  if (s.length <= places) s = '0'.repeat(places + 1 - s.length) + s;
  return `${s.slice(0, s.length - places)}.${s.slice(s.length - places)}`;
}

/** Number → text as Excel's General format: up to 15 significant digits, no trailing zeros,
 *  scientific from 1E+15 and below 1E-9. Mirrors `general_text` in numerics.rs. */
export function formatNumberPlain(n: number): string {
  if (Number.isNaN(n)) return '#NUM!';
  if (!Number.isFinite(n)) return String(n);
  if (n === 0) return '0';
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  const d = dec15(n);
  let digits = d.digits;
  let exp = d.exp;
  while (digits % 10 === 0) {
    digits /= 10;
    exp++;
  }
  const ds = String(digits);
  const sci = exp + ds.length - 1;
  const sign = d.neg ? '-' : '';
  if (sci >= 15 || sci < -9) {
    const mant = ds.length > 1 ? `${ds[0]}.${ds.slice(1)}` : ds;
    return `${sign}${mant}E${sci < 0 ? '-' : '+'}${String(Math.abs(sci)).padStart(2, '0')}`;
  }
  if (exp >= 0) return sign + ds + '0'.repeat(exp);
  const places = -exp;
  const padded = ds.length <= places ? '0'.repeat(places + 1 - ds.length) + ds : ds;
  return `${sign}${padded.slice(0, padded.length - places)}.${padded.slice(padded.length - places)}`;
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

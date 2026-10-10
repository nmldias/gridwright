/* tslint:disable */
/* eslint-disable */

export class Book {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Apply an operation (JSON `Op`); returns JSON `Changes`.
     */
    apply(op_json: string): string;
    /**
     * Apply an op authored by another client (JSON `Op`): not recorded for undo.
     */
    apply_remote(op_json: string): string;
    can_redo(): boolean;
    can_undo(): boolean;
    cell(table: number, row: number, col: number): string;
    /**
     * JSON array of non-empty cells of a table.
     */
    cells(table: number): string;
    /**
     * JSON array of chart objects.
     */
    charts(): string;
    /**
     * Check an input against the validation rules of a cell: JSON {"ok": bool, "message"?: string, "strict": bool}.
     */
    check_validation(table: number, row: number, col: number, input: string): string;
    /**
     * Every =CHECK(...) cell with its outcome: JSON [{table,row,col,label,ok,error}].
     */
    checks(): string;
    /**
     * Evaluate a formula body for a specific cell position (conditional-format formulas); JSON value.
     */
    eval_at(table: number, row: number, col: number, formula: string): string;
    /**
     * Format a number with a spreadsheet pattern (same rules as TEXT()).
     */
    static format_number(n: number, pattern: string): string;
    static from_json(json: string): Book;
    /**
     * Entries offered by a list validation covering the cell (JSON array of strings; empty when none).
     */
    list_entries(table: number, row: number, col: number): string;
    name(): string;
    /**
     * JSON array of workbook names: [{name, reference}].
     */
    names(): string;
    /**
     * Empty workbook with a single table.
     */
    constructor(name: string);
    /**
     * Evaluate a formula body (without `=`) in the context of a table; JSON value.
     */
    preview(table: number, formula: string): string;
    /**
     * Fingerprint of the displayed values of a rectangle.
     */
    range_hash(table: number, r0: number, c0: number, r1: number, c1: number): string;
    /**
     * 2-D JSON array of plain values (numbers, strings, booleans, null, {"e":..}).
     */
    range_values(table: number, r0: number, c0: number, r1: number, c1: number): string;
    redo(): string;
    /**
     * Values of a reference text (`Sales::B2:B13`, `Sales[Revenue]`, a name) as a 2-D JSON array;
     * `{"error": "..."}` when it does not resolve.
     */
    resolve_values(table: number, reference: string): string;
    set_name(name: string): void;
    /**
     * Serial date-time for NOW()/TODAY() (days since 1899-12-30, UTC).
     */
    set_now(serial: number): void;
    /**
     * Shift relative references of a formula body copied by (dr, dc).
     */
    static shift_formula(src: string, dr: number, dc: number): string;
    /**
     * Shift references confined to `src_row` by `dr` (row reordering).
     */
    static shift_formula_row(src: string, src_row: number, dr: number): string;
    /**
     * Sign-offs of a table whose values changed since signing: JSON [{id, stale}].
     */
    signoff_status(table: number): string;
    /**
     * Table id by name (0 when not found).
     */
    table_id(name: string): number;
    /**
     * JSON array of table metadata.
     */
    tables(): string;
    to_json(): string;
    /**
     * Precedents and dependents of a cell: JSON {precedents: Rect[], dependents: CellRef[]}.
     */
    trace(table: number, row: number, col: number): string;
    undo(): string;
    static version(): string;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_book_free: (a: number, b: number) => void;
    readonly book_apply: (a: number, b: number, c: number) => [number, number];
    readonly book_apply_remote: (a: number, b: number, c: number) => [number, number];
    readonly book_can_redo: (a: number) => number;
    readonly book_can_undo: (a: number) => number;
    readonly book_cell: (a: number, b: number, c: number, d: number) => [number, number];
    readonly book_cells: (a: number, b: number) => [number, number];
    readonly book_charts: (a: number) => [number, number];
    readonly book_check_validation: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly book_checks: (a: number) => [number, number];
    readonly book_eval_at: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly book_format_number: (a: number, b: number, c: number) => [number, number];
    readonly book_from_json: (a: number, b: number) => [number, number, number];
    readonly book_list_entries: (a: number, b: number, c: number, d: number) => [number, number];
    readonly book_name: (a: number) => [number, number];
    readonly book_names: (a: number) => [number, number];
    readonly book_new: (a: number, b: number) => number;
    readonly book_preview: (a: number, b: number, c: number, d: number) => [number, number];
    readonly book_range_hash: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly book_range_values: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly book_redo: (a: number) => [number, number];
    readonly book_resolve_values: (a: number, b: number, c: number, d: number) => [number, number];
    readonly book_set_name: (a: number, b: number, c: number) => void;
    readonly book_set_now: (a: number, b: number) => void;
    readonly book_shift_formula: (a: number, b: number, c: number, d: number) => [number, number];
    readonly book_shift_formula_row: (a: number, b: number, c: number, d: number) => [number, number];
    readonly book_signoff_status: (a: number, b: number) => [number, number];
    readonly book_table_id: (a: number, b: number, c: number) => number;
    readonly book_tables: (a: number) => [number, number];
    readonly book_to_json: (a: number) => [number, number];
    readonly book_trace: (a: number, b: number, c: number, d: number) => [number, number];
    readonly book_undo: (a: number) => [number, number];
    readonly book_version: () => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;

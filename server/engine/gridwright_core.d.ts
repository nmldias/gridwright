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

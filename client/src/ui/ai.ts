// Prompt construction and action application for the AI assistant.

import * as book from '../engine/book';
import { a1, parseA1, type CellKind } from '../engine/types';
import { addTable } from '../grid/actions';
import { cellAt, getState } from '../state/store';
import { displayOf } from '../grid/format';

export const SYSTEM_PROMPT = `You are the assistant inside Gridwright, a spreadsheet whose documents hold several named tables on a canvas.
Formulas start with "=" and use A1 references inside the current table; other tables are addressed as Name::A1 or 'Name with spaces'::A1:B5 (ranges A1:B5, whole columns A:A).
Functions available: SUM AVERAGE MIN MAX COUNT COUNTA COUNTBLANK PRODUCT MEDIAN STDEV VAR ABS ROUND ROUNDUP ROUNDDOWN INT TRUNC MOD POWER SQRT EXP LN LOG LOG10 PI CEILING FLOOR SIGN SUMPRODUCT SUMIF SUMIFS COUNTIF COUNTIFS AVERAGEIF AVERAGEIFS IF IFS IFERROR IFNA AND OR XOR NOT ISBLANK ISNUMBER ISTEXT ISERROR LEN UPPER LOWER PROPER TRIM CONCAT CONCATENATE TEXTJOIN LEFT RIGHT MID FIND SEARCH SUBSTITUTE REPT VALUE TEXT EXACT VLOOKUP HLOOKUP XLOOKUP MATCH INDEX CHOOSE ROW COLUMN ROWS COLUMNS TRANSPOSE UNIQUE TODAY NOW DATE YEAR MONTH DAY DATEVALUE EDATE EOMONTH WEEKDAY DAYS RANK LARGE SMALL N T.
Python cells: the last expression is the output; q.cells("A1:B5") returns values (a DataFrame when pandas is imported), q.cells("Table 2::A1") reads another table, q.df("A1:C20") returns a DataFrame with the first row as header. JavaScript cells: return the value; q.cells(...) as above. Outputs spill into the cells right/below; the table grows to fit.
Row 1 of a table is usually its header.

To change the sheet, include one fenced block tagged gridwright-actions containing a JSON array of actions, for example:
\`\`\`gridwright-actions
[{"action":"set_cells","table":"Table 1","ref":"A1","values":[["Region","Revenue"],["North",1200],["South",980]]},
 {"action":"set_cell","table":"Table 1","ref":"B4","input":"=SUM(B2:B3)"},
 {"action":"code_cell","table":"Table 1","ref":"D1","language":"python","code":"df = q.df(\\"A1:B3\\")\\ndf['Share'] = df['Revenue'] / df['Revenue'].sum()\\ndf"},
 {"action":"add_table","name":"Summary","values":[["Metric","Value"],["Total","=SUM('Table 1'::B2:B3)"]]},
 {"action":"resize_table","table":"Table 1","rows":12,"cols":4}]
\`\`\`
Rules: refer to tables by their exact names; "ref" is the top-left cell; values are plain strings/numbers or formula strings starting with "="; keep explanations short and put them outside the block; never invent data that is not in the sheet unless the user asks for sample data.`;

function summariseWorkbook(maxRows = 15, maxCols = 12): string {
  const st = getState();
  const parts: string[] = [];
  for (const t of st.tables.values()) {
    const lines: string[] = [];
    const rows = Math.min(t.rows, maxRows);
    const cols = Math.min(t.cols, maxCols);
    for (let r = 0; r < rows; r++) {
      const cells: string[] = [];
      let any = false;
      for (let c = 0; c < cols; c++) {
        const cell = cellAt(t.id, r, c);
        let text = cell ? (cell.k === 'formula' ? `${displayOf(cell)} {${cell.i}}` : cell.k === 'value' ? displayOf(cell) : `[${cell.k} cell → ${displayOf(cell)}]`) : '';
        if (text.length > 40) text = text.slice(0, 37) + '…';
        if (text) any = true;
        cells.push(text);
      }
      if (any) lines.push(`${r + 1}: ${cells.join(' | ')}`);
    }
    const header = Array.from({ length: cols }, (_, c) => a1(0, c).replace(/\d+$/, '')).join(' | ');
    parts.push(`### Table "${t.name}" (${t.rows} rows × ${t.cols} cols)\ncolumns: ${header}\n${lines.join('\n') || '(empty)'}${t.rows > rows ? `\n… ${t.rows - rows} more rows` : ''}`);
  }
  const sel = st.selection;
  let selText = '';
  if (sel) {
    const t = st.tables.get(sel.table);
    const cell = cellAt(sel.table, sel.ar, sel.ac);
    selText = `\nSelected: ${t?.name}::${a1(sel.r0, sel.c0)}${sel.r0 !== sel.r1 || sel.c0 !== sel.c1 ? ':' + a1(sel.r1, sel.c1) : ''}${cell?.i ? ` (input: ${cell.i.slice(0, 200)})` : ''}`;
  }
  return `## Workbook "${st.fileName}"\n${parts.join('\n\n')}${selText}`;
}

export function buildMessages(history: { role: 'user' | 'assistant'; content: string }[]): { role: string; content: string }[] {
  const context = summariseWorkbook();
  const msgs: { role: string; content: string }[] = [{ role: 'system', content: SYSTEM_PROMPT + '\n\nCurrent state:\n' + context }];
  for (const m of history) msgs.push(m);
  return msgs;
}

export interface Action {
  action: string;
  table?: string;
  ref?: string;
  values?: (string | number | boolean | null)[][];
  input?: string;
  language?: string;
  code?: string;
  name?: string;
  rows?: number;
  cols?: number;
}

export function extractActions(text: string): Action[] {
  const out: Action[] = [];
  const re = /```gridwright-actions\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (Array.isArray(parsed)) out.push(...parsed.filter((a) => a && typeof a.action === 'string'));
      else if (parsed && typeof parsed.action === 'string') out.push(parsed);
    } catch {
      /* ignore malformed block */
    }
  }
  return out;
}

const str = (v: string | number | boolean | null | undefined): string => (v === null || v === undefined ? '' : typeof v === 'string' ? v : String(v));

export function applyActions(actions: Action[]): { applied: number; errors: string[] } {
  let applied = 0;
  const errors: string[] = [];
  for (const act of actions) {
    try {
      const st = getState();
      const resolveTable = (): number => {
        if (act.table) {
          const id = book.tableIdByName(act.table);
          if (!id) throw new Error(`table "${act.table}" not found`);
          return id;
        }
        const id = st.selection?.table ?? st.tables.keys().next().value;
        if (!id) throw new Error('no table');
        return id;
      };
      switch (act.action) {
        case 'set_cells': {
          const id = resolveTable();
          const p = parseA1(act.ref ?? 'A1');
          if (!p) throw new Error(`bad ref ${act.ref}`);
          const values = (act.values ?? []).map((row) => row.map(str));
          if (!values.length) throw new Error('no values');
          const ch = book.apply({ type: 'set_cells', table: id, row: p.r0, col: p.c0, values });
          if (ch.error) throw new Error(ch.error);
          applied++;
          break;
        }
        case 'set_cell': {
          const id = resolveTable();
          const p = parseA1(act.ref ?? 'A1');
          if (!p) throw new Error(`bad ref ${act.ref}`);
          const ch = book.apply({ type: 'set_cell', table: id, row: p.r0, col: p.c0, input: str(act.input) });
          if (ch.error) throw new Error(ch.error);
          applied++;
          break;
        }
        case 'code_cell': {
          const id = resolveTable();
          const p = parseA1(act.ref ?? 'A1');
          if (!p) throw new Error(`bad ref ${act.ref}`);
          const lang: CellKind = (act.language ?? 'python').toLowerCase().startsWith('j') ? 'javascript' : 'python';
          const ch = book.apply({ type: 'set_cell', table: id, row: p.r0, col: p.c0, input: str(act.code), kind: lang });
          if (ch.error) throw new Error(ch.error);
          applied++;
          break;
        }
        case 'add_table': {
          const values = (act.values ?? []).map((row) => row.map(str));
          addTable({ name: act.name, rows: Math.max(act.rows ?? 0, values.length || 5), cols: Math.max(act.cols ?? 0, values[0]?.length ?? 3), values: values.length ? values : undefined });
          applied++;
          break;
        }
        case 'resize_table': {
          const id = resolveTable();
          const meta = st.tables.get(id)!;
          const ch = book.apply({ type: 'resize_table', table: id, rows: act.rows ?? meta.rows, cols: act.cols ?? meta.cols });
          if (ch.error) throw new Error(ch.error);
          applied++;
          break;
        }
        case 'rename_table': {
          const id = resolveTable();
          const ch = book.apply({ type: 'rename_table', table: id, name: str(act.name) });
          if (ch.error) throw new Error(ch.error);
          applied++;
          break;
        }
        case 'clear_range': {
          const id = resolveTable();
          const p = parseA1(act.ref ?? 'A1');
          if (!p) throw new Error(`bad ref ${act.ref}`);
          const ch = book.apply({ type: 'clear_range', table: id, r0: p.r0, c0: p.c0, r1: p.r1, c1: p.c1 });
          if (ch.error) throw new Error(ch.error);
          applied++;
          break;
        }
        default:
          errors.push(`unknown action ${act.action}`);
      }
    } catch (e) {
      errors.push(`${act.action}: ${(e as Error).message}`);
    }
  }
  return { applied, errors };
}

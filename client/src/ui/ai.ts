// Prompt construction and action application for the AI assistant.

import * as book from '../engine/book';
import { EMPTY_CHART, a1, parseA1, type CellKind, type ChartKind } from '../engine/types';
import { addTable } from '../grid/actions';
import { cellAt, getState } from '../state/store';
import { displayOf } from '../grid/format';

export const SYSTEM_PROMPT = `You are the assistant inside Gridwright, a spreadsheet whose documents hold several named tables on a canvas.
Formulas start with "=" and use A1 references inside the current table; other tables are addressed as Name::A1 or 'Name with spaces'::A1:B5 (ranges A1:B5, whole columns A:A).
Structured references use the header row: Orders[Amount] is the data column under the header "Amount", [@Amount] the value on the formula's own row. Workbook names (e.g. TaxRate) can be defined by the user. Array results spill: =FILTER(Orders[Amount], Orders[Region]="N"), =SORT(...), =UNIQUE(...), =SEQUENCE(...), =A1:A9*2.
Functions available: SUM AVERAGE MIN MAX COUNT COUNTA COUNTBLANK PRODUCT MEDIAN STDEV VAR ABS ROUND ROUNDUP ROUNDDOWN INT TRUNC MOD POWER SQRT EXP LN LOG LOG10 PI CEILING FLOOR SIGN ISEVEN ISODD SUMPRODUCT SUMIF SUMIFS COUNTIF COUNTIFS AVERAGEIF AVERAGEIFS MAXIFS MINIFS SUBTOTAL IF IFS IFERROR IFNA SWITCH AND OR XOR NOT ISBLANK ISNUMBER ISTEXT ISERROR LEN UPPER LOWER PROPER TRIM CONCAT CONCATENATE TEXTJOIN LEFT RIGHT MID FIND SEARCH SUBSTITUTE REPT VALUE TEXT EXACT VLOOKUP HLOOKUP XLOOKUP MATCH INDEX CHOOSE ROW COLUMN ROWS COLUMNS TRANSPOSE UNIQUE FILTER SORT SORTBY SEQUENCE TODAY NOW DATE TIME YEAR MONTH DAY HOUR MINUTE SECOND DATEVALUE EDATE EOMONTH WEEKDAY DAYS DATEDIF YEARFRAC NETWORKDAYS WORKDAY NPV IRR XNPV XIRR PMT IPMT PPMT PV FV NPER RATE SLN EFFECT NOMINAL RANK LARGE SMALL N T. Lazy and scoping: LET(name, value, [name, value, ...], calculation), OFFSET(ref, rows, cols, [height], [width]), INDIRECT(text), ISFORMULA, FORMULATEXT, ISREF. More maths: QUOTIENT GCD LCM FACT COMBIN PERMUT MROUND EVEN ODD SUMSQ SQRTPI RADIANS DEGREES SIN COS TAN ASIN ACOS ATAN ATAN2 SINH COSH TANH RAND RANDBETWEEN CEILING.MATH FLOOR.MATH BASE DECIMAL. Statistics: AVERAGEA MAXA MINA MODE PERCENTILE QUARTILE PERCENTILE.EXC PERCENTRANK RANK.AVG CORREL PEARSON COVARIANCE.P COVARIANCE.S SLOPE INTERCEPT RSQ FORECAST STEYX GEOMEAN HARMEAN DEVSQ AVEDEV TRIMMEAN COUNTUNIQUE NORM.DIST NORM.S.DIST NORM.INV NORM.S.INV STANDARDIZE. Text: CHAR CODE UNICHAR UNICODE CLEAN FIXED NUMBERVALUE REPLACE TEXTSPLIT TEXTBEFORE TEXTAFTER REGEXMATCH REGEXEXTRACT REGEXREPLACE ARRAYTOTEXT JOIN ADDRESS. Lookup and arrays: LOOKUP XMATCH HSTACK VSTACK TAKE DROP CHOOSECOLS CHOOSEROWS TOCOL TOROW WRAPROWS WRAPCOLS EXPAND. Info: TYPE ERROR.TYPE ISERR ISNONTEXT. Dates: DAYS360 WEEKNUM ISOWEEKNUM TIMEVALUE NETWORKDAYS.INTL WORKDAY.INTL. Finance: SYD DB DDB FVSCHEDULE CUMIPMT CUMPRINC ISPMT MIRR RRI PDURATION, plus review and finance primitives: CHECK(condition, "label") (collected in the Review panel), FX(amount, "USD", "AOA", [date]) and FXRATE(from, to, [date]) against a table named FX with columns Date | From | To | Rate (latest rate on or before the date, inverse and triangulated rates work), RECONCILE(rangeA, rangeB, [tolerance]) which spills Key | A | B | Difference | Status, AGEING(dates, amounts, [as_of], [bucket_edges]) which spills Bucket | Count | Amount | Share, and AGE_BUCKET(date, [as_of], [edges]).
Python cells: the last expression is the output; q.cells("A1:B5") returns values (a DataFrame when pandas is imported), q.cells("Table 2::A1") reads another table, q.df("A1:C20") returns a DataFrame with the first row as header. JavaScript cells: return the value; q.cells(...) as above. SQL cells (language "sql") run a query on a stored connection and spill the result; {{A1}} binds a cell as a parameter. Outputs spill into the cells right/below; the table grows to fit.
Row 1 of a table is usually its header. Number formats: "#,##0.00", "0%", "yyyy-mm-dd", "€#,##0.00", "#,##0.00 \"Kz\"" (set with the set_format action).

To change the sheet, include one fenced block tagged gridwright-actions containing a JSON array of actions, for example:
\`\`\`gridwright-actions
[{"action":"set_cells","table":"Table 1","ref":"A1","values":[["Region","Revenue"],["North",1200],["South",980]]},
 {"action":"set_cell","table":"Table 1","ref":"B4","input":"=SUM(B2:B3)"},
 {"action":"code_cell","table":"Table 1","ref":"D1","language":"python","code":"df = q.df(\\"A1:B3\\")\\ndf['Share'] = df['Revenue'] / df['Revenue'].sum()\\ndf"},
 {"action":"add_table","name":"Summary","values":[["Metric","Value"],["Total","=SUM('Table 1'::B2:B3)"]]},
 {"action":"set_format","table":"Table 1","ref":"B2:B9","format":{"number_format":"#,##0.00","bold":false}},
 {"action":"add_chart","kind":"bar","title":"Revenue grew 12% in Q3","subtitle":"Monthly revenue, AOA millions","categories":"Table 1::A2:A13","series":[{"name":"Revenue","range":"Table 1::B2:B13"}],"highlight":8,"reference":{"value":1000,"label":"Budget"},"source":"Table 1"},
 {"action":"resize_table","table":"Table 1","rows":12,"cols":4}]
\`\`\`
Charts are exhibits: give an action title that states the takeaway, a subtitle with dataset and units, and a source. Kinds: bar, hbar, line, area, stacked, waterfall. When tools are available, use run_sql / describe_table to look at real data before writing SQL cells or formulas, and read_history to answer who changed what.
Rules: refer to tables by their exact names; "ref" is the top-left cell (a range for set_format/clear_range); values are plain strings/numbers or formula strings starting with "="; keep explanations short and put them outside the block; never invent data that is not in the sheet unless the user asks for sample data. The user reviews every change as a diff before it is applied, so prefer precise, minimal actions.`;

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
  if (st.names.length) parts.push(`### Names\n${st.names.map((n) => `${n.name} = ${n.reference}`).join('\n')}`);
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
  format?: Record<string, unknown>;
  kind?: string;
  title?: string;
  subtitle?: string;
  categories?: string;
  series?: { name?: string; range?: string }[];
  highlight?: number | null;
  reference?: { value: number; label?: string } | null;
  source?: string;
  exhibit?: string;
}

export interface DiffLine {
  where: string;
  before: string;
  after: string;
  kind: 'cell' | 'table' | 'format' | 'other';
}

/** What an action would change, as before → after lines (for review before applying). */
export function previewActions(actions: Action[]): { lines: DiffLine[]; errors: string[] } {
  const lines: DiffLine[] = [];
  const errors: string[] = [];
  const st = getState();
  const resolve = (act: Action): { id: number; name: string } | null => {
    if (act.table) {
      const id = book.tableIdByName(act.table);
      if (!id) {
        errors.push(`${act.action}: table "${act.table}" not found`);
        return null;
      }
      return { id, name: act.table };
    }
    const id = st.selection?.table ?? st.tables.keys().next().value;
    if (!id) return null;
    return { id, name: st.tables.get(id)?.name ?? '' };
  };
  const trunc = (s: string) => (s.length > 50 ? s.slice(0, 47) + '…' : s);
  for (const act of actions) {
    switch (act.action) {
      case 'set_cells': {
        const t = resolve(act);
        const p = parseA1(act.ref ?? 'A1');
        if (!t || !p) break;
        (act.values ?? []).forEach((row, i) =>
          row.forEach((v, j) => {
            const r = p.r0 + i;
            const c = p.c0 + j;
            const cur = cellAt(t.id, r, c);
            const before = cur ? (cur.k === 'value' ? displayOf(cur) : cur.i) : '';
            const after = str(v);
            if (before !== after) lines.push({ where: `${t.name}::${a1(r, c)}`, before: trunc(before), after: trunc(after), kind: 'cell' });
          }),
        );
        if (lines.length > 400) lines.length = 400;
        break;
      }
      case 'set_cell': {
        const t = resolve(act);
        const p = parseA1(act.ref ?? 'A1');
        if (!t || !p) break;
        const cur = cellAt(t.id, p.r0, p.c0);
        lines.push({ where: `${t.name}::${a1(p.r0, p.c0)}`, before: trunc(cur ? (cur.k === 'value' ? displayOf(cur) : cur.i) : ''), after: trunc(str(act.input)), kind: 'cell' });
        break;
      }
      case 'code_cell': {
        const t = resolve(act);
        const p = parseA1(act.ref ?? 'A1');
        if (!t || !p) break;
        const cur = cellAt(t.id, p.r0, p.c0);
        lines.push({ where: `${t.name}::${a1(p.r0, p.c0)} (${act.language ?? 'python'} cell)`, before: trunc(cur?.i ?? ''), after: trunc(str(act.code)), kind: 'cell' });
        break;
      }
      case 'add_table':
        lines.push({ where: `new table “${act.name ?? 'Table'}”`, before: '', after: `${act.values?.length ?? act.rows ?? 5} rows × ${act.values?.[0]?.length ?? act.cols ?? 3} cols`, kind: 'table' });
        break;
      case 'resize_table': {
        const t = resolve(act);
        if (!t) break;
        const m = st.tables.get(t.id)!;
        lines.push({ where: t.name, before: `${m.rows} × ${m.cols}`, after: `${act.rows ?? m.rows} × ${act.cols ?? m.cols}`, kind: 'table' });
        break;
      }
      case 'rename_table': {
        const t = resolve(act);
        if (!t) break;
        lines.push({ where: t.name, before: t.name, after: str(act.name), kind: 'table' });
        break;
      }
      case 'clear_range': {
        const t = resolve(act);
        const p = parseA1(act.ref ?? 'A1');
        if (!t || !p) break;
        lines.push({ where: `${t.name}::${a1(p.r0, p.c0)}:${a1(p.r1, p.c1)}`, before: '(contents)', after: '(cleared)', kind: 'cell' });
        break;
      }
      case 'set_format': {
        const t = resolve(act);
        const p = parseA1(act.ref ?? 'A1');
        if (!t || !p) break;
        lines.push({ where: `${t.name}::${a1(p.r0, p.c0)}:${a1(p.r1, p.c1)}`, before: '', after: JSON.stringify(act.format ?? {}), kind: 'format' });
        break;
      }
      case 'add_chart': {
        lines.push({ where: 'chart', before: '', after: `${act.kind ?? 'bar'}: ${act.title ?? ''} (${(act.series ?? []).map((x) => x.range).join(', ')})`, kind: 'table' });
        break;
      }
      default:
        errors.push(`unknown action ${act.action}`);
    }
  }
  return { lines, errors };
}

const CHART_KINDS: ChartKind[] = ['bar', 'hbar', 'line', 'area', 'stacked', 'waterfall'];

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

export function applyActions(actions: Action[], origin: 'ai' | 'agent' = 'ai'): { applied: number; errors: string[] } {
  let applied = 0;
  const errors: string[] = [];
  const opts = { origin };
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
          const ch = book.apply({ type: 'set_cells', table: id, row: p.r0, col: p.c0, values }, opts);
          if (ch.error) throw new Error(ch.error);
          applied++;
          break;
        }
        case 'set_cell': {
          const id = resolveTable();
          const p = parseA1(act.ref ?? 'A1');
          if (!p) throw new Error(`bad ref ${act.ref}`);
          const ch = book.apply({ type: 'set_cell', table: id, row: p.r0, col: p.c0, input: str(act.input) }, opts);
          if (ch.error) throw new Error(ch.error);
          applied++;
          break;
        }
        case 'code_cell': {
          const id = resolveTable();
          const p = parseA1(act.ref ?? 'A1');
          if (!p) throw new Error(`bad ref ${act.ref}`);
          const l = (act.language ?? 'python').toLowerCase();
          const lang: CellKind = l.startsWith('j') ? 'javascript' : l.startsWith('s') ? 'sql' : 'python';
          const ch = book.apply({ type: 'set_cell', table: id, row: p.r0, col: p.c0, input: str(act.code), kind: lang }, opts);
          if (ch.error) throw new Error(ch.error);
          applied++;
          break;
        }
        case 'add_table': {
          const values = (act.values ?? []).map((row) => row.map(str));
          addTable({ name: act.name, rows: Math.max(act.rows ?? 0, values.length || 5), cols: Math.max(act.cols ?? 0, values[0]?.length ?? 3), values: values.length ? values : undefined, origin: 'ai' });
          applied++;
          break;
        }
        case 'resize_table': {
          const id = resolveTable();
          const meta = st.tables.get(id)!;
          const ch = book.apply({ type: 'resize_table', table: id, rows: act.rows ?? meta.rows, cols: act.cols ?? meta.cols }, opts);
          if (ch.error) throw new Error(ch.error);
          applied++;
          break;
        }
        case 'rename_table': {
          const id = resolveTable();
          const ch = book.apply({ type: 'rename_table', table: id, name: str(act.name) }, opts);
          if (ch.error) throw new Error(ch.error);
          applied++;
          break;
        }
        case 'clear_range': {
          const id = resolveTable();
          const p = parseA1(act.ref ?? 'A1');
          if (!p) throw new Error(`bad ref ${act.ref}`);
          const ch = book.apply({ type: 'clear_range', table: id, r0: p.r0, c0: p.c0, r1: p.r1, c1: p.c1 }, opts);
          if (ch.error) throw new Error(ch.error);
          applied++;
          break;
        }
        case 'set_format': {
          const id = resolveTable();
          const p = parseA1(act.ref ?? 'A1');
          if (!p) throw new Error(`bad ref ${act.ref}`);
          const f = (act.format ?? {}) as Record<string, unknown>;
          const format: Record<string, unknown> = {};
          for (const k of ['bold', 'italic', 'align', 'number_format', 'fill', 'color', 'wrap']) if (f[k] !== undefined) format[k] = f[k];
          const ch = book.apply({ type: 'set_format', table: id, r0: p.r0, c0: p.c0, r1: p.r1, c1: p.c1, format }, opts);
          if (ch.error) throw new Error(ch.error);
          applied++;
          break;
        }
        case 'add_chart': {
          const kind = CHART_KINDS.includes(act.kind as ChartKind) ? (act.kind as ChartKind) : 'bar';
          const series = (act.series ?? []).filter((x) => x && x.range).map((x, i) => ({ name: str(x.name) || `Series ${i + 1}`, range: str(x.range) }));
          if (!series.length) throw new Error('a chart needs at least one series');
          // next to the first referenced table, or below everything
          let x = 80;
          let y = 80;
          for (const t of st.tables.values()) y = Math.max(y, t.y + 40);
          const ref = parseA1(series[0].range);
          const near = ref?.table ? book.tableIdByName(ref.table) : 0;
          const meta = near ? st.tables.get(near) : undefined;
          if (meta) {
            x = meta.x + meta.col_widths.reduce((a, b) => a + b, 0) + 40;
            y = meta.y;
          }
          const ch = book.apply(
            {
              type: 'add_chart',
              chart: {
                ...EMPTY_CHART,
                kind,
                title: str(act.title),
                subtitle: str(act.subtitle),
                exhibit: str(act.exhibit) || `Exhibit ${st.charts.length + 1}`,
                source: str(act.source),
                categories: str(act.categories),
                series,
                highlight: typeof act.highlight === 'number' ? act.highlight : null,
                reference: act.reference && typeof act.reference.value === 'number' ? { value: act.reference.value, label: str(act.reference.label) } : null,
                x,
                y,
              },
            },
            opts,
          );
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

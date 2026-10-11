// The step catalogue of a guided import. A recipe is an ordered list of these steps; each is a typed,
// validated description of one change ("convert Valor Total to a number written in Portuguese
// format"), never code. The engine (dsengine.ts) compiles each step to SQL it writes itself, with
// column names checked against the data and every value bound as a parameter — neither the
// assistant nor a person ever supplies SQL. The same schemas validate the HTTP API, saved recipes
// and the assistant's proposals.

import { z } from 'zod';

// a key starts with a letter: names beginning with _ belong to the engine (_row, the row in the file)
export const Key = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, 'a column key is lower-case letters, digits and _, starting with a letter');
export const Label = z.string().trim().min(1).max(120);
const Scalar = z.union([z.string().max(300), z.number().finite()]);

export const Cond = z.object({
  column: Key,
  op: z.enum(['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'is_null', 'not_null', 'contains']),
  value: Scalar.optional(),
  values: z.array(Scalar).max(300).optional(),
});
export type Cond = z.infer<typeof Cond>;

const Target = z.object({ key: Key, label: Label });
export const STAGES = ['read', 'clean', 'structure', 'check', 'analyse'] as const;

const base = {
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
  /** why the step is there, in plain words, shown in the audit */
  why: z.string().max(800).optional(),
  /** who proposed it: the built-in rules, the assistant (a model) or a person */
  by: z.enum(['rule', 'assistant', 'person']).default('person'),
  enabled: z.boolean().default(true),
  stage: z.enum(STAGES).optional(),
};

const OutBase = { key: Key, label: Label, place: z.boolean().default(true) };

export const StepSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('header'), sheet: z.number().int().min(0).max(255), row: z.number().int().min(1).max(1000), columns: z.array(z.object({ index: z.number().int().min(0).max(255), key: Key, label: Label })).min(1).max(256) }),
  z.object({ ...base, type: z.literal('trim'), columns: z.union([z.literal('all'), z.array(Key).max(256)]) }),
  z.object({ ...base, type: z.literal('drop_rows'), when: z.enum(['empty', 'totals', 'match']), where: z.array(Cond).max(8).optional() }),
  z.object({ ...base, type: z.literal('convert'), column: Key, to: z.enum(['number', 'date', 'identifier', 'text', 'boolean']), locale: z.enum(['auto', 'pt', 'en']).default('auto'), dayFirst: z.boolean().default(true) }),
  z.object({ ...base, type: z.literal('drop_column'), column: Key, keepAs: z.enum(['none', 'unit', 'note']).default('none') }),
  z.object({ ...base, type: z.literal('rename'), column: Key, label: Label }),
  z.object({ ...base, type: z.literal('signed'), column: Key, negateWhen: z.array(Cond).min(1).max(4), into: Target }),
  z.object({ ...base, type: z.literal('derive'), into: Target, kind: z.enum(['month', 'quarter', 'year', 'weekday', 'days_between', 'age_days', 'extract', 'upper', 'copy', 'prefix']), from: Key, to: Key.optional(), asOf: z.string().regex(/^(max|\d{4}-\d{2}-\d{2})$/).optional(), pattern: z.string().max(200).optional(), chars: z.number().int().min(1).max(60).optional() }),
  z.object({ ...base, type: z.literal('map_values'), column: Key, map: z.array(z.object({ from: z.string().max(300), to: z.string().max(300) })).min(1).max(500), into: Target.optional() }),
  z.object({ ...base, type: z.literal('canonical'), code: Key, name: Key, into: Target, groupInto: Target.optional() }),
  z.object({ ...base, type: z.literal('classify'), column: Key, into: Target, rules: z.array(z.object({ contains: z.array(z.string().min(1).max(80)).min(1).max(20), value: z.string().max(80) })).min(1).max(20), otherwise: z.string().max(80) }),
  z.object({ ...base, type: z.literal('duplicates'), columns: z.array(Key).min(1).max(6), action: z.enum(['flag', 'drop']).default('flag'), into: Target.optional() }),
  z.object({ ...base, type: z.literal('check'), kind: z.enum(['unique', 'required', 'pattern', 'equal_columns', 'positive', 'in_list']), column: Key, other: Key.optional(), pattern: z.string().max(200).optional(), values: z.array(Scalar).max(300).optional(), where: z.array(Cond).max(4).optional(), severity: z.enum(['info', 'warning', 'error']).default('warning'), label: Label }),
  z.object({ ...base, type: z.literal('filter'), where: z.array(Cond).min(1).max(8) }),
  z.object({
    ...base,
    ...OutBase,
    type: z.literal('table'),
    role: z.enum(['fact', 'dimension', 'summary']),
    groupBy: z.array(z.object({ column: Key, label: Label.optional() })).max(6),
    measures: z.array(z.object({ fn: z.enum(['count', 'sum', 'min', 'max', 'avg', 'count_distinct', 'first', 'share']), column: Key.optional(), label: Label, where: z.array(Cond).max(4).optional() })).max(20),
    where: z.array(Cond).max(8).optional(),
    orderBy: z.array(z.object({ by: z.string().max(120), desc: z.boolean().default(false) })).max(4).optional(),
    limit: z.number().int().min(1).max(100_000).optional(),
    /** a fact table: the cleaned rows themselves, these columns (all when omitted) */
    columns: z.array(Key).max(256).optional(),
  }),
  z.object({ ...base, ...OutBase, type: z.literal('pivot'), rows: Key, columns: Key, value: Key.optional(), fn: z.enum(['sum', 'count']).default('sum'), where: z.array(Cond).max(8).optional() }),
  z.object({ ...base, ...OutBase, type: z.literal('ageing'), date: Key, amount: Key, asOf: z.string().regex(/^(max|\d{4}-\d{2}-\d{2})$/).default('max'), buckets: z.array(z.number().int().min(1).max(3650)).min(1).max(8), per: Key.optional(), where: z.array(Cond).max(8).optional(), limit: z.number().int().min(1).max(10_000).optional() }),
  z.object({ ...base, ...OutBase, type: z.literal('exceptions') }),
]);
export type Step = z.infer<typeof StepSchema>;
export type StepType = Step['type'];
export type OutputStep = Extract<Step, { type: 'table' | 'pivot' | 'ageing' | 'exceptions' }>;

export const STAGE_OF: Record<StepType, (typeof STAGES)[number]> = {
  header: 'read',
  trim: 'clean',
  drop_rows: 'clean',
  convert: 'clean',
  drop_column: 'clean',
  rename: 'clean',
  signed: 'clean',
  derive: 'clean',
  map_values: 'clean',
  canonical: 'clean',
  classify: 'clean',
  duplicates: 'check',
  check: 'check',
  filter: 'clean',
  table: 'structure',
  pivot: 'analyse',
  ageing: 'analyse',
  exceptions: 'check',
};

/** Semantic roles the analysis reads (which column is the date, the amount, the customer…). */
export const RolesSchema = z.object({
  date: Key.optional(),
  amount: Key.optional(),
  gross: Key.optional(),
  customer: Key.optional(),
  customerCode: Key.optional(),
  customerType: Key.optional(),
  docType: Key.optional(),
  status: Key.optional(),
  id: Key.optional(),
  month: Key.optional(),
  unit: z.string().max(12).optional(),
  openValue: z.string().max(80).optional(),
});
export type Roles = z.infer<typeof RolesSchema>;

export interface ColumnMeta {
  key: string;
  label: string;
  type: 'number' | 'date' | 'identifier' | 'text' | 'boolean' | 'empty';
  unit?: string;
  /** the header and position it came from in the file */
  source?: { header: string; index: number };
}

export interface OutputMeta {
  key: string;
  label: string;
  role: 'fact' | 'dimension' | 'summary' | 'exceptions' | 'analysis';
  rows: number;
  columns: ColumnMeta[];
  place: boolean;
  step: string;
}

export interface StepResult {
  id: string;
  type: StepType;
  status: 'done' | 'skipped' | 'failed' | 'blocked';
  error?: string;
  rowsIn: number;
  rowsOut: number;
  changed: number;
  rejected: number;
  issues: number;
  examples: { row: number; column?: string; before?: string | number | null; after?: string | number | null; note?: string }[];
  notes: string[];
  ms: number;
  output?: OutputMeta;
}

/** Column keys a step reads (for validation of a recipe against a new file's columns). */
export function readsOf(s: Step): string[] {
  const conds = (c?: Cond[]) => (c ?? []).map((x) => x.column);
  switch (s.type) {
    case 'header':
      return [];
    case 'trim':
      return s.columns === 'all' ? [] : s.columns;
    case 'drop_rows':
      return conds(s.where);
    case 'convert':
    case 'drop_column':
    case 'rename':
      return [s.column];
    case 'signed':
      return [s.column, ...conds(s.negateWhen)];
    case 'derive':
      return [s.from, ...(s.to ? [s.to] : [])];
    case 'map_values':
      return [s.column];
    case 'canonical':
      return [s.code, s.name];
    case 'classify':
      return [s.column];
    case 'duplicates':
      return s.columns;
    case 'check':
      return [s.column, ...(s.other ? [s.other] : []), ...conds(s.where)];
    case 'filter':
      return conds(s.where);
    case 'table':
      return [...s.groupBy.map((g) => g.column), ...s.measures.flatMap((m) => [...(m.column ? [m.column] : []), ...conds(m.where)]), ...conds(s.where), ...(s.columns ?? [])];
    case 'pivot':
      return [s.rows, s.columns, ...(s.value ? [s.value] : []), ...conds(s.where)];
    case 'ageing':
      return [s.date, s.amount, ...(s.per ? [s.per] : []), ...conds(s.where)];
    case 'exceptions':
      return [];
  }
}

/** Column keys a step creates. */
export function writesOf(s: Step): string[] {
  switch (s.type) {
    case 'header':
      return s.columns.map((c) => c.key);
    case 'signed':
    case 'derive':
    case 'canonical':
    case 'classify':
      return [s.into.key, ...(s.type === 'canonical' && s.groupInto ? [s.groupInto.key] : [])];
    case 'map_values':
      return s.into ? [s.into.key] : [];
    case 'duplicates':
      return s.into ? [s.into.key] : [];
    default:
      return [];
  }
}

/** A short sentence for a step, for the audit and the step list. */
export function describe(s: Step, label: (k: string) => string = (k) => k): string {
  const L = label;
  const cond = (c: Cond) => `${L(c.column)} ${c.op === 'eq' ? '=' : c.op === 'neq' ? '≠' : c.op === 'in' ? 'is one of' : c.op === 'not_in' ? 'is not one of' : c.op === 'contains' ? 'contains' : c.op === 'is_null' ? 'is blank' : c.op === 'not_null' ? 'is filled' : c.op.replace('gte', '≥').replace('lte', '≤').replace('gt', '>').replace('lt', '<')}${c.value !== undefined ? ` “${c.value}”` : ''}${c.values ? ` (${c.values.slice(0, 4).join(', ')}${c.values.length > 4 ? ', …' : ''})` : ''}`;
  switch (s.type) {
    case 'header':
      return `Read sheet ${s.sheet + 1}, header on row ${s.row}: ${s.columns.length} columns`;
    case 'trim':
      return `Tidy text (spaces, invisible characters) in ${s.columns === 'all' ? 'every text column' : s.columns.map(L).join(', ')}`;
    case 'drop_rows':
      return s.when === 'empty' ? 'Remove empty rows' : s.when === 'totals' ? 'Set aside totals rows' : `Remove rows where ${(s.where ?? []).map(cond).join(' and ')}`;
    case 'convert':
      return `Read ${L(s.column)} as ${s.to === 'number' ? `a number${s.locale === 'pt' ? ' (Portuguese format 1.234,56)' : s.locale === 'en' ? ' (1,234.56 format)' : ''}` : s.to === 'date' ? 'a date' : s.to === 'identifier' ? 'an identifier (text, leading zeros kept)' : s.to}`;
    case 'drop_column':
      return `Drop ${L(s.column)}${s.keepAs === 'unit' ? ' (kept as the unit of the amounts)' : s.keepAs === 'note' ? ' (kept as a note)' : ''}`;
    case 'rename':
      return `Call ${L(s.column)} “${s.label}”`;
    case 'signed':
      return `${s.into.label}: ${L(s.column)}, negative when ${s.negateWhen.map(cond).join(' and ')}`;
    case 'derive':
      return `${s.into.label}: ${s.kind.replace('_', ' ')} of ${L(s.from)}${s.to ? ` and ${L(s.to)}` : ''}${s.asOf ? ` as of ${s.asOf === 'max' ? 'the latest date in the file' : s.asOf}` : ''}`;
    case 'map_values':
      return `Map ${s.map.length} value${s.map.length === 1 ? '' : 's'} of ${L(s.column)}${s.into ? ` into ${s.into.label}` : ''}`;
    case 'canonical':
      return `One name per ${L(s.code)} (${s.into.label})${s.groupInto ? `, and a ${s.groupInto.label} joining codes with the same name` : ''}`;
    case 'classify':
      return `${s.into.label} from ${L(s.column)}: ${s.rules.map((r) => `${r.value} (${r.contains.slice(0, 3).join('/')})`).join(', ')}, else ${s.otherwise}`;
    case 'duplicates':
      return `${s.action === 'drop' ? 'Remove' : 'Flag'} duplicate ${s.columns.map(L).join(' + ')}`;
    case 'check':
      return `Check: ${s.label}`;
    case 'filter':
      return `Keep rows where ${s.where.map(cond).join(' and ')}`;
    case 'table':
      return `${s.role === 'fact' ? 'Fact table' : s.role === 'dimension' ? 'Dimension' : 'Summary'} “${s.label}”${s.groupBy.length ? ` by ${s.groupBy.map((g) => g.label ?? L(g.column)).join(', ')}` : ''}`;
    case 'pivot':
      return `Pivot “${s.label}”: ${L(s.rows)} × ${L(s.columns)}${s.value ? `, ${s.fn} of ${L(s.value)}` : ', count'}`;
    case 'ageing':
      return `Ageing “${s.label}”: ${L(s.amount)} by age of ${L(s.date)} (${s.buckets.join('/')} days)${s.per ? ` per ${L(s.per)}` : ''}`;
    case 'exceptions':
      return `Exceptions “${s.label}”: every rejected value and failed check, with its row in the file`;
  }
}

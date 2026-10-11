// Guided imports over HTTP: datasets (a file brought in, read, profiled, prepared step by step),
// runs and their outputs and insights, the assistant, related data and merges, recipes (saved steps
// reused on the next file), placing outputs in the document, and the lineage of a placed table.
// See server/src/routes/datasets.ts.
import { tenantFetch as fetch } from './tenant';

export type Stage = 'read' | 'clean' | 'structure' | 'check' | 'analyse';
export type Step = { id: string; type: string; why?: string; by?: 'rule' | 'assistant' | 'person'; enabled?: boolean; stage?: Stage } & Record<string, unknown>;
export type Roles = Record<string, string | undefined>;
export interface ColumnMeta {
  key: string;
  label: string;
  type: 'number' | 'date' | 'identifier' | 'text' | 'boolean' | 'empty';
  unit?: string;
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
  type: string;
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
export interface CheckResult {
  step: string;
  label: string;
  severity: 'info' | 'warning' | 'error';
  failing: number;
  total: number;
}
export interface Preview {
  columns: ColumnMeta[];
  rows: unknown[][];
  total: number;
}
export interface RunOutput {
  ok: boolean;
  failedAt?: string;
  results: StepResult[];
  columns: ColumnMeta[];
  rows: number;
  outputs: OutputMeta[];
  checks: CheckResult[];
  unit?: string;
  sample?: number;
  preview?: { work: Preview; outputs: Record<string, Preview> };
  ms: number;
  described?: { id: string; text: string; stage: Stage }[];
}
export interface Series {
  label: string;
  unit?: string;
  /** parallel arrays: x[i] is the label (a month) of y[i] */
  x: string[];
  y: number[];
}
export interface Insight {
  id: string;
  kind: string;
  level: 'info' | 'good' | 'warning';
  title: string;
  text: string;
  figures: { label: string; value: number | string; unit?: string }[];
  series?: Series[];
  sql?: string;
  step?: Step;
}
export interface Insights {
  asOf: string | null;
  from: string | null;
  months: { month: string; docs: number; invoiced: number; credited: number; net: number }[];
  items: Insight[];
  ms: number;
}
export interface RunMeta {
  id: string;
  at: string;
  by: string;
  ok: boolean;
  failedAt?: string;
  rows: number;
  ms: number;
  unit?: string;
  steps: Step[];
  roles: Roles;
  recipe?: { id: string; version: number };
  outputs: OutputMeta[];
  checks: CheckResult[];
  results: StepResult[];
  columns: ColumnMeta[];
  insights?: Insights;
  insightsError?: string;
  described?: { id: string; text: string; stage: Stage }[];
}
export interface SheetMeta {
  index: number;
  name: string;
  rows: number;
  cols: number;
}
export interface LayoutLine {
  level: 'info' | 'warning' | 'error';
  text: string;
}
export interface DatasetMeta {
  id: string;
  name: string;
  file: string;
  size: number;
  createdAt: string;
  createdBy: string;
  status: 'reading' | 'ready' | 'failed';
  error?: string;
  sheets: SheetMeta[];
  draft?: { steps: Step[]; roles: Roles; at: string; by: string; recipe?: { id: string; version: number } };
  runs: { id: string; at: string; by: string; ok: boolean; rows: number; recipe?: { id: string; version: number } }[];
  placements: { doc: string; at: string; by: string; run: string; merge?: string; tables: { output: string; table: number; name: string; rows: number; truncated?: boolean }[] }[];
  merges: { id: string; at: string; by: string; kind: 'append' | 'reconcile' | 'compare'; other: string; otherName: string; key?: { a: string; b: string }; keyLabels?: { a: string; b: string }; run?: string; otherRun?: string; result: { kind: string; rows: number; tables: { key: string; label: string; rows: number; columns: ColumnMeta[] }[]; notes: string[]; roles: Roles; ms: number } }[];
  match?: { recipe: string; version: number; name: string; score: number; summary: LayoutLine[]; blocked: number; auto: boolean; ran?: boolean };
}
export interface DatasetRow {
  id: string;
  name: string;
  file: string;
  size: number;
  createdAt: string;
  createdBy: string;
  status: DatasetMeta['status'];
  error?: string;
  rows: number;
  sheets: number;
  runs: number;
  lastRun: DatasetMeta['runs'][number] | null;
  placements: number;
  match: DatasetMeta['match'] | null;
  recipe: { id: string; version: number } | null;
}
export interface ColumnProfile {
  index: number;
  key: string;
  label: string;
  filled: number;
  blanks: number;
  distinct: number;
  storage: { number: number; text: number; date: number };
  numText: { pt: number; en: number; plain: number; ambiguous: number };
  dateText: number;
  inferred: 'number' | 'date' | 'identifier' | 'text' | 'category' | 'boolean' | 'empty';
  locale?: 'pt' | 'en';
  min?: number | string;
  max?: number | string;
  sum?: number;
  negatives?: number;
  zeros?: number;
  top: { value: string | number; count: number }[];
  shapes: { shape: string; count: number }[];
  untidy: number;
  constant: boolean;
  duplicates: number;
  maxLength: number;
}
export interface SheetProfile {
  index: number;
  name: string;
  headerRow: number;
  headerCandidates: number[];
  rows: number;
  gaps: number;
  totalsRows: number[];
  columns: ColumnProfile[];
  pairs: { code: string; name: string; codesWithManyNames: number; namesWithManyCodes: number; examples: { code: string; names: string[]; counts: number[] }[]; groups: { name: string; codes: string[] }[] }[];
  equal: { a: string; b: string; equal: number; of: number }[];
  ms: number;
}
export interface Proposal {
  steps: Step[];
  roles: Roles;
  findings: { level: 'info' | 'warning'; text: string }[];
}
export interface Job {
  id: string;
  dataset: string;
  kind: 'read' | 'run' | 'relate' | 'combine';
  status: 'queued' | 'running' | 'done' | 'failed';
  phase?: string;
  done?: number;
  of?: number;
  startedAt?: string;
  endedAt?: string;
  error?: string;
  result?: Record<string, unknown>;
}
export interface AssistAction {
  op: 'add' | 'update' | 'remove';
  after?: string;
  id?: string;
  step?: Step;
  why: string;
  error?: string;
}
export interface AssistReply {
  reply: string;
  actions: AssistAction[];
  questions: string[];
  model?: string;
  offline?: boolean;
}
export interface KeyMatch {
  a: string;
  aLabel: string;
  b: string;
  bLabel: string;
  common: number;
  aDistinct: number;
  bDistinct: number;
  aUnique: boolean;
}
export interface Suggestion {
  kind: 'append' | 'reconcile' | 'compare';
  title: string;
  text: string;
  key?: { a: string; b: string };
  score: number;
}
export interface Relation {
  other: string;
  name: string;
  layout: 'same' | 'similar' | 'different';
  labelOverlap: number;
  period: { a: [string | null, string | null]; b: [string | null, string | null]; order: 'before' | 'after' | 'overlap' | 'unknown' };
  keys: KeyMatch[];
  suggestions: Suggestion[];
}
export interface RecipeRow {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  createdBy: string;
  auto: boolean;
  current: number;
  versions: { version: number; at: string; by: string; note?: string; steps: number; sheet: string; columns: number }[];
  uses: { at: string; dataset: string; file: string; version: number; run?: string; ok?: boolean; rows?: number; score: number }[];
}
export type ColumnChange =
  | { kind: 'same'; key: string; header: string; index: number }
  | { kind: 'moved'; key: string; header: string; from: number; to: number }
  | { kind: 'renamed'; key: string; from: string; to: string; index: number; confidence: number }
  | { kind: 'missing'; key: string; header: string; usedBy: string[] }
  | { kind: 'new'; header: string; index: number; type: string }
  | { kind: 'type'; key: string; header: string; was: string; now: string };
export interface LayoutDiff {
  recipe: string;
  version: number;
  name: string;
  score: number;
  sheet: { was: string; now: string };
  headerRow: { was: number; now: number };
  columns: ColumnChange[];
  values: { key: string; header: string; values: { value: string; count: number }[]; usedBy: string[] }[];
  summary: LayoutLine[];
  steps: Step[];
  blocked: { step: string; missing: string[] }[];
}
export interface Lineage {
  dataset: { id: string; name: string; file: string; size: number; sha256?: string; createdAt: string; createdBy: string; sheet?: string };
  run: { id: string; at: string; by: string; rows: number; ms: number; recipe?: { id: string; version: number } };
  placement: { at: string; by: string; name: string; rows: number; truncated?: boolean };
  output: OutputMeta;
  steps: { id: string; type: string; stage: Stage; text: string; why?: string; by?: string; status: string; rowsIn: number; rowsOut: number; changed: number; rejected: number; issues: number; notes: string[]; examples: StepResult['examples'] }[];
  checks: CheckResult[];
  /** when the table came from a merge analysis: what was matched with what, and what it found */
  merge?: { id: string; kind: 'append' | 'reconcile' | 'compare'; other: string; otherName: string; keyLabels?: { a: string; b: string }; notes: string[]; at: string; by: string };
  row?: {
    index: number;
    /** the file the row comes from, when it is the other file of a comparison */
    file?: string;
    sourceRow?: number;
    /** the line under its own headers; key is the column's key in the steps (renames keep it) */
    original?: { header: string; key: string; value: unknown }[];
    cleaned?: { label: string; key: string; value: unknown }[];
    issues: IssueRow[];
    group?: { label: string; value: unknown }[];
    members?: { count: number; sampleRows: number[] };
  };
}
export interface IssueRow {
  step: string;
  kind: string;
  severity: string;
  row?: number;
  col: string | null;
  value: unknown;
  detail: string | null;
}
export interface Page {
  columns: string[];
  rows: unknown[][];
  total: number;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}
const enc = encodeURIComponent;
const qs = (o: Record<string, string | number | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${enc(String(v))}`)
    .join('&');

export const datasets = {
  list: () => call<{ datasets: DatasetRow[] }>('GET', '/api/datasets'),
  upload: async (file: File) => {
    const res = await fetch(`/api/datasets?name=${enc(file.name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
    return data as { dataset: DatasetMeta; job: Job };
  },
  get: (id: string) => call<{ dataset: DatasetMeta; profiles: SheetProfile[]; proposal: Proposal | null; jobs: Job[] }>('GET', `/api/datasets/${id}`),
  rename: (id: string, name: string) => call<{ dataset: DatasetMeta }>('PATCH', `/api/datasets/${id}`, { name }),
  remove: (id: string) => call<{ ok: true }>('DELETE', `/api/datasets/${id}`),
  raw: (id: string, sheet: number, offset = 0, limit = 40) => call<{ sheet: SheetMeta; columns: number; rows: unknown[][] }>('GET', `/api/datasets/${id}/raw?${qs({ sheet, offset, limit })}`),
  saveDraft: (id: string, steps: Step[], roles: Roles, recipe?: { id: string; version: number }) => call<{ dataset: DatasetMeta }>('PUT', `/api/datasets/${id}/draft`, { steps, roles, recipe }),
  preview: (id: string, steps: Step[], sample = 3000) => call<RunOutput>('POST', `/api/datasets/${id}/preview`, { steps, sample }),
  run: (id: string, steps: Step[], roles: Roles, recipe?: { id: string; version: number }) => call<{ job: Job }>('POST', `/api/datasets/${id}/run`, { steps, roles, recipe }),
  job: (job: string) => call<{ job: Job }>('GET', `/api/datasets/jobs/${job}`),
  runMeta: (id: string, run: string) => call<{ run: RunMeta }>('GET', `/api/datasets/${id}/runs/${run}`),
  table: (id: string, run: string, table: string, offset = 0, limit = 100, filter?: { column: string; value: string }) => call<Page>('GET', `/api/datasets/${id}/runs/${run}/table/${enc(table)}?${qs({ offset, limit, column: filter?.column, value: filter?.value })}`),
  issues: (id: string, run: string, step?: string, offset = 0, limit = 100) => call<{ total: number; removed: number; rows: IssueRow[] }>('GET', `/api/datasets/${id}/runs/${run}/issues?${qs({ step, offset, limit })}`),
  exportUrl: (id: string, run: string, table: string) => `/api/datasets/${id}/runs/${run}/export/${enc(table)}`,
  sourceUrl: (id: string) => `/api/datasets/${id}/source`,
  assist: (id: string, question: string, steps: Step[], roles: Roles, result?: RunOutput | null, focus?: string) => call<AssistReply>('POST', `/api/datasets/${id}/assist`, { question, steps, roles, result: result ? summaryOf(result) : undefined, focus }),
  validateStep: (id: string, steps: Step[], action: { op: 'add' | 'update' | 'remove'; after?: string; id?: string; step?: Step; why?: string }) => call<AssistAction>('POST', `/api/datasets/${id}/validate-step`, { steps, action }),
  related: (id: string) => call<{ relations: Relation[]; ms: number; runs: Record<string, string> }>('GET', `/api/datasets/${id}/related`),
  merge: (id: string, kind: 'append' | 'reconcile' | 'compare', other: string, key?: { a: string; b: string }) => call<{ job: Job }>('POST', `/api/datasets/${id}/merge`, { kind, other, key }),
  mergeTable: (id: string, merge: string, table: string, offset = 0, limit = 100) => call<Page>('GET', `/api/datasets/${id}/merges/${merge}/table/${enc(table)}?${qs({ offset, limit })}`),
  recipeDiff: (id: string, recipe: string, version?: number) => call<{ diff: LayoutDiff; roles: Roles }>('GET', `/api/datasets/${id}/recipe-diff/${recipe}?${qs({ version })}`),
  place: (doc: string, dataset: string, run: string | undefined, outputs: string[], maxRows?: number, merge?: string) => call<{ placement: DatasetMeta['placements'][number]; seq?: number }>('POST', `/api/files/${doc}/datasets/place`, { dataset, run, merge, outputs, maxRows }),
  lineage: (doc: string, table: number, row?: number, source?: number) => call<{ lineage: Lineage }>('GET', `/api/files/${doc}/lineage?${qs({ table, row, source })}`),
  lineageTables: (doc: string) => call<{ tables: { table: number; dataset: string; run: string; output: string; name: string }[] }>('GET', `/api/files/${doc}/lineage/tables`),
};

export const recipes = {
  list: () => call<{ recipes: RecipeRow[] }>('GET', '/api/recipes'),
  save: (body: { id?: string; dataset: string; run?: string; name: string; description?: string; auto?: boolean; note?: string }) => call<{ recipe: RecipeRow }>('POST', '/api/recipes', body),
  update: (id: string, body: { name?: string; description?: string; auto?: boolean }) => call<{ recipe: RecipeRow }>('PATCH', `/api/recipes/${id}`, body),
  remove: (id: string) => call<{ ok: true }>('DELETE', `/api/recipes/${id}`),
};

/** Wait for a dataset job, reporting progress; resolves with the finished job (done or failed). */
export async function waitJob(job: string, onProgress?: (j: Job) => void, signal?: { cancelled: boolean }): Promise<Job> {
  for (;;) {
    if (signal?.cancelled) throw new Error('cancelled');
    const { job: j } = await datasets.job(job);
    onProgress?.(j);
    if (j.status === 'done' || j.status === 'failed') return j;
    await new Promise((r) => setTimeout(r, 800));
  }
}

export const fmtNum = (v: unknown, unit?: string) => {
  if (typeof v !== 'number') return v === null || v === undefined ? '' : String(v);
  const s = Number.isInteger(v) ? v.toLocaleString('en-GB') : v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return unit ? `${s} ${unit}` : s;
};
export const fmtBytes = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(0)} kB` : `${n} B`);

/** What the assistant needs from a result: per-step figures, checks and output sizes, not the rows. */
function summaryOf(r: RunOutput) {
  return { ok: r.ok, failedAt: r.failedAt, rows: r.rows, results: r.results, checks: r.checks, outputs: r.outputs.map((o) => ({ key: o.key, label: o.label, rows: o.rows })) };
}

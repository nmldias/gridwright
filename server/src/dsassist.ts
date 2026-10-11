// The import assistant: a model that looks at the profile, the current steps and their results, and
// answers — explaining what it sees and proposing steps. Its proposals are validated against the step
// catalogue and the columns that exist at that point, marked as the assistant's, and shown for the
// person to accept one by one: nothing it says changes the data by itself.
import { completeOnce } from './ai.js';
import type { SheetProfile } from './dsprofile.js';
import { describe, readsOf, StepSchema, writesOf, type Roles, type Step } from './dssteps.js';
import type { RunOutput } from './dsrun.js';

export interface AssistAction {
  op: 'add' | 'update' | 'remove';
  /** add: insert after this step id (end when absent); update/remove: the step id */
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

const CATALOGUE = `Steps (JSON objects; every step has "id" (short, unique), "type", "why" (plain words, for the audit)):
- header {sheet, row, columns:[{index,key,label}]} — always first; keys are lower_snake_case.
- trim {columns:"all"|[keys]} — trim spaces, collapse blanks, empty text to null.
- drop_rows {when:"empty"|"totals"|"match", where?:[cond]} — remove blank rows, total lines, or rows matching.
- convert {column, to:"number"|"date"|"identifier"|"text"|"boolean", locale:"auto"|"pt"|"en", dayFirst} — values that do not convert are kept as issues, never silently lost.
- drop_column {column, keepAs:"none"|"unit"|"note"} — e.g. a constant currency column kept as the unit.
- rename {column, label}.
- signed {column, negateWhen:[cond], into:{key,label}} — a signed amount (credit notes negative).
- derive {into:{key,label}, kind:"month"|"quarter"|"year"|"weekday"|"days_between"|"age_days"|"extract"|"upper"|"copy"|"prefix", from, to?, asOf?, pattern?, chars?}.
- map_values {column, map:[{from,to}], into?} — fix spellings, unify codes.
- canonical {code, name, into:{key,label}, groupInto?} — one name per code (the most frequent spelling).
- classify {column, into, rules:[{contains:[words], value}], otherwise} — e.g. customer type from the name.
- duplicates {columns:[keys], action:"flag"|"drop", into?}.
- check {kind:"unique"|"required"|"pattern"|"equal_columns"|"positive"|"in_list", column, other?, pattern?, values?, where?, severity:"info"|"warning"|"error", label}.
- filter {where:[cond]} — keep only matching rows (removed rows are kept aside for the audit).
- table {key, label, role:"fact"|"dimension"|"summary", groupBy:[{column,label?}], measures:[{fn:"count"|"sum"|"min"|"max"|"avg"|"count_distinct"|"first"|"share", column?, label, where?}], where?, orderBy?:[{by:<label>,desc}], limit?, columns?} — an output table.
- pivot {key, label, rows, columns, value?, fn:"sum"|"count", where?}.
- ageing {key, label, date, amount, asOf:"max"|"YYYY-MM-DD", buckets:[days], per?, where?, limit?}.
- exceptions {key, label} — every row with an issue, for review.
cond = {column, op:"eq"|"neq"|"in"|"not_in"|"gt"|"gte"|"lt"|"lte"|"is_null"|"not_null"|"contains", value?, values?}.`;

const SYSTEM = `You are the data preparation assistant of a finance tool used by CFOs and controllers. You help turn a raw spreadsheet export into clean, structured tables (a fact table, dimensions, summaries) and an analysis, step by step.
Rules:
- Answer in the language of the person's question (default English). Be concise and concrete: name columns, counts, values.
- Base every statement on the profile and results given; never invent figures. If something cannot be known from them, say so and ask.
- Propose changes only as steps from the catalogue, referring to existing column keys. Prefer few, well-explained steps. Never remove data silently: use checks, flags, or filters whose removed rows stay visible.
- In "reply", name steps by what they do ("the Valor Total number step"), never by their id; ids belong only in "actions".
- Keep "reply" under 250 words: short headings and bullets, the figures that matter, no restating of the whole profile. Propose at most 5 steps at a time.
- Return ONLY a JSON object (no code fence, no text around it): {"reply": "<markdown text for the person>", "actions": [{"op":"add"|"update"|"remove", "after"?: "<step id>", "id"?: "<step id>", "step"?: {...}, "why": "<one sentence>"}], "questions": ["<question for the person>"]}.
${CATALOGUE}`;

function compactProfile(p: SheetProfile) {
  return {
    sheet: p.name,
    headerRow: p.headerRow,
    headerCandidates: p.headerCandidates,
    rows: p.rows,
    totalsRows: p.totalsRows.slice(0, 10),
    columns: p.columns.map((c) => ({
      index: c.index,
      key: c.key,
      header: c.label,
      type: c.inferred,
      locale: c.locale,
      filled: c.filled,
      blanks: c.blanks,
      distinct: c.distinct,
      storage: c.storage,
      numbersAsText: c.numText,
      datesAsText: c.dateText || undefined,
      top: c.top.slice(0, 8).map((t) => `${String(t.value).slice(0, 40)} (${t.count})`),
      shapes: c.shapes.slice(0, 3).map((s) => `${s.shape} (${s.count})`),
      untidy: c.untidy || undefined,
      constant: c.constant || undefined,
      duplicates: c.duplicates || undefined,
      negatives: c.negatives || undefined,
      range: c.min !== undefined ? [c.min, c.max] : undefined,
    })),
    codeNamePairs: p.pairs.map((x) => ({ code: x.code, name: x.name, codesWithManyNames: x.codesWithManyNames, namesWithManyCodes: x.namesWithManyCodes, example: x.examples[0] })),
    equalColumns: p.equal,
  };
}

/** The last result as the model sees it. The body comes from the browser, so every field is optional. */
function compactResults(r: RunOutput | null) {
  if (!r || typeof r !== 'object') return null;
  const arr = <T,>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
  return {
    ok: r.ok,
    failedAt: r.failedAt,
    rows: r.rows,
    steps: arr<RunOutput['results'][number]>(r.results).slice(0, 80).map((x) => ({ id: x?.id, status: x?.status, in: x?.rowsIn, out: x?.rowsOut, changed: x?.changed, rejected: x?.rejected, issues: x?.issues, notes: arr<string>(x?.notes).slice(0, 3), error: x?.error })),
    checks: arr<RunOutput['checks'][number]>(r.checks).slice(0, 60).map((c) => ({ label: c?.label, severity: c?.severity, failing: c?.failing, of: c?.total })),
    outputs: arr<RunOutput['outputs'][number]>(r.outputs).slice(0, 30).map((o) => ({ key: o?.key, label: o?.label, rows: o?.rows })),
  };
}

type Parsed = { reply: string; actions: unknown[]; questions: unknown[]; truncated?: boolean };
const REPLY_KEYS = ['reply', 'answer', 'message', 'text', 'explanation'];

/** One JSON string literal starting at `i` (just after its opening quote), tolerating a cut-off end. */
function readString(s: string, i: number): { value: string; end: number; complete: boolean } {
  let raw = '';
  for (let k = i; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\') {
      if (k + 1 >= s.length) break;
      raw += ch + s[k + 1];
      k++;
      continue;
    }
    if (ch === '"') return { value: decode(raw), end: k + 1, complete: true };
    raw += ch;
  }
  return { value: decode(raw.replace(/\\u[0-9a-fA-F]{0,3}$/, '')), end: s.length, complete: false };
}
function decode(raw: string): string {
  try {
    return JSON.parse(`"${raw.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`);
  } catch {
    return raw.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}
/** The complete items of the array value of `key`, even when the text stops in the middle of it. */
function readArray(s: string, key: string): unknown[] {
  const m = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(s);
  if (!m) return [];
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  for (let k = m.index + m[0].length; k < s.length; k++) {
    const ch = s[k];
    if (ch === '"') {
      const r = readString(s, k + 1);
      if (depth === 0 && r.complete) out.push(r.value);
      if (!r.complete) break;
      k = r.end - 1;
      continue;
    }
    if (ch === '{' || ch === '[') {
      if (depth === 0) start = k;
      depth++;
    } else if (ch === '}' || ch === ']') {
      if (depth === 0) break; // the end of the array
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(s.slice(start, k + 1)));
        } catch {
          /* a malformed item is skipped */
        }
        start = -1;
      }
    }
  }
  return out;
}
function normalise(j: Record<string, unknown>, prose: string): Parsed {
  const key = REPLY_KEYS.find((k) => typeof j[k] === 'string' && (j[k] as string).trim());
  return {
    reply: key ? String(j[key]) : prose,
    actions: Array.isArray(j.actions) ? j.actions : [],
    questions: Array.isArray(j.questions) ? j.questions : [],
  };
}
/**
 * The model is asked for one JSON object, but answers vary: fenced or bare JSON, prose around it, or a
 * reply cut off by the token limit. Recover the text and every complete proposed step; never show raw JSON.
 */
export function parseReply(text: string): Parsed {
  const t = text.trim();
  const blocks: { body: string; prose: string }[] = [];
  for (const m of t.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) blocks.push({ body: m[1], prose: t.replace(m[0], '').trim() });
  blocks.push({ body: t, prose: '' });
  for (const b of blocks) {
    const s = b.body.indexOf('{');
    const e = b.body.lastIndexOf('}');
    if (s < 0 || e <= s) continue;
    try {
      const j = JSON.parse(b.body.slice(s, e + 1));
      if (j && typeof j === 'object' && !Array.isArray(j) && (REPLY_KEYS.some((k) => k in j) || 'actions' in j)) {
        return normalise(j as Record<string, unknown>, b.prose || (s > 0 ? b.body.slice(0, s).trim() : ''));
      }
    } catch {
      /* try the next reading */
    }
  }
  // a cut-off object: take the reply string and the complete items
  const body = t.replace(/^```(?:json)?\s*/i, '');
  for (const k of REPLY_KEYS) {
    const m = new RegExp(`"${k}"\\s*:\\s*"`).exec(body);
    if (!m) continue;
    const r = readString(body, m.index + m[0].length);
    return { reply: r.value, actions: readArray(body, 'actions'), questions: readArray(body, 'questions'), truncated: true };
  }
  const actions = readArray(body, 'actions');
  if (actions.length) return { reply: '', actions, questions: readArray(body, 'questions'), truncated: true };
  return { reply: t, actions: [], questions: [] };
}

/** Check a proposal against the steps: the columns it reads must exist before it, the id must be free. */
export function validateAction(steps: Step[], a: { op?: unknown; after?: unknown; id?: unknown; step?: unknown; why?: unknown }): AssistAction {
  const why = typeof a.why === 'string' ? a.why.slice(0, 400) : '';
  const op = a.op === 'update' || a.op === 'remove' ? a.op : 'add';
  const id = typeof a.id === 'string' ? a.id : undefined;
  const after = typeof a.after === 'string' ? a.after : undefined;
  if (op === 'remove') {
    if (!id || !steps.some((s) => s.id === id)) return { op, id, why, error: 'no such step' };
    if (steps.find((s) => s.id === id)?.type === 'header') return { op, id, why, error: 'the header step cannot be removed' };
    return { op, id, why };
  }
  const parsed = StepSchema.safeParse({ ...(a.step as object), by: 'assistant', why: (a.step as { why?: string })?.why ?? why });
  if (!parsed.success) return { op, id, after, why, error: parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).slice(0, 3).join('; ') };
  const step = parsed.data;
  if (step.type === 'header') return { op, id, after, why, step, error: 'the assistant does not rewrite the header step' };
  let pos: number;
  if (op === 'update') {
    pos = steps.findIndex((s) => s.id === (id ?? step.id));
    if (pos < 0) return { op, id, after, why, step, error: 'no such step to update' };
    step.id = steps[pos].id;
  } else {
    pos = after ? steps.findIndex((s) => s.id === after) + 1 : steps.length;
    if (pos <= 0) pos = steps.length;
    if (steps.some((s) => s.id === step.id)) {
      let n = 2;
      while (steps.some((s) => s.id === `${step.id}_${n}`)) n++;
      step.id = `${step.id}_${n}`.slice(0, 40);
    }
  }
  // the columns that exist before this step
  const known = new Set<string>();
  for (const s of steps.slice(0, pos)) {
    if (s.enabled === false) continue;
    if (s.type === 'header') s.columns.forEach((c) => known.add(c.key));
    writesOf(s).forEach((k) => known.add(k));
  }
  const missing = readsOf(step).filter((k) => !known.has(k));
  if (missing.length) return { op, id: step.id, after, why, step, error: `reads columns that do not exist at that point: ${missing.join(', ')}` };
  return { op, id: step.id, after: op === 'add' ? steps[pos - 1]?.id : undefined, why, step };
}

export async function assist(input: { tenant?: string; login?: string; file: string; profile: SheetProfile; steps: Step[]; roles: Roles; result: RunOutput | null; question: string; focus?: string }): Promise<AssistReply> {
  const label = new Map(input.profile.columns.map((c) => [c.key, c.label]));
  const ctx = {
    file: input.file,
    profile: compactProfile(input.profile),
    roles: input.roles,
    steps: input.steps.map((s) => ({ id: s.id, type: s.type, enabled: s.enabled !== false, by: s.by, does: describe(s, (k) => label.get(k) ?? k), why: s.why, json: s.type === 'header' ? undefined : s })),
    lastResult: compactResults(input.result),
    focus: input.focus,
  };
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Context (JSON):\n${JSON.stringify(ctx).slice(0, 60_000)}\n\nThe person asks: ${input.question.slice(0, 2000)}` },
  ];
  let text: string;
  let model: string | undefined;
  try {
    const r = await completeOnce(messages, 4000, input.tenant, input.login);
    text = r.text;
    model = r.model;
  } catch (e) {
    const msg = (e as Error).message;
    return { reply: `The assistant is not available (${msg}). The steps proposed by the built-in rules are still here, and every step can be edited by hand.`, actions: [], questions: [], offline: true };
  }
  const j = parseReply(text);
  if (j.truncated) j.reply = `${j.reply.trimEnd()}\n\n*(The answer was cut short; ask a narrower question for the rest.)*`;
  // validate in order: an action may build on the one before it
  const working = [...input.steps];
  const actions: AssistAction[] = [];
  for (const a of (Array.isArray(j.actions) ? j.actions : []).slice(0, 12)) {
    const v = validateAction(working, a as never);
    actions.push(v);
    if (v.error || !v.step) continue;
    if (v.op === 'add') working.splice(v.after ? working.findIndex((s) => s.id === v.after) + 1 : working.length, 0, v.step);
    else if (v.op === 'update') working[working.findIndex((s) => s.id === v.id)] = v.step;
  }
  return { reply: String(j.reply ?? '').slice(0, 8000), actions, questions: (Array.isArray(j.questions) ? j.questions : []).filter((q): q is string => typeof q === 'string').slice(0, 5), model };
}

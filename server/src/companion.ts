// The companion's working model of a situation, kept per document: source-backed facts, the
// objective and its constraints, exclusions, hypotheses, contradictions, decisions with the
// conditions behind them, open questions, expectations (what should have happened), each with
// where it came from, the period it describes, when it arrived and whether a person stated it, an
// agent proposed it or a check observed it; a registry of watches (what is watched, why, under
// which conditions, with what authority); cheap deterministic checks that run on every change and
// on a timer; one evolving issue per watch; an understanding that answers what we are working
// toward, what matters now and what the next useful move is; and a brief of what has changed.
// The model is asked only to interpret an attention-level issue or to run a bounded
// investigation, and its words are stored as its own, beside the evidence.
//
// More information increases the companion's understanding, not its authority: nothing here grants
// access, and an instruction inside a record is data, not an instruction to anyone.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { currentSeq, onAppend, readAll, type Author, type LogEntry } from './history.js';
import { engineAvailable, errorMessage, openDocument, tableByName, tableMetas, type CellViewJson, type TableMetaView } from './headless.js';
import { DATA_DIR, listConnections, newId, readFile } from './storage.js';

export type RecordKind = 'fact' | 'source' | 'objective' | 'constraint' | 'hypothesis' | 'contradiction' | 'decision' | 'exclusion' | 'question' | 'expectation';
export const RECORD_KINDS: RecordKind[] = ['fact', 'source', 'objective', 'constraint', 'hypothesis', 'contradiction', 'decision', 'exclusion', 'question', 'expectation'];
/** kinds that frame every conclusion: changing one makes earlier conclusions provisional */
const ASSUMPTION_KINDS: RecordKind[] = ['objective', 'constraint', 'exclusion'];
export type RecordStatus = 'stated' | 'proposed' | 'confirmed' | 'observed' | 'resolved' | 'retired' | 'superseded';
const LIVE = (r: ContextRecord) => r.status !== 'retired' && r.status !== 'superseded' && r.status !== 'resolved';

export interface Condition {
  text: string;
  /** the watch that stands for this condition, when one does */
  watch?: string;
  /** computed at check: true holds, false no longer holds, undefined not watched / cannot tell */
  holds?: boolean;
  since?: string;
}

export interface ContextRecord {
  id: string;
  kind: RecordKind;
  text: string;
  /** where it came from: a file, a table, a connection, a person's words, an agent's reading; for an expectation, where the evidence would arrive */
  source?: string;
  /** the period the information describes (not the day it arrived) */
  period?: string;
  arrivedAt: string;
  by: Author;
  origin: 'user' | 'agent' | 'system';
  /** stated by a person; proposed by an agent until a person confirms; observed by a check; resolved; retired; superseded by a newer source */
  status: RecordStatus;
  supersededBy?: string;
  links?: { table?: number; ref?: string }[];
  /** question / contradiction: what depends on resolving it (a decision, a conclusion, a watch) */
  bearing?: string;
  /** expectation: when it is due (ISO date) and a text the evidence row would carry */
  due?: string;
  match?: string;
  /** expectation: what the last check found (open, met, missing, unchecked) or what the person said (didnt) */
  expected?: { state: 'open' | 'met' | 'missing' | 'unchecked' | 'didnt'; text: string; at: string };
  /** a consequential assumption: reconfirm it by this date */
  reviewBy?: string;
  reviewRaised?: boolean;
  /** decision: why, and the conditions that must keep holding */
  why?: string;
  conditions?: Condition[];
  /** decision: a condition behind it no longer holds (cleared when it holds again) */
  revisit?: { at: string; condition: string; summary: string };
  /** private working context: never sent to outside agents, shown only to its author when identity is on */
  private?: boolean;
  /** generated material (a brief, a summary, an export of the companion's own output): never independent evidence */
  derivative?: boolean;
  /** how a question or contradiction was settled */
  resolution?: string;
  /** dedupe key for records a check observes (conflicts, rejections) */
  key?: string;
}

export type WatchKind = 'threshold' | 'check' | 'change' | 'worsening';
export type Op = '>' | '>=' | '<' | '<=' | '=' | '!=';

export interface WatchDef {
  purpose: string;
  /** the population and its exclusions, in words */
  scope: string;
  /** a Gridwright formula evaluated headlessly against the live document */
  formula: string;
  /** table that gives the formula its context (default: the first table) */
  table?: string;
  kind: WatchKind;
  op?: Op;
  value?: number;
  /** for `worsening`: which way is bad (default up) */
  bad?: 'up' | 'down';
  /** consecutive comparable observations in breach before it is reported (baseline until then) */
  sustain: number;
  response: 'note' | 'brief' | 'case';
  /** essential sources (table names) and the age beyond which a conclusion is not presented */
  sources?: string[];
  freshnessHours?: number;
  /** the population the scope leaves out, as a formula: watched alongside so an exclusion cannot hide a movement */
  complement?: string;
}

export interface Observation {
  at: string;
  seq: number;
  /** the period of the snapshot this observation was made on (from the latest source record of the tables read) */
  period?: string;
  value: number | boolean | string | null;
  /** the excluded population's value, when the definition has a complement */
  complement?: number | null;
  error?: string;
  breach: boolean;
  fresh: boolean;
  /** hash of the definition that produced it: observations are comparable only within one definition */
  def: string;
}

export interface Interpretation {
  text: string;
  model: string;
  at: string;
  revision: number;
}

export interface Issue {
  id: string;
  watch: string;
  openedAt: string;
  updatedAt: string;
  status: 'open' | 'resolved';
  resolvedAt?: string;
  /** how many observations strengthened or revised it */
  revision: number;
  summary: string;
  evidence: string[];
  uncertainty: string[];
  next: string;
  interpretation?: Interpretation;
}

export type Health = 'ok' | 'baseline' | 'attention' | 'stale' | 'error' | 'unchecked' | 'proposed';

export interface Watch {
  id: string;
  def: WatchDef;
  defHash: string;
  authority: 'proposed' | 'approved';
  by: Author;
  origin: 'user' | 'agent';
  createdAt: string;
  updatedAt: string;
  lastChecked?: string;
  health: Health;
  observations: Observation[];
  issue?: Issue;
  /** closed issues, most recent last (bounded) */
  history: Issue[];
  /** how many times the recurrence was already pointed out */
  recurrenceRaised?: number;
}

export interface Event {
  at: string;
  /** trace: bookkeeping kept in the activity but left out of the brief */
  kind: 'record' | 'watch' | 'check' | 'issue' | 'decision' | 'source' | 'trace' | 'expectation' | 'conflict' | 'pattern' | 'assumption' | 'investigation';
  text: string;
  by?: string;
  level: 'quiet' | 'watch' | 'attention';
}

export interface SourceStatus {
  name: string;
  kind: 'table';
  lastChange?: string;
  /** manually supplied (import), live (SQL cell with a connection), or edited by hand */
  supply: 'import' | 'live' | 'manual' | 'unknown';
  rows: number;
}

export interface Dismissed {
  id: string;
  purpose: string;
  reason: 'not now' | 'not relevant' | 'incorrect';
  at: string;
  by: string;
  /** the latest snapshot period when it was set aside: "not now" returns with the next snapshot */
  period?: string;
}

export interface CodeRun {
  id: string;
  at: string;
  by: string;
  purpose: string;
  codeHash: string;
  ok: boolean;
  ms: number;
  sandbox: string;
  error?: string;
  output?: string;
  assumptionsSeq: number;
  investigation?: string;
}

export interface Investigation {
  id: string;
  question: string;
  issue?: string;
  thread: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'done' | 'failed';
  answer?: string;
  model?: string;
  error?: string;
  /** what the agent looked at and did, in order */
  steps: { tool: string; summary: string }[];
  runs: string[];
  records: string[];
  proposals: string[];
  by: Author;
  /** the assumptions it was made under: a later change makes it provisional */
  assumptionsSeq: number;
  stale?: boolean;
}

export interface CompanionState {
  doc: string;
  records: ContextRecord[];
  watches: Watch[];
  events: Event[];
  seenAt?: string;
  /** bumps whenever an objective, constraint or exclusion changes */
  assumptionsSeq?: number;
  dismissed?: Dismissed[];
  runs?: CodeRun[];
  investigations?: Investigation[];
}

export type Stance = 'quiet' | 'observation' | 'question' | 'decision';

export interface Uncertainty {
  kind: 'question' | 'contradiction' | 'expectation' | 'review' | 'provisional' | 'stale' | 'hypothesis' | 'proposed';
  text: string;
  /** what depends on resolving it — stated by a person, or read off the graph */
  bearing?: string;
  record?: string;
  watch?: string;
  rank: number;
}

export interface Understanding {
  objective?: ContextRecord;
  constraints: ContextRecord[];
  exclusions: ContextRecord[];
  /** what the conclusions rest on: each table with its supply, period and size — "based on these records", never "the complete position" */
  coverage: { name: string; period?: string; rows: number; supply: SourceStatus['supply']; lastChange?: string; derivative?: boolean }[];
  decisions: { record: ContextRecord; conditions: (Condition & { purpose?: string })[]; revisit?: ContextRecord['revisit'] }[];
  expectations: ContextRecord[];
  /** ranked by their potential to change a decision: what bears on something comes first */
  uncertain: Uncertainty[];
  stance: Stance;
  lead: string;
  /** the one next useful move */
  next: string;
  /** the understanding in a sentence or three, to be corrected rather than trusted */
  statement: string;
  attention: number;
  assumptionsSeq: number;
  investigations: Investigation[];
}

export interface Brief {
  changed: string[];
  matters: string[];
  next: string[];
  health: { checked?: string; ok: number; baseline: number; attention: number; stale: number; error: number; unchecked: number; proposed: number };
  sources: SourceStatus[];
  stance: Stance;
  lead: string;
  statement: string;
}

const DIR = () => join(DATA_DIR, 'companion');
const pathOf = (doc: string) => join(DIR(), `${doc}.json`);
const safeId = (id: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(id);
const MAX_OBS = 500;
const MAX_EVENTS = 300;
const MAX_RUNS = 100;
const MAX_INVESTIGATIONS = 40;

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}
function writeJsonAtomic(path: string, value: unknown) {
  mkdirSync(DIR(), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1));
  renameSync(tmp, path);
}

export function loadState(doc: string): CompanionState {
  if (!safeId(doc)) throw new Error('bad document id');
  const s = readJson<CompanionState>(pathOf(doc), { doc, records: [], watches: [], events: [] });
  s.records ??= [];
  s.watches ??= [];
  s.events ??= [];
  s.assumptionsSeq ??= 0;
  s.dismissed ??= [];
  s.runs ??= [];
  s.investigations ??= [];
  for (const w of s.watches) w.history ??= [];
  for (const i of s.investigations) {
    i.steps ??= [];
    i.runs ??= [];
    i.records ??= [];
    i.proposals ??= [];
  }
  return s;
}
function saveState(s: CompanionState) {
  if (s.events.length > MAX_EVENTS) s.events = s.events.slice(-MAX_EVENTS);
  for (const w of s.watches) if (w.observations.length > MAX_OBS) w.observations = w.observations.slice(-MAX_OBS);
  if ((s.runs ?? []).length > MAX_RUNS) s.runs = s.runs!.slice(-MAX_RUNS);
  if ((s.investigations ?? []).length > MAX_INVESTIGATIONS) s.investigations = s.investigations!.slice(-MAX_INVESTIGATIONS);
  writeJsonAtomic(pathOf(s.doc), s);
}
export function deleteCompanion(doc: string) {
  if (safeId(doc) && existsSync(pathOf(doc))) unlinkSync(pathOf(doc));
}
export function hasCompanion(doc: string): boolean {
  return safeId(doc) && existsSync(pathOf(doc));
}

const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);
const who = (a: Author) => a.name || a.login || 'someone';
function event(s: CompanionState, e: Omit<Event, 'at'>) {
  s.events.push({ at: now(), ...e });
}
const short = (t: string, n = 160) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

/** A changed frame: everything concluded before it is provisional until re-checked. */
function bumpAssumptions(s: CompanionState, r: ContextRecord, how: 'added' | 'changed' | 'retired' | 'removed', by: Author) {
  s.assumptionsSeq = (s.assumptionsSeq ?? 0) + 1;
  if (how === 'added') return; // "Kept what matters" is already in the activity
  const had = (s.investigations ?? []).filter((i) => i.status === 'done' && i.assumptionsSeq < (s.assumptionsSeq ?? 0)).length;
  event(s, { kind: 'assumption', text: `Assumption ${how}: ${r.kind} “${short(r.text, 100)}” — ${had ? `${had} earlier investigation${had === 1 ? ' is' : 's are'} now provisional; ` : ''}conclusions reached before it are provisional until re-checked`, by: who(by), level: 'watch' });
}

// ------------------------------------------------------------------ records
export interface RecordInput {
  kind: RecordKind;
  text: string;
  source?: string;
  period?: string;
  links?: ContextRecord['links'];
  bearing?: string;
  due?: string;
  match?: string;
  reviewBy?: string;
  why?: string;
  conditions?: (Condition | string)[];
  private?: boolean;
  derivative?: boolean;
  key?: string;
}
const str = (v: unknown, n: number) => (v === undefined || v === null ? undefined : String(v).trim().slice(0, n) || undefined);
const isoDate = (v: unknown) => {
  const t = str(v, 20);
  return t && /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : undefined;
};
const conditionsOf = (v: unknown): Condition[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out: Condition[] = [];
  for (const c of v.slice(0, 12)) {
    if (typeof c === 'string') {
      const text = c.trim().slice(0, 300);
      if (text) out.push({ text });
    } else if (c && typeof c === 'object' && typeof (c as Condition).text === 'string') {
      const text = (c as Condition).text.trim().slice(0, 300);
      const w = (c as Condition).watch;
      if (text) out.push({ text, watch: typeof w === 'string' && safeId(w) ? w : undefined, holds: (c as Condition).holds, since: (c as Condition).since });
    }
  }
  return out;
};
/** A file name that says the material was generated: a brief, a summary, an export of the companion's own output. */
export const looksDerivative = (name: string) => /gridwright|companion|brief|summary|resumo|sumário/i.test(name);

export function addRecord(doc: string, by: Author, origin: 'user' | 'agent' | 'system', input: RecordInput): ContextRecord {
  const s = loadState(doc);
  if (!RECORD_KINDS.includes(input.kind)) throw new Error(`kind must be one of ${RECORD_KINDS.join(', ')}`);
  const text = String(input.text ?? '').trim().slice(0, 2000);
  if (!text) throw new Error('text required');
  const r: ContextRecord = {
    id: newId(),
    kind: input.kind,
    text,
    source: str(input.source, 300),
    period: str(input.period, 80),
    arrivedAt: now(),
    by,
    origin,
    // a person's words stand; an agent's reading waits for a person; a check's finding is observed
    status: origin === 'agent' ? 'proposed' : origin === 'system' ? 'observed' : 'stated',
    links: input.links,
    bearing: str(input.bearing, 500),
    due: isoDate(input.due),
    match: str(input.match, 120),
    reviewBy: isoDate(input.reviewBy),
    why: str(input.why, 1000),
    conditions: conditionsOf(input.conditions),
    private: input.private ? true : undefined,
    derivative: input.derivative ? true : undefined,
    key: str(input.key, 200),
  };
  if (r.kind === 'source' && !r.derivative && looksDerivative(r.source ?? '')) r.derivative = true;
  // a newer snapshot of the same source supersedes the earlier one — authority is by source, not by date
  if (r.kind === 'source' && r.source) {
    for (const old of s.records) {
      if (old.kind === 'source' && old.source === r.source && old.status !== 'retired' && old.status !== 'superseded') {
        old.status = 'superseded';
        old.supersededBy = r.id;
      }
    }
  }
  s.records.push(r);
  const label = r.kind === 'objective' ? 'what matters' : r.kind === 'exclusion' ? 'what to leave out' : r.kind === 'expectation' ? 'what is expected' : r.kind;
  const shown = r.kind === 'source' ? text.replace(/\s*\(.*\)\s*$/, '') + (r.period ? ` (period ${r.period})` : '') + (r.derivative ? ' — generated material, not independent evidence' : '') : `${origin === 'agent' ? 'Proposed' : origin === 'system' ? 'Found' : 'Kept'} ${label}: ${short(text)}${r.kind === 'expectation' && r.due ? ` (by ${r.due}${r.source ? ` in ${r.source}` : ''})` : ''}`;
  event(s, { kind: r.kind === 'source' ? 'source' : r.kind === 'expectation' ? 'expectation' : r.kind === 'contradiction' && origin === 'system' ? 'conflict' : 'record', text: shown, by: who(by), level: 'quiet' });
  if (ASSUMPTION_KINDS.includes(r.kind) && origin === 'user') bumpAssumptions(s, r, 'added', by);
  saveState(s);
  return r;
}

export interface RecordPatch {
  text?: string;
  status?: 'confirmed' | 'retired' | 'stated' | 'resolved';
  period?: string;
  source?: string;
  kind?: RecordKind;
  bearing?: string;
  due?: string;
  match?: string;
  reviewBy?: string;
  why?: string;
  conditions?: (Condition | string)[];
  private?: boolean;
  derivative?: boolean;
  resolution?: string;
  /** expectation: what the person says happened */
  expected?: 'met' | 'didnt' | 'open';
}

export function updateRecord(doc: string, id: string, by: Author, patch: RecordPatch): ContextRecord {
  const s = loadState(doc);
  const r = s.records.find((x) => x.id === id);
  if (!r) throw new Error('record not found');
  const wasAssumption = ASSUMPTION_KINDS.includes(r.kind);
  let framed = false;
  if (patch.text !== undefined) {
    const t = String(patch.text).trim().slice(0, 2000);
    if (t && t !== r.text) {
      r.text = t;
      framed = true;
    }
  }
  if (patch.period !== undefined) r.period = str(patch.period, 80);
  if (patch.source !== undefined) r.source = str(patch.source, 300);
  if (patch.kind && RECORD_KINDS.includes(patch.kind) && patch.kind !== r.kind) {
    r.kind = patch.kind;
    framed = true;
  }
  if (patch.bearing !== undefined) r.bearing = str(patch.bearing, 500);
  if (patch.due !== undefined) r.due = isoDate(patch.due);
  if (patch.match !== undefined) r.match = str(patch.match, 120);
  if (patch.reviewBy !== undefined) {
    r.reviewBy = isoDate(patch.reviewBy);
    r.reviewRaised = undefined;
  }
  if (patch.why !== undefined) r.why = str(patch.why, 1000);
  if (patch.conditions !== undefined) {
    const next = conditionsOf(patch.conditions) ?? [];
    // keep what the checks know about conditions that stayed
    for (const c of next) {
      const prev = r.conditions?.find((p) => p.text === c.text && p.watch === c.watch);
      if (prev && c.holds === undefined) {
        c.holds = prev.holds;
        c.since = prev.since;
      }
    }
    r.conditions = next;
  }
  if (patch.private !== undefined) r.private = patch.private ? true : undefined;
  if (patch.derivative !== undefined) r.derivative = patch.derivative ? true : undefined;
  if (patch.resolution !== undefined) r.resolution = str(patch.resolution, 1000);
  if (patch.expected) {
    const text = patch.expected === 'met' ? `Arrived — ${who(by)} said so` : patch.expected === 'didnt' ? `Did not happen — ${who(by)} said so` : `Open again`;
    r.expected = { state: patch.expected, text, at: now() };
    event(s, { kind: 'expectation', text: `${short(r.text, 100)}: ${text}`, by: who(by), level: 'quiet' });
  }
  if (patch.status) {
    r.status = patch.status;
    const verb = patch.status === 'retired' ? 'Retired' : patch.status === 'confirmed' ? 'Confirmed' : patch.status === 'resolved' ? 'Resolved' : 'Corrected';
    event(s, { kind: 'record', text: `${verb} ${r.kind}: ${short(r.text)}${patch.status === 'resolved' && r.resolution ? ` — ${short(r.resolution, 120)}` : ''}`, by: who(by), level: 'quiet' });
    if (patch.status === 'retired' && wasAssumption) bumpAssumptions(s, r, 'retired', by);
  } else if (framed || patch.period !== undefined || patch.conditions !== undefined || patch.why !== undefined) {
    event(s, { kind: 'record', text: `Corrected ${r.kind}: ${short(r.text)}`, by: who(by), level: 'quiet' });
  }
  if (framed && (wasAssumption || ASSUMPTION_KINDS.includes(r.kind)) && !patch.status) bumpAssumptions(s, r, 'changed', by);
  saveState(s);
  return r;
}

export function removeRecord(doc: string, id: string, by: Author): boolean {
  const s = loadState(doc);
  const i = s.records.findIndex((x) => x.id === id);
  if (i < 0) return false;
  const [r] = s.records.splice(i, 1);
  event(s, { kind: 'record', text: `Removed ${r.kind}: ${short(r.text, 120)}`, by: who(by), level: 'quiet' });
  if (ASSUMPTION_KINDS.includes(r.kind) && LIVE(r)) bumpAssumptions(s, r, 'removed', by);
  saveState(s);
  return true;
}

/** A rejected proposal is a decision with a reason: the context carries it so that the same action is not proposed again unchanged. */
export function recordRejection(doc: string, by: Author, p: { id: string; title: string; agent: string; note?: string }): ContextRecord | null {
  if (!hasCompanion(doc) && !readFile(doc)) return null;
  const s = loadState(doc);
  const key = `rejected:${p.id}`;
  if (s.records.some((r) => r.key === key)) return null;
  const r: ContextRecord = { id: newId(), kind: 'decision', text: `Rejected “${short(p.title, 120)}”${p.note ? ` — ${short(p.note, 300)}` : ''}`, source: `proposal ${p.id} by ${p.agent}`, why: p.note ? short(p.note, 300) : undefined, arrivedAt: now(), by, origin: 'user', status: 'stated', key };
  s.records.push(r);
  event(s, { kind: 'decision', text: short(r.text), by: who(by), level: 'quiet' });
  saveState(s);
  return r;
}

// ------------------------------------------------------------------ watches
const OPS: Op[] = ['>', '>=', '<', '<=', '=', '!='];

export function normaliseDef(input: Partial<WatchDef>): WatchDef {
  const kind: WatchKind = input.kind === 'check' || input.kind === 'change' || input.kind === 'worsening' ? input.kind : 'threshold';
  const formula = String(input.formula ?? '').trim();
  if (!formula) throw new Error('formula required');
  const def: WatchDef = {
    purpose: String(input.purpose ?? '').trim().slice(0, 300) || 'Watch',
    scope: String(input.scope ?? '').trim().slice(0, 500),
    formula: formula.slice(0, 2000),
    table: input.table ? String(input.table).slice(0, 120) : undefined,
    kind,
    sustain: Math.max(1, Math.min(50, Math.round(Number(input.sustain ?? 1) || 1))),
    response: input.response === 'case' || input.response === 'note' ? input.response : 'brief',
    sources: Array.isArray(input.sources) ? input.sources.map((x) => String(x).slice(0, 120)).slice(0, 20) : undefined,
    freshnessHours: typeof input.freshnessHours === 'number' && input.freshnessHours > 0 ? input.freshnessHours : undefined,
    complement: input.complement ? String(input.complement).trim().slice(0, 2000) : undefined,
  };
  if (kind === 'threshold') {
    def.op = OPS.includes(input.op as Op) ? (input.op as Op) : '>';
    def.value = Number(input.value ?? 0) || 0;
  }
  if (kind === 'worsening') def.bad = input.bad === 'down' ? 'down' : 'up';
  return def;
}
const hashDef = (d: WatchDef) => createHash('sha256').update(JSON.stringify([d.formula, d.table ?? '', d.kind, d.op ?? '', d.value ?? '', d.bad ?? '', d.scope])).digest('hex').slice(0, 12);

export function addWatch(doc: string, by: Author, origin: 'user' | 'agent', input: Partial<WatchDef>): Watch {
  const s = loadState(doc);
  const def = normaliseDef(input);
  const w: Watch = {
    id: newId(),
    def,
    defHash: hashDef(def),
    // a person's watch is approved; an agent may only propose
    authority: origin === 'agent' ? 'proposed' : 'approved',
    by,
    origin,
    createdAt: now(),
    updatedAt: now(),
    health: origin === 'agent' ? 'proposed' : 'unchecked',
    observations: [],
    history: [],
  };
  s.watches.push(w);
  event(s, { kind: 'watch', text: `${origin === 'agent' ? 'Proposed watch' : 'Watching'}: ${def.purpose} — ${ruleText(def)}`, by: who(by), level: 'quiet' });
  saveState(s);
  return w;
}

/** Approve a proposed watch, or change its definition: a moved threshold is a decision with a name on it, and the baseline starts again. */
export function updateWatch(doc: string, id: string, by: Author, patch: { approve?: boolean; def?: Partial<WatchDef>; reason?: string }): Watch {
  const s = loadState(doc);
  const w = s.watches.find((x) => x.id === id);
  if (!w) throw new Error('watch not found');
  if (patch.approve) {
    w.authority = 'approved';
    if (w.health === 'proposed') w.health = 'unchecked';
    event(s, { kind: 'watch', text: `Approved watch: ${w.def.purpose}`, by: who(by), level: 'quiet' });
  }
  if (patch.def) {
    const next = normaliseDef({ ...w.def, ...patch.def });
    const nextHash = hashDef(next);
    const ruleMoved = ruleText(w.def) !== ruleText(next);
    const materially = nextHash !== w.defHash;
    if (ruleMoved) {
      // never silently normalised: a changed rule is a decision in the context, with who, when and why
      const text = `Rule of “${w.def.purpose}” changed from “${ruleText(w.def)}” to “${ruleText(next)}”${patch.reason ? ` — ${patch.reason}` : ''}`;
      s.records.push({ id: newId(), kind: 'decision', text, why: patch.reason ? short(patch.reason, 300) : undefined, arrivedAt: now(), by, origin: 'user', status: 'stated', source: 'watch definition' });
      event(s, { kind: 'decision', text, by: who(by), level: 'watch' });
    }
    w.def = next;
    if (materially) {
      w.defHash = nextHash;
      // earlier observations are no longer comparable: the baseline is rebuilt
      w.health = w.authority === 'approved' ? 'unchecked' : 'proposed';
      if (w.issue && w.issue.status === 'open') {
        w.issue.status = 'resolved';
        w.issue.resolvedAt = now();
        w.issue.next = 'Definition changed; the issue was closed and a new baseline is being built.';
        w.history.push(w.issue);
        w.issue = undefined;
      }
      event(s, { kind: 'watch', text: `Definition of “${next.purpose}” changed; baseline rebuilt`, by: who(by), level: 'quiet' });
    }
  }
  w.updatedAt = now();
  saveState(s);
  return w;
}

export function removeWatch(doc: string, id: string, by: Author): boolean {
  const s = loadState(doc);
  const i = s.watches.findIndex((x) => x.id === id);
  if (i < 0) return false;
  const [w] = s.watches.splice(i, 1);
  // a decision that leaned on it is no longer watched there
  for (const r of s.records) for (const c of r.conditions ?? []) if (c.watch === w.id) c.watch = undefined;
  event(s, { kind: 'watch', text: `Stopped watching: ${w.def.purpose}`, by: who(by), level: 'quiet' });
  saveState(s);
  return true;
}

// ------------------------------------------------------------------ sources and freshness
/** What the document's tables are fed by, and when each last changed — from the audit log, not from anyone's say-so. */
export function sourceStatus(doc: string, entries?: LogEntry[]): SourceStatus[] {
  if (!engineAvailable() || !readFile(doc)) return [];
  const log = entries ?? readAll(doc);
  const last = new Map<number, string>();
  const supply = new Map<number, SourceStatus['supply']>();
  for (const e of log) {
    const t = typeof e.op?.table === 'number' ? (e.op.table as number) : e.run ? e.run.table : undefined;
    if (t === undefined) continue;
    last.set(t, e.ts);
    if (e.origin === 'import') supply.set(t, 'import');
    else if (e.origin === 'sql' || (e.run && e.run.kind === 'sql')) supply.set(t, 'live');
    else if (e.origin === 'user' && !supply.has(t)) supply.set(t, 'manual');
  }
  // a table with no logged change of its own is as fresh as the document's last logged entry (its save)
  const docLast = log.length ? log[log.length - 1].ts : undefined;
  const { book } = openDocument(doc);
  try {
    return tableMetas(book).map((t) => ({ name: t.name, kind: 'table' as const, lastChange: last.get(t.id) ?? docLast, supply: supply.get(t.id) ?? 'unknown', rows: t.rows }));
  } finally {
    book.free();
  }
}

const hoursSince = (iso?: string) => (iso ? (Date.now() - Date.parse(iso)) / 3_600_000 : Infinity);

/** The snapshot period of each table: its latest live source record (set by the person or read from the file name). */
function periodsOf(s: CompanionState): Map<number, string> {
  const periodOfTable = new Map<number, string>();
  for (const r of s.records) {
    if (r.kind !== 'source' || r.status === 'retired' || r.status === 'superseded') continue;
    for (const l of r.links ?? []) if (typeof l.table === 'number' && r.period) periodOfTable.set(l.table, r.period);
  }
  return periodOfTable;
}
/** Whether a snapshot period reaches a date: 2026-10-13 ≥ 2026-10-12, 2026-10 ≥ 2026-10-12 (same month); null when the period is not a date. */
function periodReaches(period: string | undefined, date: string): boolean | null {
  if (!period) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(period)) return period >= date;
  if (/^\d{4}-\d{2}$/.test(period)) return period >= date.slice(0, 7);
  return null;
}

// ------------------------------------------------------------------ checks
type Plain = number | boolean | string | null;
function evaluate(doc: string, def: WatchDef, formula = def.formula): { value: Plain; error?: string } {
  const { book } = openDocument(doc);
  try {
    const t = def.table ? tableByName(book, def.table) : tableMetas(book)[0];
    if (!t) return { value: null, error: def.table ? `table “${def.table}” not found` : 'the document has no table' };
    const v = JSON.parse(book.preview(t.id, formula)) as { n?: number; b?: boolean; s?: string; e?: string } | null;
    if (!v) return { value: null };
    if ('e' in v && v.e) return { value: null, error: String(v.e) };
    if ('n' in v) return { value: v.n ?? null };
    if ('b' in v) return { value: !!v.b };
    if ('s' in v) return { value: v.s ?? null };
    return { value: null };
  } catch (e) {
    return { value: null, error: errorMessage(e) };
  } finally {
    book.free();
  }
}

/** The rule in words: “more than 1”, “must stay TRUE”, “getting worse”, “any change”. */
export function ruleText(d: WatchDef): string {
  if (d.kind === 'threshold') {
    const opWord = d.op === '>' ? 'more than' : d.op === '>=' ? 'at least' : d.op === '<' ? 'below' : d.op === '<=' ? 'at most' : d.op === '=' ? 'equal to' : 'different from';
    return `${opWord} ${fmt(d.value ?? 0)}`;
  }
  if (d.kind === 'check') return 'must stay TRUE';
  if (d.kind === 'worsening') return d.bad === 'down' ? 'falling, snapshot after snapshot' : 'rising, snapshot after snapshot';
  return 'any change';
}
const dateWord = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const whenOf = (o: Observation) => o.period ?? dateWord(o.at);

const compare = (v: number, op: Op, limit: number) => (op === '>' ? v > limit : op === '>=' ? v >= limit : op === '<' ? v < limit : op === '<=' ? v <= limit : op === '=' ? v === limit : v !== limit);
const fmt = (v: Plain) => (typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('en-GB') : v.toLocaleString('en-GB', { maximumFractionDigits: 2 })) : String(v));

/** Run every approved watch of a document; returns what changed level. Cheap: formulas only, no model. */
export function checkDocument(doc: string, reason = 'change', changedTables: number[] = []): { attention: number; changed: boolean; affected: string[] } {
  if (!engineAvailable() || !readFile(doc)) return { attention: 0, changed: false, affected: [] };
  const s = loadState(doc);
  const seq = currentSeq(doc);
  const log = readAll(doc);
  const sources = sourceStatus(doc, log);
  let changed = false;
  let attention = 0;
  const at = now();
  // which analyses the change reaches, by the graph's edges (named in the activity; every watch is still evaluated — it is cheap)
  let affected: string[] = [];
  if (changedTables.length && s.watches.length) {
    try {
      const g = graphOf(doc);
      const a = affectedBy(g, changedTables.map((t) => `table:${t}`));
      affected = a.watches.map((id) => s.watches.find((w) => w.id === id)?.def.purpose ?? id);
      const names = changedTables.map((t) => g.nodes.find((n) => n.id === `table:${t}`)?.label ?? `table ${t}`);
      if (affected.length) event(s, { kind: 'trace', text: `${names.join(', ')} changed → reassessing ${affected.join(', ')}`, level: 'quiet' });
    } catch {
      /* the graph is a convenience; the checks run regardless */
    }
  }
  const periodOfTable = periodsOf(s);
  let metas: TableMetaView[] = [];
  let cellsOf: ((id: number) => CellViewJson[]) | null = null;
  const { book } = openDocument(doc);
  try {
    metas = tableMetas(book);
    const cache = new Map<number, CellViewJson[]>();
    cellsOf = (id: number) => {
      if (!cache.has(id)) cache.set(id, JSON.parse(book.cells(id)) as CellViewJson[]);
      return cache.get(id)!;
    };
    for (const w of s.watches) {
      if (w.authority !== 'approved') continue;
      const { value, error } = evaluate(doc, w.def);
      const complement = w.def.complement ? evaluate(doc, w.def, w.def.complement) : null;
      const complementValue = complement && !complement.error && typeof complement.value === 'number' ? complement.value : complement ? null : undefined;
      const readTables = tablesReferenced(w.def.formula, metas);
      const period = readTables.map((t) => periodOfTable.get(t)).find(Boolean);
      // freshness: an essential source older than allowed means no conclusion is presented
      let fresh = true;
      if (w.def.freshnessHours && w.def.sources?.length) {
        for (const name of w.def.sources) {
          const src = sources.find((x) => x.name.toLowerCase() === name.toLowerCase());
          if (!src || hoursSince(src.lastChange) > w.def.freshnessHours) fresh = false;
        }
      }
      const prev = w.observations[w.observations.length - 1];
      let breach = false;
      if (!error) {
        if (w.def.kind === 'threshold') breach = typeof value === 'number' && compare(value, w.def.op ?? '>', w.def.value ?? 0);
        else if (w.def.kind === 'check') breach = value === false;
        else if (w.def.kind === 'change') breach = !!prev && prev.def === w.defHash && prev.value !== value;
        else if (w.def.kind === 'worsening') {
          const prevComparable = [...w.observations].reverse().find((o) => o.def === w.defHash && !o.error && typeof o.value === 'number');
          breach = !!prevComparable && typeof value === 'number' && (w.def.bad === 'down' ? value < (prevComparable.value as number) : value > (prevComparable.value as number));
        }
      }
      const novel = !prev || prev.seq !== seq || prev.value !== value || !!prev.error !== !!error || prev.fresh !== fresh || prev.def !== w.defHash || prev.period !== period || prev.complement !== complementValue;
      if (novel) {
        w.observations.push({ at, seq, period, value, complement: complementValue, error, breach, fresh, def: w.defHash });
        changed = true;
      }
      w.lastChecked = at;
      // comparable run: consecutive observations under this definition, newest first
      const comparable = w.observations.filter((o) => o.def === w.defHash);
      let run = 0;
      for (let i = comparable.length - 1; i >= 0 && comparable[i].breach && !comparable[i].error; i--) run++;
      const prevHealth = w.health;
      // a worsening watch needs one more observation than its sustain: the one it worsens from
      const needed = w.def.kind === 'worsening' ? w.def.sustain + 1 : w.def.sustain;
      if (error) {
        w.health = 'error';
      } else if (!fresh) {
        w.health = 'stale';
      } else if (comparable.length < needed) {
        w.health = 'baseline';
      } else if (run >= w.def.sustain) {
        w.health = 'attention';
      } else {
        w.health = 'ok';
      }
      // one issue per watch: opened when the breach is sustained, strengthened or revised while it lasts,
      // resolved after two comparable observations back within bounds
      if (w.health === 'attention') {
        attention++;
        const trail = comparable.slice(-Math.max(needed, 3));
        const evidence = trail.map((o) => `${whenOf(o)}: ${fmt(o.value)}`);
        const before = trail.length > 1 ? trail[trail.length - 2] : undefined;
        const movement = before && typeof before.value === 'number' && typeof value === 'number' && before.value !== value ? ` (was ${fmt(before.value)} on ${whenOf(before)})` : '';
        const summary =
          w.def.kind === 'worsening'
            ? `${w.def.purpose}: ${fmt(value)}${movement} — ${w.def.bad === 'down' ? 'falling' : 'rising'} ${run === 1 ? 'since the last snapshot' : `for ${run} snapshots running`}`
            : w.def.kind === 'check'
              ? `${w.def.purpose}: no longer holds${run > 1 ? ` (${run} snapshots running)` : ''}`
              : `${w.def.purpose}: ${fmt(value)}${movement} — ${ruleText(w.def)}${run > 1 ? `, ${run} snapshots running` : ''}`;
        const uncertainty: string[] = [];
        if (w.def.scope) uncertainty.push(`Scope as defined: ${w.def.scope}`);
        const staleOthers = (w.def.sources ?? []).map((n) => sources.find((x) => x.name.toLowerCase() === n.toLowerCase())).filter((x) => x && x.supply === 'import');
        if (staleOthers.length) uncertainty.push(`${staleOthers.map((x) => x!.name).join(', ')}: manually supplied snapshot${staleOthers.length > 1 ? 's' : ''}; a newer version may exist`);
        const next = w.def.response === 'case' ? 'Open a decision case: investigate and propose options; nothing is changed by the watch itself.' : w.def.response === 'note' ? 'Noted in the activity; no decision requested.' : 'Investigate before the next decision that depends on this figure; the watch changes nothing by itself.';
        if (!w.issue || w.issue.status !== 'open') {
          w.issue = { id: newId(), watch: w.id, openedAt: at, updatedAt: at, status: 'open', revision: 1, summary, evidence, uncertainty, next };
          event(s, { kind: 'issue', text: `Needs attention — ${summary}`, level: 'attention' });
          changed = true;
        } else if (novel) {
          const moved = prev && typeof prev.value === 'number' && typeof value === 'number' ? (w.def.op === '<' || w.def.op === '<=' ? value < prev.value : value > prev.value) : false;
          w.issue.revision++;
          w.issue.updatedAt = at;
          w.issue.summary = summary;
          w.issue.evidence = evidence;
          w.issue.uncertainty = uncertainty;
          w.issue.interpretation = undefined; // the words no longer describe the evidence
          event(s, { kind: 'issue', text: `${moved ? 'Worse again' : 'Still'} — ${summary}`, level: 'attention' });
          changed = true;
        }
      } else if (w.issue && w.issue.status === 'open' && w.health === 'ok') {
        const backWithin = comparable.slice(-2).every((o) => !o.breach && !o.error);
        if (backWithin && comparable.length >= 2) {
          w.issue.status = 'resolved';
          w.issue.resolvedAt = at;
          w.issue.updatedAt = at;
          w.issue.next = `Back within bounds (${fmt(value)}) on two snapshots.`;
          w.history.push(w.issue);
          if (w.history.length > 20) w.history = w.history.slice(-20);
          event(s, { kind: 'issue', text: `Resolved — ${w.def.purpose} is back within bounds (${fmt(value)})`, level: 'watch' });
          w.issue = undefined;
          changed = true;
        }
      }
      const prevComparable = comparable.length > 1 ? comparable[comparable.length - 2] : undefined;
      if (w.health !== prevHealth && !(w.health === 'attention' && prevHealth !== 'attention')) {
        if (w.health === 'stale') event(s, { kind: 'check', text: `Not checked: ${w.def.purpose} — ${(w.def.sources ?? []).join(', ')} older than ${w.def.freshnessHours} h`, level: 'watch' });
        else if (w.health === 'error') event(s, { kind: 'check', text: `Cannot evaluate “${w.def.purpose}”: ${error}`, level: 'watch' });
        else if (w.health === 'baseline' && prevHealth === 'unchecked') event(s, { kind: 'check', text: `${w.def.purpose}: ${fmt(value)} now — watching for the next snapshot before saying more`, level: 'quiet' });
        changed = true;
      } else if (novel && prevComparable && !error && prevComparable.value !== value && w.health !== 'attention') {
        // a movement that is not (yet) an issue is worth a look, in plain words
        const worse = w.def.kind === 'worsening' ? breach : w.def.kind === 'threshold' && typeof value === 'number' && typeof prevComparable.value === 'number' ? (w.def.op === '<' || w.def.op === '<=' ? value < prevComparable.value : value > prevComparable.value) : false;
        const tail = w.health === 'baseline' && breach ? ' — watching for another snapshot before raising it' : '';
        event(s, { kind: 'check', text: `${w.def.purpose}: ${fmt(value)} (was ${fmt(prevComparable.value)} on ${whenOf(prevComparable)})${worse ? ', worse' : ''}${tail}`, level: worse || w.def.kind === 'change' ? 'watch' : 'quiet' });
      } else if (novel && prevComparable && !error && prevComparable.value === value && typeof complementValue === 'number' && typeof prevComparable.complement === 'number' && complementValue !== prevComparable.complement) {
        // the headline is flat but the population the scope leaves out moved: the definition, not the business, is what is quiet
        const worse = w.def.bad === 'down' ? complementValue < prevComparable.complement : complementValue > prevComparable.complement;
        const leftOut = /\(excluding ([^)]+)\)/i.exec(w.def.scope)?.[1] ?? 'the exclusion';
        event(s, { kind: 'check', text: `${w.def.purpose} unchanged at ${fmt(value)} — but what it leaves out (${leftOut}) went ${fmt(prevComparable.complement)} → ${fmt(complementValue)}${worse ? ': the exclusion is carrying the movement; check the definition before concluding that the population is fine' : ''}`, level: worse ? 'watch' : 'quiet' });
        changed = true;
      }
      // the same watch needing attention again and again is a process signal, not a series of surprises
      const times = w.history.length + (w.issue?.status === 'open' ? 1 : 0);
      if (times >= 3 && (w.recurrenceRaised ?? 0) < times && w.issue?.status === 'open') {
        w.recurrenceRaised = times;
        event(s, { kind: 'pattern', text: `“${w.def.purpose}” has needed attention ${times} times across snapshots — worth asking whether the cause is upstream (how it is captured, by whom, when) rather than a one-off; a recurring gap can be a system limit, unclear ownership or timing, not misconduct`, level: 'watch' });
        changed = true;
      }
    }
    // the conditions behind decisions, what was expected, conflicts between sources, assumptions due for review
    if (assessDecisions(s, at)) changed = true;
    if (assessExpectations(s, metas, cellsOf, periodOfTable, sources, at)) changed = true;
    if (crossCheck(s, metas, cellsOf, at)) changed = true;
    if (assessReviews(s)) changed = true;
    attention += s.records.filter((r) => r.kind === 'decision' && LIVE(r) && r.revisit).length;
  } finally {
    book.free();
  }
  void reason;
  saveState(s);
  return { attention, changed, affected };
}

/** A decision's conditions: each tied to a watch holds while the watch is not in attention; a failing one asks for the decision to be revisited. */
function assessDecisions(s: CompanionState, at: string): boolean {
  let changed = false;
  for (const r of s.records) {
    if (r.kind !== 'decision' || !LIVE(r) || !r.conditions?.length) continue;
    let failing: { c: Condition; summary: string } | null = null;
    for (const c of r.conditions) {
      if (!c.watch) continue;
      const w = s.watches.find((x) => x.id === c.watch);
      if (!w || w.authority !== 'approved' || w.health === 'unchecked' || w.health === 'proposed' || w.health === 'error' || w.health === 'stale') {
        c.holds = undefined;
        continue;
      }
      const holds = w.health !== 'attention';
      if (c.holds !== holds) {
        c.holds = holds;
        c.since = at;
        changed = true;
      }
      if (!holds && !failing) failing = { c, summary: w.issue?.summary ?? `${w.def.purpose} no longer within bounds` };
    }
    if (failing && !r.revisit) {
      r.revisit = { at, condition: failing.c.text, summary: failing.summary };
      event(s, { kind: 'decision', text: `Revisit “${short(r.text, 100)}”: the condition “${failing.c.text}” no longer appears to hold — ${failing.summary}`, level: 'attention' });
      changed = true;
    } else if (!failing && r.revisit) {
      r.revisit = undefined;
      event(s, { kind: 'decision', text: `The conditions behind “${short(r.text, 100)}” hold again`, level: 'quiet' });
      changed = true;
    }
  }
  return changed;
}

/** The three situations an expectation can be in, kept apart in words: the evidence arrived; it has not arrived in a source we did check; we could not check. Whether the event happened is the person's to say. */
export function expectationState(r: ContextRecord, metas: TableMetaView[], cellsOf: ((id: number) => CellViewJson[]) | null, periodOfTable: Map<number, string>, sources: SourceStatus[]): { state: 'open' | 'met' | 'missing' | 'unchecked'; text: string } {
  const src = r.source?.trim().toLowerCase();
  const table = src ? metas.find((m) => m.name.toLowerCase() === src) : undefined;
  const period = table ? periodOfTable.get(table.id) : undefined;
  const status = table ? sources.find((x) => x.name === table.name) : undefined;
  const asOf = period ?? (status?.lastChange ? status.lastChange.slice(0, 10) : undefined);
  if (table && r.match && cellsOf) {
    const needle = r.match.toLowerCase();
    const found = cellsOf(table.id).some((c) => c.r >= table.header_rows && c.v && 's' in c.v && c.v.s.toLowerCase().includes(needle));
    if (found) return { state: 'met', text: `Arrived: “${r.match}” is in ${table.name}${asOf ? ` (snapshot ${asOf})` : ''}` };
  }
  const due = r.due;
  if (!due || today() < due) return { state: 'open', text: `Expected${due ? ` by ${due}` : ''}${r.source ? ` in ${r.source}` : ''}` };
  if (!table) return { state: 'unchecked', text: `Not checked: there is no table “${r.source ?? '?'}” to look in — add the source, or say whether it arrived` };
  if (!r.match) return { state: 'unchecked', text: `Not checked: nothing to recognise it by in ${table.name} — set what the evidence row would carry, or say whether it arrived` };
  const reached = periodReaches(period, due) ?? (status?.lastChange ? status.lastChange.slice(0, 10) >= due : null);
  if (reached) return { state: 'missing', text: `No evidence of it in ${table.name} as of ${asOf} (due ${due}): the evidence has not arrived — or the event did not happen, which is yours to say` };
  return { state: 'unchecked', text: `Not checked: ${table.name} has not been refreshed since ${asOf ?? 'its last snapshot'} (due ${due}) — a newer snapshot would tell` };
}

function assessExpectations(s: CompanionState, metas: TableMetaView[], cellsOf: ((id: number) => CellViewJson[]) | null, periodOfTable: Map<number, string>, sources: SourceStatus[], at: string): boolean {
  let changed = false;
  for (const r of s.records) {
    if (r.kind !== 'expectation' || !LIVE(r)) continue;
    if (r.expected && (r.expected.state === 'didnt' || (r.expected.state === 'met' && r.expected.text.includes('said so')))) continue; // the person's word stands
    const next = expectationState(r, metas, cellsOf, periodOfTable, sources);
    if (!r.expected || r.expected.state !== next.state || r.expected.text !== next.text) {
      const was = r.expected?.state;
      r.expected = { ...next, at };
      if (next.state !== 'open' && next.state !== was) event(s, { kind: 'expectation', text: `${short(r.text, 100)} — ${next.text}`, level: next.state === 'missing' ? 'watch' : next.state === 'met' ? 'quiet' : 'watch' });
      changed = true;
    }
  }
  return changed;
}

/** Consequential assumptions carry a review date: past it, they are asked to be reconfirmed, once. */
function assessReviews(s: CompanionState): boolean {
  let changed = false;
  const t = today();
  for (const r of s.records) {
    if (!LIVE(r) || !r.reviewBy || r.reviewRaised || r.reviewBy > t) continue;
    r.reviewRaised = true;
    event(s, { kind: 'assumption', text: `Reconfirm “${short(r.text, 100)}” — set ${r.arrivedAt.slice(0, 10)}, review by ${r.reviewBy}; the circumstances it was made under may have changed`, level: 'watch' });
    changed = true;
  }
  return changed;
}

// ------------------------------------------------------------------ conflicts between sources
const ID_HEADER = /\b(vin|id|ref|reference|chassis|invoice|factura|fatura|cheque|no\.?|number|code|c[oó]digo|matr[ií]cula|plate)\b/i;
const normHeader = (h: string) => h.trim().toLowerCase().replace(/\s+/g, ' ');

interface Column {
  index: number;
  header: string;
  key: string;
}
function columnsOf(cells: CellViewJson[], t: TableMetaView): Column[] {
  const out: Column[] = [];
  for (const c of cells) {
    if (c.r !== t.header_rows - 1 || !c.v || !('s' in c.v) || !c.v.s.trim()) continue;
    out.push({ index: c.c, header: c.v.s.trim(), key: normHeader(c.v.s) });
  }
  return out;
}

/** Two tables that both carry an identifier and a figure under the same header should agree row by row; where they do not, the conflict is kept, with what depends on it. */
function crossCheck(s: CompanionState, metas: TableMetaView[], cellsOf: ((id: number) => CellViewJson[]) | null, at: string): boolean {
  if (!cellsOf) return false;
  const tables = metas.filter((t) => !t.pivot && t.header_rows >= 1 && t.rows - t.header_rows >= 1);
  if (tables.length < 2) return false;
  const seen = new Set<string>();
  let changed = false;
  const watchesReading = (header: string, names: string[]) => s.watches.filter((w) => names.some((n) => w.def.formula.toLowerCase().includes(`${n.toLowerCase()}[${header.toLowerCase()}]`) || w.def.formula.toLowerCase().includes(`'${n.toLowerCase()}'[${header.toLowerCase()}]`))).map((w) => w.def.purpose);
  for (let i = 0; i < tables.length; i++) {
    for (let j = i + 1; j < tables.length; j++) {
      const a = tables[i];
      const b = tables[j];
      const ca = columnsOf(cellsOf(a.id), a);
      const cb = columnsOf(cellsOf(b.id), b);
      const idA = ca.find((c) => ID_HEADER.test(c.header) && cb.some((d) => d.key === c.key));
      if (!idA) continue;
      const idB = cb.find((d) => d.key === idA.key)!;
      const shared = ca.filter((c) => c.key !== idA.key && cb.some((d) => d.key === c.key));
      if (!shared.length) continue;
      const rowsOf = (t: TableMetaView, idCol: number, valCol: number) => {
        const m = new Map<string, number>();
        const byRow = new Map<number, { id?: string; v?: number }>();
        for (const c of cellsOf(t.id)) {
          if (c.r < t.header_rows) continue;
          const e = byRow.get(c.r) ?? {};
          if (c.c === idCol && c.v && 's' in c.v) e.id = c.v.s.trim().toLowerCase();
          if (c.c === idCol && c.v && 'n' in c.v) e.id = String(c.v.n);
          if (c.c === valCol && c.v && 'n' in c.v) e.v = c.v.n;
          byRow.set(c.r, e);
        }
        for (const e of byRow.values()) if (e.id && typeof e.v === 'number' && !m.has(e.id)) m.set(e.id, e.v);
        return m;
      };
      for (const col of shared) {
        const other = cb.find((d) => d.key === col.key)!;
        const ra = rowsOf(a, idA.index, col.index);
        const rb = rowsOf(b, idB.index, other.index);
        let n = 0;
        for (const [id, va] of ra) {
          const vb = rb.get(id);
          if (vb === undefined) continue;
          const key = `conflict:${a.id}:${b.id}:${col.key}:${id}`;
          seen.add(key);
          const differs = Math.abs(va - vb) > Math.max(0.005 * Math.max(Math.abs(va), Math.abs(vb)), 1e-9);
          const existing = s.records.find((r) => r.key === key);
          if (differs) {
            if (n++ >= 20) break;
            if (existing && LIVE(existing)) continue;
            if (existing && existing.status === 'resolved' && existing.resolution && !existing.resolution.startsWith('the sources now agree')) continue; // settled by a person: the difference is known
            const depends = watchesReading(col.header, [a.name, b.name]);
            const bearing = depends.length ? `bears on: ${depends.join(', ')}` : `any figure built on ${col.header}`;
            const r: ContextRecord = { id: newId(), kind: 'contradiction', text: `${col.header} of ${id.toUpperCase()}: ${a.name} says ${fmt(va)}, ${b.name} says ${fmt(vb)}`, source: `${a.name} ↔ ${b.name}`, arrivedAt: at, by: { id: 'companion', name: 'the companion' }, origin: 'system', status: 'observed', links: [{ table: a.id }, { table: b.id }], bearing, key };
            s.records.push(r);
            event(s, { kind: 'conflict', text: `Sources disagree — ${r.text}; ${bearing}. Both are kept until one is confirmed`, level: 'watch' });
            changed = true;
          } else if (existing && LIVE(existing)) {
            existing.status = 'resolved';
            existing.resolution = 'the sources now agree';
            event(s, { kind: 'conflict', text: `Sources agree again — ${short(existing.text, 120)}`, level: 'quiet' });
            changed = true;
          }
        }
      }
    }
  }
  // a conflict whose row or column disappeared is no longer observable: resolved as such
  for (const r of s.records) {
    if (r.kind === 'contradiction' && r.origin === 'system' && LIVE(r) && r.key && !seen.has(r.key)) {
      r.status = 'resolved';
      r.resolution = 'no longer observable (a source or a row changed)';
      changed = true;
    }
  }
  return changed;
}

// ------------------------------------------------------------------ suggestions
// The companion proposes what to watch from the columns themselves, in plain words: a days or
// date column means ageing, a yes/no column an exclusion, an identifier column duplicates, an
// amount column blanks and a total. Formulas are generated; nobody has to write one.
export interface Suggestion {
  id: string;
  purpose: string;
  why: string;
  def: WatchDef;
}

interface ColumnProfile {
  index: number;
  header: string;
  n: number;
  blanks: number;
  numbers: number;
  unique: number;
  yesNo: number;
  dates: number;
  max: number;
}

const q = (name: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`);
const col = (table: string, header: string) => `${q(table)}[${header}]`;

function profileTable(cells: CellViewJson[], t: TableMetaView): ColumnProfile[] {
  const out: ColumnProfile[] = [];
  const byCol = new Map<number, CellViewJson[]>();
  for (const c of cells) {
    if (c.r < t.header_rows) continue;
    if (!byCol.has(c.c)) byCol.set(c.c, []);
    byCol.get(c.c)!.push(c);
  }
  const headerOf = (c: number) => {
    const h = cells.find((x) => x.r === t.header_rows - 1 && x.c === c);
    return h && h.v && 's' in h.v ? h.v.s.trim() : '';
  };
  const dataRows = Math.max(0, t.rows - t.header_rows);
  for (let c = 0; c < t.cols; c++) {
    const header = headerOf(c);
    if (!header) continue;
    const vals = byCol.get(c) ?? [];
    const prof: ColumnProfile = { index: c, header, n: dataRows, blanks: 0, numbers: 0, unique: 0, yesNo: 0, dates: 0, max: 0 };
    const seen = new Set<string>();
    let filled = 0;
    for (const v of vals) {
      if (!v.v || ('s' in v.v && !v.v.s.trim())) continue;
      filled++;
      const key = 'n' in v.v ? String(v.v.n) : 's' in v.v ? v.v.s.trim().toLowerCase() : JSON.stringify(v.v);
      seen.add(key);
      if ('n' in v.v) {
        prof.numbers++;
        prof.max = Math.max(prof.max, v.v.n);
        if (v.f?.number_format && /[dmy]/i.test(v.f.number_format) && !/[#0]/.test(v.f.number_format)) prof.dates++;
      } else if ('s' in v.v) {
        if (/^(yes|no|y|n|sim|não|nao|true|false)$/i.test(v.v.s.trim())) prof.yesNo++;
        if (/^\d{4}-\d{2}-\d{2}/.test(v.v.s.trim())) prof.dates++;
      } else if ('b' in v.v) prof.yesNo++;
    }
    prof.blanks = dataRows - filled;
    prof.unique = seen.size;
    out.push(prof);
  }
  return out;
}

export function suggestWatches(doc: string, includeDismissed = false): Suggestion[] {
  if (!engineAvailable() || !readFile(doc)) return [];
  const s = loadState(doc);
  const have = new Set(s.watches.map((w) => w.def.formula.replace(/\s+/g, '')));
  const periods = periodsOf(s);
  const latestPeriod = [...periods.values()].sort().pop();
  const dismissed = new Map((s.dismissed ?? []).map((d) => [d.id, d]));
  const out: Suggestion[] = [];
  const add = (id: string, purpose: string, why: string, def: Partial<WatchDef>) => {
    const d = normaliseDef({ sustain: 2, response: 'brief', ...def, purpose });
    if (have.has(d.formula.replace(/\s+/g, ''))) return;
    const dm = dismissed.get(id);
    // "not now" comes back with the next snapshot; "not relevant" and "incorrect" stay aside until brought back
    if (dm && !includeDismissed && (dm.reason !== 'not now' || !latestPeriod || dm.period === latestPeriod || !dm.period)) return;
    out.push({ id, purpose, why, def: d });
  };
  const { book } = openDocument(doc);
  try {
    for (const t of tableMetas(book)) {
      if (t.pivot || t.header_rows < 1 || t.rows - t.header_rows < 2) continue;
      const cells = JSON.parse(book.cells(t.id)) as CellViewJson[];
      const cols = profileTable(cells, t);
      const dataRows = t.rows - t.header_rows;
      const mostly = (p: ColumnProfile, k: keyof ColumnProfile) => (p[k] as number) >= Math.max(1, (dataRows - p.blanks) * 0.8);
      const flag = cols.find((p) => mostly(p, 'yesNo') && /reserv|hold|sold|exclu|vendid|block/i.test(p.header)) ?? cols.find((p) => mostly(p, 'yesNo'));
      const flagText = flag ? ` (excluding ${flag.header} = yes)` : '';
      const flagCond = flag ? `, ${col(t.name, flag.header)}, "no"` : '';
      const flagYes = flag ? `, ${col(t.name, flag.header)}, "yes"` : '';
      const rowWord = /vehic|viatur|carro|stock|invent/i.test(t.name) ? 'vehicles' : 'rows';
      const prefix = tableMetas(book).filter((m) => !m.pivot && m.header_rows >= 1 && m.rows - m.header_rows >= 2).length > 1 ? `${t.name}: ` : '';
      const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
      // a row exists when its key column is filled: spare empty rows at the foot of a table are not "missing" anything
      const keyCol = cols.find((p) => !mostly(p, 'numbers') && p.unique >= Math.max(2, (dataRows - p.blanks) * 0.7)) ?? cols[0];
      const present = keyCol ? `, ${col(t.name, keyCol.header)}, "<>"` : '';
      for (const p of cols) {
        const h = p.header;
        if (mostly(p, 'numbers') && /\b(days?|age|ageing|aging|dias|idade)\b/i.test(h) && p.max > 30) {
          const limit = p.max >= 90 ? 90 : 30;
          add(`${t.id}:${p.index}:age`, cap(`${prefix}${rowWord} over ${limit} ${/dias/i.test(h) ? 'dias' : 'days'}${flag ? ' (excl. reserved)' : ''}`), `“${h}” reads like days in stock; ageing beyond ${limit} days usually needs a decision${flag ? `; ${flag.header} = yes is left out, and watched alongside so the exclusion cannot hide a movement` : ''}`, { formula: flag ? `=COUNTIFS(${col(t.name, h)}, ">${limit}"${flagCond})` : `=COUNTIF(${col(t.name, h)}, ">${limit}")`, complement: flag ? `=COUNTIFS(${col(t.name, h)}, ">${limit}"${flagYes})` : undefined, kind: 'worsening', bad: 'up', scope: `${t.name}${flagText}`, sources: [t.name] });
        } else if (mostly(p, 'dates') && /date|data|entr|receiv|arriv|in\b/i.test(h)) {
          add(`${t.id}:${p.index}:since`, cap(`${prefix}${rowWord} older than 90 days${flag ? ' (excl. reserved)' : ''}`), `“${h}” is a date; counting what is older than 90 days from today${flag ? `; ${flag.header} = yes is left out` : ''}`, { formula: flag ? `=COUNTIFS(${col(t.name, h)}, "<"&(TODAY()-90)${flagCond})` : `=COUNTIF(${col(t.name, h)}, "<"&(TODAY()-90))`, complement: flag ? `=COUNTIFS(${col(t.name, h)}, "<"&(TODAY()-90)${flagYes})` : undefined, kind: 'worsening', bad: 'up', scope: `${t.name}${flagText}`, sources: [t.name] });
        }
        if (mostly(p, 'numbers') && !mostly(p, 'dates') && /cost|amount|value|price|total|valor|custo|montante|pre[cç]o|margin|margem|landed|cif|fob/i.test(h) && !/days|dias/i.test(h)) {
          add(`${t.id}:${p.index}:blank`, cap(`${prefix}${rowWord} with no ${h.toLowerCase()}`), `a missing ${h.toLowerCase()} makes a margin or a total provisional`, { formula: `=COUNTIFS(${col(t.name, h)}, ""${present})`, kind: 'threshold', op: '>', value: 0, sustain: 1, scope: t.name, sources: [t.name] });
          add(`${t.id}:${p.index}:total`, cap(`${prefix}total ${h.toLowerCase()}`), `the total moves when a snapshot changes; a movement is worth a look, not an alarm`, { formula: `=SUM(${col(t.name, h)})`, kind: 'change', sustain: 1, scope: t.name, sources: [t.name] });
        }
        if (!mostly(p, 'numbers') && ID_HEADER.test(h) && p.unique >= Math.max(2, (dataRows - p.blanks) * 0.7)) {
          add(`${t.id}:${p.index}:dup`, cap(`${prefix}duplicate ${h}${/s$/i.test(h) ? '' : 's'}`), `“${h}” looks like an identifier; a duplicate is usually a posting error`, { formula: `=COUNTA(${col(t.name, h)}) - COUNTUNIQUE(${col(t.name, h)})`, kind: 'threshold', op: '>', value: 0, sustain: 1, scope: t.name, sources: [t.name] });
        }
      }
    }
  } finally {
    book.free();
  }
  const rank = (x: Suggestion) => (x.id.endsWith(':age') || x.id.endsWith(':since') ? 0 : x.id.endsWith(':blank') ? 1 : x.id.endsWith(':dup') ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b)).slice(0, 8);
}

/** Set a suggestion aside with a reason: "not now" returns with the next snapshot; the others wait to be brought back. Reviewable, so that silence is never unexamined. */
export function dismissSuggestion(doc: string, by: Author, input: { id: string; purpose?: string; reason?: string }): Dismissed {
  const s = loadState(doc);
  const id = String(input.id ?? '').slice(0, 80);
  if (!id) throw new Error('id required');
  const reason: Dismissed['reason'] = input.reason === 'not relevant' || input.reason === 'incorrect' ? input.reason : 'not now';
  const latestPeriod = [...periodsOf(s).values()].sort().pop();
  s.dismissed = (s.dismissed ?? []).filter((d) => d.id !== id);
  const d: Dismissed = { id, purpose: String(input.purpose ?? id).slice(0, 300), reason, at: now(), by: who(by), period: latestPeriod };
  s.dismissed.push(d);
  event(s, { kind: 'trace', text: `Set aside “${d.purpose}” — ${reason}`, by: who(by), level: 'quiet' });
  saveState(s);
  return d;
}
export function restoreSuggestion(doc: string, by: Author, id: string): boolean {
  const s = loadState(doc);
  const before = (s.dismissed ?? []).length;
  s.dismissed = (s.dismissed ?? []).filter((d) => d.id !== id);
  if (s.dismissed.length !== before) {
    event(s, { kind: 'trace', text: `Brought back a suggestion that was set aside`, by: who(by), level: 'quiet' });
    saveState(s);
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ the understanding
/** What we are working toward, what we rest on, what stands, what is uncertain (ranked by what it bears on), and the one next move. */
export function understandingOf(doc: string, s = loadState(doc)): Understanding {
  const live = s.records.filter(LIVE);
  const objective = [...live].reverse().find((r) => r.kind === 'objective' && r.status !== 'proposed');
  const constraints = live.filter((r) => r.kind === 'constraint' && r.status !== 'proposed');
  const exclusions = live.filter((r) => r.kind === 'exclusion' && r.status !== 'proposed');
  const sources = sourceStatus(doc);
  const periodOfTable = periodsOf(s);
  let metas: TableMetaView[] = [];
  let cellsOf: ((id: number) => CellViewJson[]) | null = null;
  let book: ReturnType<typeof openDocument>['book'] | null = null;
  if (engineAvailable() && readFile(doc)) {
    try {
      book = openDocument(doc).book;
      metas = tableMetas(book);
      const b = book;
      const cache = new Map<number, CellViewJson[]>();
      cellsOf = (id: number) => {
        if (!cache.has(id)) cache.set(id, JSON.parse(b.cells(id)) as CellViewJson[]);
        return cache.get(id)!;
      };
    } catch {
      book = null;
    }
  }
  try {
    const derivativeTables = new Set<number>();
    for (const r of live) if (r.kind === 'source' && r.derivative) for (const l of r.links ?? []) if (typeof l.table === 'number') derivativeTables.add(l.table);
    const coverage = metas.map((t) => {
      const st = sources.find((x) => x.name === t.name);
      return { name: t.name, period: periodOfTable.get(t.id), rows: Math.max(0, t.rows - t.header_rows), supply: st?.supply ?? ('unknown' as const), lastChange: st?.lastChange, derivative: derivativeTables.has(t.id) || undefined };
    });
    const decisions = live
      .filter((r) => r.kind === 'decision' && !r.key?.startsWith('rejected:'))
      .map((r) => ({ record: r, conditions: (r.conditions ?? []).map((c) => ({ ...c, purpose: c.watch ? s.watches.find((w) => w.id === c.watch)?.def.purpose : undefined })), revisit: r.revisit }));
    const expectations = live.filter((r) => r.kind === 'expectation');
    const uncertain: Uncertainty[] = [];
    for (const r of live) {
      if (r.kind === 'question') uncertain.push({ kind: 'question', text: r.text, bearing: r.bearing, record: r.id, rank: r.bearing ? 1 : 3 });
      else if (r.kind === 'contradiction') uncertain.push({ kind: 'contradiction', text: r.text, bearing: r.bearing, record: r.id, rank: r.status === 'proposed' ? 3 : 1 }); // a kept conflict is material until someone settles it
      else if (r.kind === 'expectation') {
        const st = r.expected?.state ?? (r.due && today() >= r.due ? 'unchecked' : 'open');
        if (st === 'missing') uncertain.push({ kind: 'expectation', text: `${r.text} — ${r.expected?.text ?? 'no evidence yet'}`, bearing: r.bearing, record: r.id, rank: r.bearing ? 0 : 2 });
        else if (st === 'unchecked') uncertain.push({ kind: 'expectation', text: `${r.text} — ${r.expected?.text ?? 'not checked yet'}`, bearing: r.bearing, record: r.id, rank: 4 });
      } else if (r.kind === 'hypothesis' && r.status !== 'confirmed') uncertain.push({ kind: 'hypothesis', text: r.text, bearing: r.bearing, record: r.id, rank: r.bearing ? 2 : 5 });
      if (r.reviewBy && r.reviewBy <= today() && r.kind !== 'expectation') uncertain.push({ kind: 'review', text: `${r.kind} “${short(r.text, 100)}” is due for reconfirmation (review by ${r.reviewBy})`, record: r.id, rank: 3 });
      if (r.status === 'proposed') uncertain.push({ kind: 'proposed', text: `${r.kind} proposed by ${who(r.by)}: ${short(r.text, 120)} — confirm or retire`, record: r.id, rank: 6 });
    }
    for (const w of s.watches) {
      if (w.issue?.status === 'open' && /with no |blank|missing|sem /i.test(w.def.purpose)) uncertain.push({ kind: 'provisional', text: `${w.issue.summary} — any margin or total built on that column is provisional`, watch: w.id, rank: 4 });
      if (w.health === 'stale') uncertain.push({ kind: 'stale', text: `“${w.def.purpose}” is not checked: ${(w.def.sources ?? []).join(', ')} not refreshed within ${w.def.freshnessHours} h`, watch: w.id, rank: 4 });
    }
    uncertain.sort((a, b) => a.rank - b.rank);
    const revisit = decisions.find((d) => d.revisit);
    const issues = s.watches.filter((w) => w.issue?.status === 'open');
    const attention = issues.length + decisions.filter((d) => d.revisit).length;
    const since = s.seenAt ? Date.parse(s.seenAt) : 0;
    const worthALook = s.events.some((e) => e.level === 'watch' && Date.parse(e.at) > since);
    const material = uncertain.find((u) => u.rank <= 2);
    let stance: Stance;
    let lead: string;
    let next: string;
    if (revisit) {
      stance = 'decision';
      lead = 'A decision needs another look';
      next = `Revisit “${short(revisit.record.text, 80)}”: the condition “${revisit.revisit!.condition}” no longer appears to hold — ${revisit.revisit!.summary}.`;
    } else if (issues.length) {
      stance = 'decision';
      lead = `${issues.length} need${issues.length === 1 ? 's' : ''} attention`;
      next = issues[0].issue!.next;
    } else if (material) {
      stance = 'question';
      lead = material.kind === 'expectation' ? 'Something expected has not arrived' : material.kind === 'contradiction' ? 'Two sources disagree' : 'One question could change the decision';
      next = material.kind === 'expectation' ? `Chase it: ${material.text}` : material.kind === 'contradiction' ? `Settle which source is right — ${material.text}${material.bearing ? ` (${material.bearing})` : ''}.` : `Resolve first: ${material.text}${material.bearing ? ` — ${material.bearing}` : ''}.`;
    } else if (worthALook) {
      stance = 'observation';
      lead = 'Worth a look';
      const last = [...s.events].reverse().find((e) => e.level === 'watch' && Date.parse(e.at) > since);
      next = `Nothing to decide — worth a look: ${last ? short(last.text.replace(/\s+—.*$/, ''), 120) : 'a movement'}.`;
    } else {
      stance = 'quiet';
      lead = 'All quiet';
      next = !objective ? 'Say what matters (Objective: …) — the companion can then rank what to resolve next.' : uncertain.length ? `Nothing to decide; when convenient: ${short(uncertain[0].text, 120)}.` : 'Nothing to decide.';
    }
    const parts: string[] = [];
    parts.push(objective ? `Working toward: ${objective.text}` : 'No objective stated yet — the companion is reading the material without knowing what it is for');
    if (constraints.length) parts.push(`Within: ${constraints.map((c) => c.text).join('; ')}`);
    if (exclusions.length) parts.push(`Leaving out: ${exclusions.map((c) => c.text).join('; ')}`);
    const cov = coverage.filter((c) => c.rows > 0);
    parts.push(cov.length ? `Based on these records: ${cov.map((c) => `${c.name} (${c.period ? `snapshot ${c.period}, ` : ''}${c.rows} row${c.rows === 1 ? '' : 's'}${c.supply === 'import' ? ', manually supplied' : c.supply === 'live' ? ', live' : ''}${c.derivative ? ', generated — not independent evidence' : ''})`).join(', ')} — not the complete position` : 'Based on nothing yet: add a file or a table');
    if (decisions.length) parts.push(`${decisions.length} decision${decisions.length === 1 ? '' : 's'} standing${decisions.some((d) => d.revisit) ? ', one to revisit' : decisions.some((d) => d.conditions.length) ? ', conditions watched' : ''}`);
    if (uncertain.length) parts.push(`${uncertain.length} open uncertaint${uncertain.length === 1 ? 'y' : 'ies'}, first: ${short(uncertain[0].text, 100)}`);
    const statement = parts.join('. ') + '.';
    const investigations = (s.investigations ?? []).map((i) => ({ ...i, stale: i.status === 'done' && i.assumptionsSeq !== (s.assumptionsSeq ?? 0) ? true : undefined }));
    return { objective, constraints, exclusions, coverage, decisions, expectations, uncertain, stance, lead, next, statement, attention, assumptionsSeq: s.assumptionsSeq ?? 0, investigations };
  } finally {
    book?.free();
  }
}

// ------------------------------------------------------------------ brief
export function brief(doc: string): Brief {
  const s = loadState(doc);
  const sources = sourceStatus(doc);
  const u = understandingOf(doc, s);
  const since = s.seenAt ? Date.parse(s.seenAt) : 0;
  const recent = s.events.filter((e) => Date.parse(e.at) > since);
  const changed = recent
    .filter((e) => e.level !== 'attention' && e.kind !== 'trace')
    .map((e) => e.text)
    .filter((t, i, arr) => arr.lastIndexOf(t) === i)
    .slice(-8);
  const matters: string[] = [];
  const next: string[] = [];
  const health: Brief['health'] = { ok: 0, baseline: 0, attention: 0, stale: 0, error: 0, unchecked: 0, proposed: 0 };
  // a decision to revisit names the issue behind it: that issue is not listed a second time
  const named = new Set<string>();
  for (const d of u.decisions) {
    if (!d.revisit) continue;
    matters.push(`Revisit “${short(d.record.text, 100)}”: the condition “${d.revisit.condition}” no longer appears to hold — ${d.revisit.summary}`);
    for (const c of d.conditions) if (c.holds === false && c.watch) named.add(c.watch);
  }
  for (const w of s.watches) {
    health[w.health]++;
    if (w.lastChecked && (!health.checked || w.lastChecked > health.checked)) health.checked = w.lastChecked;
    if (w.issue?.status === 'open') {
      if (!named.has(w.id)) matters.push(w.issue.summary);
      next.push(w.issue.next);
    } else if (w.health === 'stale') {
      matters.push(`Not checked: “${w.def.purpose}” — ${(w.def.sources ?? []).join(', ')} not refreshed within ${w.def.freshnessHours} h`);
      next.push(`Refresh ${(w.def.sources ?? []).join(', ')} before relying on “${w.def.purpose}”.`);
    } else if (w.health === 'error') {
      const last = w.observations[w.observations.length - 1];
      matters.push(`Cannot evaluate “${w.def.purpose}”: ${last?.error ?? 'error'}`);
      next.push(`Fix the formula of “${w.def.purpose}”.`);
    }
  }
  health.attention += u.decisions.filter((d) => d.revisit).length;
  for (const m of u.uncertain.filter((x) => x.rank <= 2).slice(0, 3)) matters.push(m.kind === 'expectation' ? m.text : `${m.kind === 'contradiction' ? 'Sources disagree: ' : m.kind === 'question' ? 'Open question: ' : ''}${m.text}${m.bearing ? ` — ${m.bearing}` : ''}`);
  if (u.next && !next.includes(u.next)) next.unshift(u.next);
  const proposedRecords = s.records.filter((r) => r.status === 'proposed');
  const proposedWatches = s.watches.filter((w) => w.authority === 'proposed');
  if (proposedWatches.length) next.push(`${proposedWatches.length} proposed watch${proposedWatches.length === 1 ? '' : 'es'} await${proposedWatches.length === 1 ? 's' : ''} your approval.`);
  if (proposedRecords.length) next.push(`${proposedRecords.length} context item${proposedRecords.length === 1 ? '' : 's'} proposed by an agent await${proposedRecords.length === 1 ? 's' : ''} confirmation.`);
  const stale = u.investigations.filter((i) => i.stale).length;
  if (stale) next.push(`${stale} investigation${stale === 1 ? '' : 's'} made under earlier assumptions — re-run before relying on ${stale === 1 ? 'it' : 'them'}.`);
  const baseline = s.watches.filter((w) => w.health === 'baseline');
  if (baseline.length && !matters.length) matters.push(`${baseline.length} watch${baseline.length === 1 ? '' : 'es'} still building a baseline — no conclusion yet, which is a valid state.`);
  if (!matters.length) {
    const approved = s.watches.filter((w) => w.authority === 'approved').length;
    matters.push(approved ? (health.checked ? `No material issues detected (${approved} watch${approved === 1 ? '' : 'es'} checked ${health.checked.slice(0, 16).replace('T', ' ')}).` : `${approved} watch${approved === 1 ? '' : 'es'} not checked yet.`) : 'Nothing is being watched yet.');
  }
  if (!next.length) next.push(s.watches.length ? 'Nothing to decide.' : 'Tell the companion what matters (Objective: …, Exclude: …) and what to watch.');
  return { changed, matters, next: next.filter((t, i, arr) => arr.indexOf(t) === i), health, sources, stance: u.stance, lead: u.lead, statement: u.statement };
}

export function markSeen(doc: string) {
  const s = loadState(doc);
  s.seenAt = now();
  saveState(s);
}

// ------------------------------------------------------------------ the graph
// The tables are the nodes. Edges are read off the workbook itself (formulas, pivots, SQL cells,
// imports) and off the context (what a record is about, what a watch reads, what an objective
// constrains, what a decision depends on); nobody has to draw them. A change to one node names the
// nodes to reassess.
export type NodeType = 'table' | 'source' | 'watch' | 'issue' | RecordKind;
export type EdgeType = 'derived_from' | 'fed_by' | 'about' | 'watches' | 'constrains' | 'excludes' | 'raises' | 'supersedes' | 'depends_on';
export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  /** table id for table nodes */
  table?: number;
  status?: string;
  health?: Health;
  supply?: SourceStatus['supply'];
  lastChange?: string;
  rows?: number;
  period?: string;
}
export interface GraphEdge {
  from: string;
  to: string;
  type: EdgeType;
  /** how the edge was found: formula, pivot, sql, import, link, mention, case, condition */
  via: string;
}
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Names of the tables a text refers to (`Sales::B2`, `'Table 1'::A1`, `Sales[Amount]`, or the bare name as a word). */
function tablesMentioned(text: string, metas: TableMetaView[]): number[] {
  const out = new Set<number>();
  if (!text) return [];
  for (const t of metas) {
    const n = t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:'${n}'|\\b${n})\\s*(?:::|\\[|!)`, 'i').test(text) || new RegExp(`(^|[^\\w])${n}([^\\w]|$)`, 'i').test(text)) out.add(t.id);
  }
  return [...out];
}
/** Tables referenced by formulas only (a strict form for watches and derived tables). */
function tablesReferenced(formula: string, metas: TableMetaView[]): number[] {
  const out = new Set<number>();
  for (const t of metas) {
    const n = t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:'${n}'|\\b${n})\\s*(?:::|\\[|!)`, 'i').test(formula)) out.add(t.id);
  }
  return [...out];
}

export function graphOf(doc: string): Graph {
  const s = loadState(doc);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const edge = (from: string, to: string, type: EdgeType, via: string) => {
    const k = `${from}>${to}>${type}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push({ from, to, type, via });
  };
  if (!engineAvailable() || !readFile(doc)) return { nodes, edges };
  const sources = sourceStatus(doc);
  const conns = new Map(listConnections().map((c) => [c.id, c.name]));
  const { book } = openDocument(doc);
  let metas: TableMetaView[] = [];
  try {
    metas = tableMetas(book);
    for (const t of metas) {
      const src = sources.find((x) => x.name === t.name);
      nodes.push({ id: `table:${t.id}`, type: 'table', label: t.name, table: t.id, supply: src?.supply, lastChange: src?.lastChange, rows: t.rows });
    }
    for (const t of metas) {
      const cells = JSON.parse(book.cells(t.id)) as (CellViewJson & { conn?: string })[];
      const refs = new Set<number>();
      for (const c of cells) {
        if (c.k === 'sql' && c.conn) {
          const id = `source:connection:${c.conn}`;
          if (!nodes.some((n) => n.id === id)) nodes.push({ id, type: 'source', label: conns.get(c.conn) ?? c.conn, supply: 'live' });
          edge(`table:${t.id}`, id, 'fed_by', 'sql');
        }
        if (c.i && (c.i.startsWith('=') || c.k === 'python' || c.k === 'javascript')) for (const id of tablesReferenced(c.i, metas)) if (id !== t.id) refs.add(id);
      }
      for (const id of refs) edge(`table:${t.id}`, `table:${id}`, 'derived_from', 'formula');
      const pivot = t.pivot as { source?: number } | undefined;
      if (pivot && typeof pivot.source === 'number') edge(`table:${t.id}`, `table:${pivot.source}`, 'derived_from', 'pivot');
    }
  } finally {
    book.free();
  }
  // context records: sources feed tables, the rest are about tables (by link or by mention)
  for (const r of s.records) {
    if (r.status === 'retired') continue;
    const id = r.kind === 'source' ? `source:${r.id}` : `record:${r.id}`;
    nodes.push({ id, type: r.kind, label: r.text.slice(0, 120), status: r.status, period: r.period, lastChange: r.arrivedAt });
    const linked = new Set<number>((r.links ?? []).map((l) => l.table).filter((t): t is number => typeof t === 'number'));
    const mentioned = tablesMentioned(r.text, metas);
    for (const t of linked) edge(r.kind === 'source' ? `table:${t}` : id, r.kind === 'source' ? id : `table:${t}`, r.kind === 'source' ? 'fed_by' : r.kind === 'exclusion' ? 'excludes' : 'about', 'link');
    for (const t of mentioned) if (!linked.has(t)) edge(r.kind === 'source' ? `table:${t}` : id, r.kind === 'source' ? id : `table:${t}`, r.kind === 'source' ? 'fed_by' : r.kind === 'exclusion' ? 'excludes' : 'about', 'mention');
    if (r.kind === 'source' && r.supersededBy) edge(`source:${r.supersededBy}`, id, 'supersedes', 'source');
    // a decision depends on the watches that stand for its conditions
    for (const c of r.conditions ?? []) if (c.watch && s.watches.some((w) => w.id === c.watch)) edge(id, `watch:${c.watch}`, 'depends_on', 'condition');
  }
  // watches read tables; stated objectives constrain every approved watch of the case; issues hang off watches
  const objectives = s.records.filter((r) => r.kind === 'objective' && (r.status === 'stated' || r.status === 'confirmed'));
  for (const w of s.watches) {
    const id = `watch:${w.id}`;
    nodes.push({ id, type: 'watch', label: w.def.purpose, health: w.health, status: w.authority, lastChange: w.lastChecked });
    const read = new Set(tablesReferenced(w.def.formula, metas));
    const ctx = w.def.table ? metas.find((m) => m.name.toLowerCase() === w.def.table!.toLowerCase()) : undefined;
    if (ctx && !tablesReferenced(w.def.formula, metas).length) read.add(ctx.id);
    for (const t of read) edge(id, `table:${t}`, 'watches', 'formula');
    if (w.authority === 'approved') for (const o of objectives) edge(`record:${o.id}`, id, 'constrains', 'case');
    if (w.issue?.status === 'open') {
      nodes.push({ id: `issue:${w.issue.id}`, type: 'issue', label: w.issue.summary, status: w.issue.status, lastChange: w.issue.updatedAt });
      edge(id, `issue:${w.issue.id}`, 'raises', 'check');
    }
  }
  return { nodes, edges };
}

/** Nodes to reassess when the given nodes change: everything that reads them, transitively, plus what is about them. */
export function affectedBy(g: Graph, changed: string[]): { nodes: string[]; watches: string[]; records: string[]; tables: string[] } {
  const reads = new Map<string, Set<string>>(); // target -> nodes that depend on it
  for (const e of g.edges) {
    if (e.type === 'derived_from' || e.type === 'watches' || e.type === 'about' || e.type === 'excludes' || e.type === 'raises' || e.type === 'depends_on') {
      // derived_from / watches / about / excludes / depends_on: from depends on to; raises: issue depends on watch
      const dep = e.type === 'raises' ? e.to : e.from;
      const on = e.type === 'raises' ? e.from : e.to;
      if (!reads.has(on)) reads.set(on, new Set());
      reads.get(on)!.add(dep);
    }
  }
  const out = new Set<string>();
  const stack = [...changed];
  while (stack.length) {
    const n = stack.pop()!;
    for (const d of reads.get(n) ?? []) {
      if (!out.has(d)) {
        out.add(d);
        stack.push(d);
      }
    }
  }
  const nodes = [...out];
  return { nodes, watches: nodes.filter((n) => n.startsWith('watch:')).map((n) => n.slice(6)), records: nodes.filter((n) => n.startsWith('record:')).map((n) => n.slice(7)), tables: nodes.filter((n) => n.startsWith('table:')).map((n) => n.slice(6)) };
}

// ------------------------------------------------------------------ scheduling
const timers = new Map<string, NodeJS.Timeout>();
let notify: ((doc: string, payload: { attention: number }) => void) | null = null;
export function setCompanionNotifier(fn: typeof notify) {
  notify = fn;
}

const pendingTables = new Map<string, Set<number>>();
/** Re-check a document shortly after it changed (debounced: a burst of edits is one check). */
export function scheduleCheck(doc: string, table?: number, delayMs = 1500) {
  if (!hasCompanion(doc)) return;
  if (typeof table === 'number') {
    if (!pendingTables.has(doc)) pendingTables.set(doc, new Set());
    pendingTables.get(doc)!.add(table);
  }
  const t = timers.get(doc);
  if (t) clearTimeout(t);
  timers.set(
    doc,
    setTimeout(() => {
      timers.delete(doc);
      const tables = [...(pendingTables.get(doc) ?? [])];
      pendingTables.delete(doc);
      try {
        const r = checkDocument(doc, 'change', tables);
        if (r.changed) notify?.(doc, { attention: r.attention });
      } catch (e) {
        console.error('companion check failed:', errorMessage(e));
      }
    }, delayMs),
  );
}

/** Persistent monitoring: every change schedules a check; a timer re-checks freshness between sessions. */
export function startCompanion(intervalMs = 10 * 60_000) {
  onAppend((doc, entry) => scheduleCheck(doc, typeof entry.op?.table === 'number' ? (entry.op.table as number) : entry.run?.table));
  const tick = () => {
    if (!existsSync(DIR())) return;
    for (const f of readdirSync(DIR())) {
      if (!f.endsWith('.json')) continue;
      const doc = f.slice(0, -5);
      try {
        const r = checkDocument(doc, 'timer');
        if (r.changed) notify?.(doc, { attention: r.attention });
      } catch (e) {
        console.error('companion timer check failed:', errorMessage(e));
      }
    }
  };
  const h = setInterval(tick, intervalMs);
  h.unref();
}

// ------------------------------------------------------------------ code runs and investigations
/** A run of generated code against the live document, in the sandbox: kept as evidence with what it ran under. */
export function recordRun(doc: string, by: Author, run: Omit<CodeRun, 'id' | 'at' | 'by' | 'assumptionsSeq'>): CodeRun {
  const s = loadState(doc);
  const r: CodeRun = { id: newId(), at: now(), by: who(by), assumptionsSeq: s.assumptionsSeq ?? 0, ...run };
  s.runs!.push(r);
  if (r.investigation) {
    const inv = s.investigations!.find((i) => i.id === r.investigation);
    if (inv) inv.runs.push(r.id);
  }
  event(s, { kind: 'trace', text: `Ran code (${r.sandbox}): ${short(r.purpose || 'no purpose given', 100)} — ${r.ok ? `ok in ${r.ms} ms` : `failed: ${short(r.error ?? 'error', 100)}`}`, by: r.by, level: 'quiet' });
  saveState(s);
  return r;
}

export function startInvestigation(doc: string, by: Author, input: { question: string; issue?: string; thread?: string }): Investigation {
  const s = loadState(doc);
  const running = s.investigations!.find((i) => i.status === 'running' && Date.now() - Date.parse(i.startedAt) < 15 * 60_000);
  if (running) throw new Error('an investigation is already running on this document');
  const question = String(input.question ?? '').trim().slice(0, 2000);
  if (!question) throw new Error('question required');
  const inv: Investigation = { id: newId(), question, issue: input.issue && safeId(input.issue) ? input.issue : undefined, thread: input.thread && /^[a-zA-Z0-9:_-]{1,80}$/.test(input.thread) ? input.thread : `doc:${doc}`, startedAt: now(), status: 'running', steps: [], runs: [], records: [], proposals: [], by, assumptionsSeq: s.assumptionsSeq ?? 0 };
  s.investigations!.push(inv);
  event(s, { kind: 'investigation', text: `Investigating: ${short(question, 120)}`, by: who(by), level: 'quiet' });
  saveState(s);
  return inv;
}

export function finishInvestigation(doc: string, id: string, result: { status: 'done' | 'failed'; answer?: string; model?: string; error?: string; steps?: { tool: string; summary: string }[]; records?: string[]; proposals?: string[] }): Investigation {
  const s = loadState(doc);
  const inv = s.investigations!.find((i) => i.id === id);
  if (!inv) throw new Error('investigation not found');
  inv.status = result.status;
  inv.finishedAt = now();
  inv.answer = result.answer ? result.answer.slice(0, 8000) : undefined;
  inv.model = result.model;
  inv.error = result.error ? result.error.slice(0, 1000) : undefined;
  if (result.steps) inv.steps = result.steps.slice(0, 60).map((x) => ({ tool: String(x.tool).slice(0, 60), summary: String(x.summary).slice(0, 200) }));
  if (result.records) inv.records = result.records.filter(safeId).slice(0, 50);
  if (result.proposals) inv.proposals = result.proposals.filter(safeId).slice(0, 50);
  const made = [inv.runs.length ? `${inv.runs.length} sandboxed run${inv.runs.length === 1 ? '' : 's'}` : '', inv.records.length ? `${inv.records.length} proposed record${inv.records.length === 1 ? '' : 's'}` : '', inv.proposals.length ? `${inv.proposals.length} proposal${inv.proposals.length === 1 ? '' : 's'} to review` : ''].filter(Boolean).join(', ');
  event(s, { kind: 'investigation', text: result.status === 'done' ? `Investigation finished: ${short(inv.question, 80)} — ${made || 'nothing proposed'}; its findings are its own words, beside the evidence` : `Investigation failed: ${short(result.error ?? 'error', 160)}`, level: result.status === 'done' ? 'watch' : 'watch' });
  saveState(s);
  return inv;
}

export function getInvestigation(doc: string, id: string): Investigation | null {
  const s = loadState(doc);
  const inv = s.investigations!.find((i) => i.id === id);
  return inv ? { ...inv, stale: inv.status === 'done' && inv.assumptionsSeq !== (s.assumptionsSeq ?? 0) ? true : undefined } : null;
}

/** Everything the panel needs. */
export function snapshot(doc: string, viewer?: { login?: string }) {
  const s = loadState(doc);
  const records = s.records.filter((r) => !r.private || !viewer?.login || !r.by.login || r.by.login.toLowerCase() === viewer.login.toLowerCase());
  const u = understandingOf(doc, s);
  return { records, watches: s.watches, events: s.events.slice(-60), brief: brief(doc), seenAt: s.seenAt, graph: graphOf(doc), understanding: u, dismissed: s.dismissed ?? [], runs: (s.runs ?? []).slice(-20), investigations: u.investigations.slice(-10), assumptionsSeq: s.assumptionsSeq ?? 0 };
}

/** The context as data for a model prompt: statuses kept, instructions neutralised, private working context left out for outside agents. */
export function contextForModel(doc: string, opts: { viewer?: { login?: string }; outside?: boolean } = {}): Record<string, unknown> {
  const s = loadState(doc);
  const u = understandingOf(doc, s);
  const visible = (r: ContextRecord) => !r.private || (!opts.outside && (!opts.viewer?.login || !r.by.login || r.by.login.toLowerCase() === opts.viewer.login.toLowerCase()));
  const live = s.records.filter((r) => r.status !== 'retired' && r.status !== 'superseded' && visible(r));
  return {
    understanding: { statement: u.statement, stance: u.stance, next: u.next, coverage: u.coverage, uncertain: u.uncertain.slice(0, 8), assumptionsSeq: u.assumptionsSeq },
    records: live.map((r) => ({ id: r.id, kind: r.kind, status: r.status, text: r.text, source: r.source, period: r.period, arrived: r.arrivedAt.slice(0, 10), by: who(r.by), bearing: r.bearing, due: r.due, expected: r.expected?.text, why: r.why, conditions: r.conditions?.map((c) => ({ text: c.text, holds: c.holds })), resolution: r.resolution, derivative: r.derivative })),
    rejected: s.records.filter((r) => r.key?.startsWith('rejected:')).map((r) => ({ text: r.text, note: r.why, at: r.arrivedAt.slice(0, 10) })),
    setAside: (s.dismissed ?? []).map((d) => ({ purpose: d.purpose, reason: d.reason })),
    watches: s.watches.map((w) => ({ id: w.id, purpose: w.def.purpose, scope: w.def.scope, formula: w.def.formula, kind: w.def.kind, op: w.def.op, value: w.def.value, sustain: w.def.sustain, authority: w.authority, health: w.health, last: w.observations.slice(-5).map((o) => ({ at: o.at, period: o.period, value: o.value, complement: o.complement, breach: o.breach, fresh: o.fresh })), issue: w.issue?.status === 'open' ? { id: w.issue.id, summary: w.issue.summary, evidence: w.issue.evidence, uncertainty: w.issue.uncertainty } : undefined })),
    investigations: u.investigations.slice(-5).map((i) => ({ question: i.question, status: i.status, answer: i.answer, stale: i.stale, at: i.startedAt.slice(0, 10) })),
    sources: sourceStatus(doc),
  };
}

export function setInterpretation(doc: string, issueId: string, interpretation: Interpretation): Issue {
  const s = loadState(doc);
  const w = s.watches.find((x) => x.issue?.id === issueId);
  if (!w || !w.issue) throw new Error('issue not found');
  w.issue.interpretation = interpretation;
  saveState(s);
  return w.issue;
}

export function findIssue(doc: string, issueId: string): { watch: Watch; issue: Issue } | null {
  const s = loadState(doc);
  const w = s.watches.find((x) => x.issue?.id === issueId);
  return w && w.issue ? { watch: w, issue: w.issue } : null;
}

export function openIssues(doc: string): Issue[] {
  return loadState(doc)
    .watches.map((w) => w.issue)
    .filter((i): i is Issue => !!i && i.status === 'open');
}

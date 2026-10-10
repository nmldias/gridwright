// The companion's state — what is kept per document and how it is kept: the record, watch,
// issue, event, run and investigation types; the per-document JSON file under the data
// directory (read, written atomically, trimmed); the small helpers every other companion module
// uses (now, who, short, event); and the two rules that cut across them — a changed assumption
// makes earlier conclusions provisional and fences running investigations.
//
// More information increases the companion's understanding, not its authority: nothing here grants
// access, and an instruction inside a record is data, not an instruction to anyone.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Author } from '../history.js';
import { DATA_DIR } from '../storage.js';

export type RecordKind = 'fact' | 'source' | 'objective' | 'constraint' | 'hypothesis' | 'contradiction' | 'decision' | 'exclusion' | 'question' | 'expectation' | 'scenario';
export const RECORD_KINDS: RecordKind[] = ['fact', 'source', 'objective', 'constraint', 'hypothesis', 'contradiction', 'decision', 'exclusion', 'question', 'expectation', 'scenario'];
/** kinds that frame every conclusion: changing one makes earlier conclusions provisional */
export const ASSUMPTION_KINDS: RecordKind[] = ['objective', 'constraint', 'exclusion'];
export type RecordStatus = 'stated' | 'proposed' | 'confirmed' | 'observed' | 'resolved' | 'retired' | 'superseded';
export const LIVE = (r: ContextRecord) => r.status !== 'retired' && r.status !== 'superseded' && r.status !== 'resolved';

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
  /** a source: the retained original (intake key = content hash) and what the snapshot covers */
  intake?: string;
  coverage?: { rows: number; identifiers?: number; idColumn?: string; entity?: string };
  /** a source kept as history: an older period than the current snapshot of the same series */
  historical?: boolean;
  /** the companion's reading of what the person said (not a prefix, not a form): shown as such until confirmed or corrected */
  inferred?: boolean;
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

export type Invalid = 'blank' | 'text' | 'error' | 'unavailable';

/**
 * One observation per (definition, period): the figure a snapshot gives. A later check of the same
 * period revises it (a correction, an edit) rather than adding a second observation; a new period
 * adds one even when the value is unchanged. Without a period (tables edited by hand, no snapshot)
 * there is one current observation, revised on every change — no trend can be read from edits.
 */
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
  /** data rows of the tables read: a trend needs a comparable population */
  population?: number;
  /** typed invalid state: the formula gave no usable value — never "within bounds" */
  invalid?: Invalid;
  /** false when the comparison with the previous snapshot was suspended (coverage changed) */
  comparable?: false;
  note?: string;
  /** how many times this period's evidence was revised, and what it read before */
  revisions?: number;
  previous?: { value: number | boolean | string | null; at: string };
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

export type Health = 'ok' | 'baseline' | 'attention' | 'stale' | 'error' | 'invalid' | 'unchecked' | 'proposed';

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
  kind: 'record' | 'watch' | 'check' | 'issue' | 'decision' | 'source' | 'trace' | 'expectation' | 'conflict' | 'pattern' | 'assumption' | 'investigation' | 'reading' | 'intake';
  text: string;
  by?: string;
  level: 'quiet' | 'watch' | 'attention';
}

export interface SourceStatus {
  name: string;
  kind: 'table';
  /** when the data last changed — values, rows, imports, code results; formatting, saving and notes do not count */
  lastChange?: string;
  /** the period the data describes (from the live source record), kept apart from when it arrived */
  asOf?: string;
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
  /** running · done · failed · cancelled (stopped by a person) · superseded (the direction changed while it ran: its results are fenced) */
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'superseded';
  cancelRequested?: string;
  superseded?: string;
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
  /** the job that runs it (status, attempt, limit, cancellation live there) */
  job?: string;
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
  /** monitoring, truthfully: not configured · awaiting history · checked, no material issue · source stale · cannot assess · partially assessed · action needed */
  monitoring: { state: string; text: string; cannotAssess: number };
  /** each exclusion and whether the watches apply it: recorded is not applied */
  scope: ScopeState[];
}

export interface ScopeState {
  record: string;
  text: string;
  /** the yes/no column that marks what is left out, when one was found */
  column?: string;
  table?: string;
  state: 'applied' | 'partly' | 'recorded' | 'no-column';
  watches: { id: string; purpose: string; applicable: boolean; applied: boolean }[];
}

export interface Brief {
  changed: string[];
  matters: string[];
  next: string[];
  health: { checked?: string; ok: number; baseline: number; attention: number; stale: number; error: number; invalid: number; unchecked: number; proposed: number };
  sources: SourceStatus[];
  stance: Stance;
  lead: string;
  statement: string;
}

export const DIR = () => join(DATA_DIR, 'companion');
export const pathOf = (doc: string) => join(DIR(), `${doc}.json`);
export const safeId = (id: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(id);
export const MAX_OBS = 500;
export const MAX_EVENTS = 300;
export const MAX_RUNS = 100;
export const MAX_INVESTIGATIONS = 40;

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}
export function writeJsonAtomic(path: string, value: unknown) {
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
export function saveState(s: CompanionState) {
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

export const now = () => new Date().toISOString();
export const today = () => now().slice(0, 10);
export const who = (a: Author) => a.name || a.login || 'someone';
export function event(s: CompanionState, e: Omit<Event, 'at'>) {
  s.events.push({ at: now(), ...e });
}
export const short = (t: string, n = 160) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

/** A changed frame: everything concluded before it is provisional until re-checked. */
export function bumpAssumptions(s: CompanionState, r: ContextRecord, how: 'added' | 'changed' | 'retired' | 'removed', by: Author) {
  s.assumptionsSeq = (s.assumptionsSeq ?? 0) + 1;
  fenceRunning(s, `${r.kind} “${short(r.text, 80)}” ${how}`);
  if (how === 'added') return; // "Kept what matters" is already in the activity
  const had = (s.investigations ?? []).filter((i) => i.status === 'done' && i.assumptionsSeq < (s.assumptionsSeq ?? 0)).length;
  event(s, { kind: 'assumption', text: `Assumption ${how}: ${r.kind} “${short(r.text, 100)}” — ${had ? `${had} earlier investigation${had === 1 ? ' is' : 's are'} now provisional; ` : ''}conclusions reached before it are provisional until re-checked`, by: who(by), level: 'watch' });
}

let fenceHook: ((doc: string, why: string) => void) | null = null;
/** Called whenever a document's running work is fenced (jobs.ts supersedes the document's jobs). */
export function setFenceHook(fn: typeof fenceHook) {
  fenceHook = fn;
}
/** A running investigation under a direction that just changed: its result, when it comes, is superseded — kept as history, never current. */
export function fenceRunning(s: CompanionState, why: string) {
  for (const i of s.investigations ?? []) {
    if (i.status === 'running' && !i.superseded) {
      i.superseded = now();
      event(s, { kind: 'investigation', text: `The investigation “${short(i.question, 80)}” was overtaken (${why}): whatever it finds is kept as history, not applied`, level: 'quiet' });
    }
  }
  try {
    fenceHook?.(s.doc, why);
  } catch (e) {
    console.error('fence hook failed:', (e as Error).message);
  }
}

export const loadStateQuiet = (doc: string): CompanionState => {
  try {
    return loadState(doc);
  } catch {
    return { doc, records: [], watches: [], events: [] };
  }
};

export const hoursSince = (iso?: string) => (iso ? (Date.now() - Date.parse(iso)) / 3_600_000 : Infinity);

/** An event from another module (an intake, a first reading): kept in the same activity. */
export function noteEvent(doc: string, e: Omit<Event, 'at'>) {
  const s = loadState(doc);
  event(s, e);
  saveState(s);
}

export function markSeen(doc: string) {
  const s = loadState(doc);
  s.seenAt = now();
  saveState(s);
}


// The companion's working model of a document: source-backed facts, objectives, hypotheses,
// contradictions, decisions and exclusions, each with where it came from, the period it describes,
// when it arrived and whether a person stated it or an agent proposed it; a registry of watches
// (what is watched, why, under which conditions, with what authority); cheap deterministic checks
// that run on every change and on a timer; one evolving issue per watch; and a brief that answers
// what has changed, why it matters and what to do next. The model is asked only to interpret an
// attention-level issue, and its words are stored as its own, beside the evidence.
//
// More information increases the companion's understanding, not its authority: nothing here grants
// access, and an instruction inside a record is data, not an instruction to anyone.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { currentSeq, onAppend, readAll, type Author, type LogEntry } from './history.js';
import { engineAvailable, errorMessage, openDocument, tableByName, tableMetas, type CellViewJson, type TableMetaView } from './headless.js';
import { DATA_DIR, listConnections, newId, readFile } from './storage.js';

export type RecordKind = 'fact' | 'source' | 'objective' | 'hypothesis' | 'contradiction' | 'decision' | 'exclusion';
export const RECORD_KINDS: RecordKind[] = ['fact', 'source', 'objective', 'hypothesis', 'contradiction', 'decision', 'exclusion'];
export type RecordStatus = 'stated' | 'proposed' | 'confirmed' | 'retired' | 'superseded';

export interface ContextRecord {
  id: string;
  kind: RecordKind;
  text: string;
  /** where it came from: a file, a table, a connection, a person's words, an agent's reading */
  source?: string;
  /** the period the information describes (not the day it arrived) */
  period?: string;
  arrivedAt: string;
  by: Author;
  origin: 'user' | 'agent' | 'system';
  /** stated by a person; proposed by an agent until a person confirms; retired; superseded by a newer source */
  status: RecordStatus;
  supersededBy?: string;
  links?: { table?: number; ref?: string }[];
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
}

export interface Observation {
  at: string;
  seq: number;
  /** the period of the snapshot this observation was made on (from the latest source record of the tables read) */
  period?: string;
  value: number | boolean | string | null;
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
}

export interface Event {
  at: string;
  /** trace: bookkeeping kept in the activity but left out of the brief */
  kind: 'record' | 'watch' | 'check' | 'issue' | 'decision' | 'source' | 'trace';
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

export interface CompanionState {
  doc: string;
  records: ContextRecord[];
  watches: Watch[];
  events: Event[];
  seenAt?: string;
}

export interface Brief {
  changed: string[];
  matters: string[];
  next: string[];
  health: { checked?: string; ok: number; baseline: number; attention: number; stale: number; error: number; unchecked: number; proposed: number };
  sources: SourceStatus[];
}

const DIR = () => join(DATA_DIR, 'companion');
const pathOf = (doc: string) => join(DIR(), `${doc}.json`);
const safeId = (id: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(id);
const MAX_OBS = 500;
const MAX_EVENTS = 300;

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
  for (const w of s.watches) w.history ??= [];
  return s;
}
function saveState(s: CompanionState) {
  if (s.events.length > MAX_EVENTS) s.events = s.events.slice(-MAX_EVENTS);
  for (const w of s.watches) if (w.observations.length > MAX_OBS) w.observations = w.observations.slice(-MAX_OBS);
  writeJsonAtomic(pathOf(s.doc), s);
}
export function deleteCompanion(doc: string) {
  if (safeId(doc) && existsSync(pathOf(doc))) unlinkSync(pathOf(doc));
}
export function hasCompanion(doc: string): boolean {
  return safeId(doc) && existsSync(pathOf(doc));
}

const now = () => new Date().toISOString();
const who = (a: Author) => a.name || a.login || 'someone';
function event(s: CompanionState, e: Omit<Event, 'at'>) {
  s.events.push({ at: now(), ...e });
}

// ------------------------------------------------------------------ records
export function addRecord(doc: string, by: Author, origin: 'user' | 'agent' | 'system', input: { kind: RecordKind; text: string; source?: string; period?: string; links?: ContextRecord['links'] }): ContextRecord {
  const s = loadState(doc);
  if (!RECORD_KINDS.includes(input.kind)) throw new Error(`kind must be one of ${RECORD_KINDS.join(', ')}`);
  const text = String(input.text ?? '').trim().slice(0, 2000);
  if (!text) throw new Error('text required');
  const r: ContextRecord = {
    id: newId(),
    kind: input.kind,
    text,
    source: input.source ? String(input.source).slice(0, 300) : undefined,
    period: input.period ? String(input.period).slice(0, 80) : undefined,
    arrivedAt: now(),
    by,
    origin,
    // a person's words stand; an agent's reading waits for a person
    status: origin === 'agent' ? 'proposed' : 'stated',
    links: input.links,
  };
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
  const shown = r.kind === 'source' ? text.replace(/\s*\(.*\)\s*$/, '') + (r.period ? ` (period ${r.period})` : '') : `${origin === 'agent' ? 'Proposed' : 'Kept'} ${r.kind === 'objective' ? 'what matters' : r.kind === 'exclusion' ? 'what to leave out' : r.kind}: ${text.slice(0, 160)}`;
  event(s, { kind: r.kind === 'source' ? 'source' : 'record', text: shown, by: who(by), level: 'quiet' });
  saveState(s);
  return r;
}

export function updateRecord(doc: string, id: string, by: Author, patch: { text?: string; status?: 'confirmed' | 'retired' | 'stated'; period?: string; source?: string; kind?: RecordKind }): ContextRecord {
  const s = loadState(doc);
  const r = s.records.find((x) => x.id === id);
  if (!r) throw new Error('record not found');
  if (patch.text !== undefined) r.text = String(patch.text).trim().slice(0, 2000) || r.text;
  if (patch.period !== undefined) r.period = String(patch.period).slice(0, 80) || undefined;
  if (patch.source !== undefined) r.source = String(patch.source).slice(0, 300) || undefined;
  if (patch.kind && RECORD_KINDS.includes(patch.kind)) r.kind = patch.kind;
  if (patch.status) {
    r.status = patch.status;
    event(s, { kind: 'record', text: `${patch.status === 'retired' ? 'Retired' : patch.status === 'confirmed' ? 'Confirmed' : 'Corrected'} ${r.kind}: ${r.text.slice(0, 160)}`, by: who(by), level: 'quiet' });
  } else {
    event(s, { kind: 'record', text: `Corrected ${r.kind}: ${r.text.slice(0, 160)}`, by: who(by), level: 'quiet' });
  }
  saveState(s);
  return r;
}

export function removeRecord(doc: string, id: string, by: Author): boolean {
  const s = loadState(doc);
  const i = s.records.findIndex((x) => x.id === id);
  if (i < 0) return false;
  const [r] = s.records.splice(i, 1);
  event(s, { kind: 'record', text: `Removed ${r.kind}: ${r.text.slice(0, 120)}`, by: who(by), level: 'quiet' });
  saveState(s);
  return true;
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
      s.records.push({ id: newId(), kind: 'decision', text, arrivedAt: now(), by, origin: 'user', status: 'stated', source: 'watch definition' });
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

// ------------------------------------------------------------------ checks
type Plain = number | boolean | string | null;
function evaluate(doc: string, def: WatchDef): { value: Plain; error?: string } {
  const { book } = openDocument(doc);
  try {
    const t = def.table ? tableByName(book, def.table) : tableMetas(book)[0];
    if (!t) return { value: null, error: def.table ? `table “${def.table}” not found` : 'the document has no table' };
    const v = JSON.parse(book.preview(t.id, def.formula)) as { n?: number; b?: boolean; s?: string; e?: string } | null;
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
  if (!s.watches.length) return { attention: 0, changed: false, affected: [] };
  const seq = currentSeq(doc);
  const log = readAll(doc);
  const sources = sourceStatus(doc, log);
  let changed = false;
  let attention = 0;
  const at = now();
  // which analyses the change reaches, by the graph's edges (named in the activity; every watch is still evaluated — it is cheap)
  let affected: string[] = [];
  if (changedTables.length) {
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
  // the snapshot period of each table: its latest live source record (set by the person or read from the file name)
  const periodOfTable = new Map<number, string>();
  for (const r of s.records) {
    if (r.kind !== 'source' || r.status === 'retired' || r.status === 'superseded') continue;
    for (const l of r.links ?? []) if (typeof l.table === 'number' && r.period) periodOfTable.set(l.table, r.period);
  }
  let metas: TableMetaView[] = [];
  try {
    const { book } = openDocument(doc);
    try {
      metas = tableMetas(book);
    } finally {
      book.free();
    }
  } catch {
    /* no engine: no periods */
  }
  for (const w of s.watches) {
    if (w.authority !== 'approved') continue;
    const { value, error } = evaluate(doc, w.def);
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
    const novel = !prev || prev.seq !== seq || prev.value !== value || !!prev.error !== !!error || prev.fresh !== fresh || prev.def !== w.defHash || prev.period !== period;
    if (novel) {
      w.observations.push({ at, seq, period, value, error, breach, fresh, def: w.defHash });
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
    }
  }
  void reason;
  saveState(s);
  return { attention, changed, affected };
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
      if (!v.v || (('s' in v.v) && !v.v.s.trim())) continue;
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

export function suggestWatches(doc: string): Suggestion[] {
  if (!engineAvailable() || !readFile(doc)) return [];
  const s = loadState(doc);
  const have = new Set(s.watches.map((w) => w.def.formula.replace(/\s+/g, '')));
  const out: Suggestion[] = [];
  const add = (id: string, purpose: string, why: string, def: Partial<WatchDef>) => {
    const d = normaliseDef({ sustain: 2, response: 'brief', ...def, purpose });
    if (have.has(d.formula.replace(/\s+/g, ''))) return;
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
          add(`${t.id}:${p.index}:age`, cap(`${prefix}${rowWord} over ${limit} ${/dias/i.test(h) ? 'dias' : 'days'}${flag ? ' (excl. reserved)' : ''}`), `“${h}” reads like days in stock; ageing beyond ${limit} days usually needs a decision${flag ? `; ${flag.header} = yes is left out` : ''}`, { formula: flag ? `=COUNTIFS(${col(t.name, h)}, ">${limit}"${flagCond})` : `=COUNTIF(${col(t.name, h)}, ">${limit}")`, kind: 'worsening', bad: 'up', scope: `${t.name}${flagText}`, sources: [t.name] });
        } else if (mostly(p, 'dates') && /date|data|entr|receiv|arriv|in\b/i.test(h)) {
          add(`${t.id}:${p.index}:since`, cap(`${prefix}${rowWord} older than 90 days${flag ? ' (excl. reserved)' : ''}`), `“${h}” is a date; counting what is older than 90 days from today${flag ? `; ${flag.header} = yes is left out` : ''}`, { formula: flag ? `=COUNTIFS(${col(t.name, h)}, "<"&(TODAY()-90)${flagCond})` : `=COUNTIF(${col(t.name, h)}, "<"&(TODAY()-90))`, kind: 'worsening', bad: 'up', scope: `${t.name}${flagText}`, sources: [t.name] });
        }
        if (mostly(p, 'numbers') && !mostly(p, 'dates') && /cost|amount|value|price|total|valor|custo|montante|pre[cç]o|margin|margem|landed|cif|fob/i.test(h) && !/days|dias/i.test(h)) {
          add(`${t.id}:${p.index}:blank`, cap(`${prefix}${rowWord} with no ${h.toLowerCase()}`), `a missing ${h.toLowerCase()} makes a margin or a total provisional`, { formula: `=COUNTIFS(${col(t.name, h)}, ""${present})`, kind: 'threshold', op: '>', value: 0, sustain: 1, scope: t.name, sources: [t.name] });
          add(`${t.id}:${p.index}:total`, cap(`${prefix}total ${h.toLowerCase()}`), `the total moves when a snapshot changes; a movement is worth a look, not an alarm`, { formula: `=SUM(${col(t.name, h)})`, kind: 'change', sustain: 1, scope: t.name, sources: [t.name] });
        }
        if (!mostly(p, 'numbers') && /\b(vin|id|ref|reference|chassis|invoice|factura|fatura|cheque|no\.?|number|code|c[oó]digo)\b/i.test(h) && p.unique >= Math.max(2, (dataRows - p.blanks) * 0.7)) {
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

// ------------------------------------------------------------------ brief
export function brief(doc: string): Brief {
  const s = loadState(doc);
  const sources = sourceStatus(doc);
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
  for (const w of s.watches) {
    health[w.health]++;
    if (w.lastChecked && (!health.checked || w.lastChecked > health.checked)) health.checked = w.lastChecked;
    if (w.issue?.status === 'open') {
      matters.push(w.issue.summary);
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
  const proposedRecords = s.records.filter((r) => r.status === 'proposed');
  const proposedWatches = s.watches.filter((w) => w.authority === 'proposed');
  if (proposedWatches.length) next.push(`${proposedWatches.length} proposed watch${proposedWatches.length === 1 ? '' : 'es'} await${proposedWatches.length === 1 ? 's' : ''} your approval.`);
  if (proposedRecords.length) next.push(`${proposedRecords.length} context item${proposedRecords.length === 1 ? '' : 's'} proposed by an agent await${proposedRecords.length === 1 ? 's' : ''} confirmation.`);
  const baseline = s.watches.filter((w) => w.health === 'baseline');
  if (baseline.length && !matters.length) matters.push(`${baseline.length} watch${baseline.length === 1 ? '' : 'es'} still building a baseline — no conclusion yet, which is a valid state.`);
  if (!matters.length) {
    const approved = s.watches.filter((w) => w.authority === 'approved').length;
    matters.push(approved ? (health.checked ? `No material issues detected (${approved} watch${approved === 1 ? '' : 'es'} checked ${health.checked.slice(0, 16).replace('T', ' ')}).` : `${approved} watch${approved === 1 ? '' : 'es'} not checked yet.`) : 'Nothing is being watched yet.');
  }
  if (!next.length) next.push(s.watches.length ? 'Nothing to decide.' : 'Tell the companion what matters (Objective: …, Exclude: …) and what to watch.');
  return { changed, matters, next, health, sources };
}

export function markSeen(doc: string) {
  const s = loadState(doc);
  s.seenAt = now();
  saveState(s);
}

// ------------------------------------------------------------------ the graph
// The tables are the nodes. Edges are read off the workbook itself (formulas, pivots, SQL cells,
// imports) and off the context (what a record is about, what a watch reads, what an objective
// constrains); nobody has to draw them. A change to one node names the nodes to reassess.
export type NodeType = 'table' | 'source' | 'watch' | 'issue' | RecordKind;
export type EdgeType = 'derived_from' | 'fed_by' | 'about' | 'watches' | 'constrains' | 'excludes' | 'raises' | 'supersedes';
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
  /** how the edge was found: formula, pivot, sql, import, link, mention, case */
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
    if (e.type === 'derived_from' || e.type === 'watches' || e.type === 'about' || e.type === 'excludes' || e.type === 'raises') {
      // derived_from / watches / about / excludes: from depends on to; raises: issue depends on watch
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

/** Everything the panel needs. */
export function snapshot(doc: string) {
  const s = loadState(doc);
  return { records: s.records, watches: s.watches, events: s.events.slice(-60), brief: brief(doc), seenAt: s.seenAt, graph: graphOf(doc) };
}

/** The context as data for a model prompt: statuses kept, instructions neutralised. */
export function contextForModel(doc: string): Record<string, unknown> {
  const s = loadState(doc);
  const live = s.records.filter((r) => r.status !== 'retired' && r.status !== 'superseded');
  return {
    records: live.map((r) => ({ kind: r.kind, status: r.status, text: r.text, source: r.source, period: r.period, arrived: r.arrivedAt.slice(0, 10), by: who(r.by) })),
    watches: s.watches.map((w) => ({ purpose: w.def.purpose, scope: w.def.scope, formula: w.def.formula, kind: w.def.kind, op: w.def.op, value: w.def.value, sustain: w.def.sustain, authority: w.authority, health: w.health, last: w.observations.slice(-5).map((o) => ({ at: o.at, value: o.value, breach: o.breach, fresh: o.fresh })), issue: w.issue?.status === 'open' ? { summary: w.issue.summary, evidence: w.issue.evidence, uncertainty: w.issue.uncertainty } : undefined })),
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

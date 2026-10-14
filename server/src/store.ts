// The companion's structured store: jobs, sources, recipe versions and dataset versions — what
// needs transactions, constraints and a query, as opposed to a document's state (JSON next to the
// log). One interface; the first implementation is SQLite in the data directory (node:sqlite, one
// file, WAL, part of the same backup), so that a single-node install needs no second service. A
// PostgreSQL implementation is the same interface when the layer is shared or the volumes warrant
// it. Nothing here is the authority on a document: placements still go through the operation log.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './storage.js';

export type JobType = 'investigation' | 'refresh' | 'recipe';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'superseded' | 'interrupted';

export interface Job {
  id: string;
  type: JobType;
  doc: string;
  /** what the job runs on, with the versions it saw (assumptionsSeq, a source version, an intake key…) */
  input: Record<string, unknown>;
  status: JobStatus;
  by: { id: string; name: string; login?: string };
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  heartbeatAt?: string;
  attempts: number;
  maxAttempts: number;
  cancelRequested?: string;
  supersededAt?: string;
  limits: { timeoutMs: number };
  /** where the result lives (an investigation id, an intake key, a dataset version) and a line about it */
  result?: { ref?: string; summary?: string };
  error?: string;
  worker?: string;
}

export interface JobPatch {
  status?: JobStatus;
  startedAt?: string;
  finishedAt?: string;
  heartbeatAt?: string;
  attempts?: number;
  cancelRequested?: string;
  supersededAt?: string;
  result?: Job['result'];
  error?: string;
  worker?: string;
}

export interface SourceDef {
  id: string;
  doc: string;
  name: string;
  /** the series this source feeds (the table's family) and the table it is traced to */
  series: string;
  table?: number;
  kind: 'sql' | 'file';
  connection?: string;
  sql?: string;
  /** the recipe version in force */
  recipe?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  /** refresh bookkeeping (brief §8): data-as-of, last attempt, last success, result, version, completeness */
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastResult?: string;
  lastVersion?: string;
  asOf?: string;
  enabled: boolean;
}

export interface RecipeVersion {
  id: string;
  source: string;
  version: number;
  /** the preparation decisions, captured from a profile a person accepted */
  recipe: Record<string, unknown>;
  createdAt: string;
  createdBy: string;
  /** the environment it was made under (engine, server, stack versions) */
  environment: Record<string, string>;
  note?: string;
}

export interface DatasetVersion {
  id: string;
  source: string;
  doc: string;
  version: number;
  period?: string;
  /** content hash of the prepared rows */
  hash: string;
  rows: number;
  columns: number;
  /** the recipe version that prepared it */
  recipe?: string;
  /** the intake key (profile + original) it came from */
  intake?: string;
  reconciliation: { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] };
  status: 'held' | 'accepted' | 'rejected' | 'superseded';
  createdAt: string;
  acceptedAt?: string;
  acceptedBy?: string;
  job?: string;
}

export interface Store {
  insertJob(job: Job): void;
  updateJob(id: string, patch: JobPatch): Job | null;
  getJob(id: string): Job | null;
  listJobs(filter?: { doc?: string; status?: JobStatus[]; type?: JobType; limit?: number }): Job[];
  /** the oldest queued job of one of the types, marked running for this worker — atomically */
  claimNext(types: JobType[], worker: string): Job | null;
  /** jobs left running by a process that is gone: marked interrupted; returns them */
  interruptRunning(reason: string): Job[];

  upsertSource(s: SourceDef): void;
  getSource(id: string): SourceDef | null;
  listSources(doc: string): SourceDef[];
  deleteSourcesOf(doc: string): number;

  insertRecipe(r: RecipeVersion): void;
  getRecipe(id: string): RecipeVersion | null;
  listRecipes(source: string): RecipeVersion[];

  insertDataset(d: DatasetVersion): void;
  updateDataset(id: string, patch: Partial<Pick<DatasetVersion, 'status' | 'acceptedAt' | 'acceptedBy' | 'reconciliation'>>): DatasetVersion | null;
  getDataset(id: string): DatasetVersion | null;
  listDatasets(source: string, limit?: number): DatasetVersion[];

  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, doc TEXT NOT NULL, status TEXT NOT NULL,
  input TEXT NOT NULL, by TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, heartbeat_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 1, cancel_requested TEXT, superseded_at TEXT,
  limits TEXT NOT NULL, result TEXT, error TEXT, worker TEXT
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS jobs_doc ON jobs(doc, created_at);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, doc TEXT NOT NULL, name TEXT NOT NULL, series TEXT NOT NULL, tbl INTEGER, kind TEXT NOT NULL,
  connection TEXT, sql TEXT, recipe TEXT, created_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_at TEXT NOT NULL,
  last_attempt_at TEXT, last_success_at TEXT, last_result TEXT, last_version TEXT, as_of TEXT, enabled INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS sources_doc ON sources(doc);
CREATE TABLE IF NOT EXISTS recipe_versions (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, version INTEGER NOT NULL, recipe TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL,
  environment TEXT NOT NULL, note TEXT, UNIQUE(source, version)
);
CREATE TABLE IF NOT EXISTS dataset_versions (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, doc TEXT NOT NULL, version INTEGER NOT NULL, period TEXT, hash TEXT NOT NULL,
  rows INTEGER NOT NULL, columns INTEGER NOT NULL, recipe TEXT, intake TEXT, reconciliation TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, accepted_at TEXT, accepted_by TEXT, job TEXT, UNIQUE(source, version)
);
CREATE INDEX IF NOT EXISTS datasets_source ON dataset_versions(source, version);
`;

type Row = Record<string, unknown>;
const j = (v: unknown) => JSON.stringify(v ?? null);
const pj = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
const s = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));

function jobOf(r: Row): Job {
  return {
    id: String(r.id),
    type: String(r.type) as JobType,
    doc: String(r.doc),
    status: String(r.status) as JobStatus,
    input: pj<Record<string, unknown>>(r.input, {}),
    by: pj<Job['by']>(r.by, { id: 'api', name: 'someone' }),
    createdAt: String(r.created_at),
    startedAt: s(r.started_at),
    finishedAt: s(r.finished_at),
    heartbeatAt: s(r.heartbeat_at),
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
    cancelRequested: s(r.cancel_requested),
    supersededAt: s(r.superseded_at),
    limits: pj<Job['limits']>(r.limits, { timeoutMs: 600_000 }),
    result: r.result ? pj<Job['result']>(r.result, undefined) : undefined,
    error: s(r.error),
    worker: s(r.worker),
  };
}
function sourceOf(r: Row): SourceDef {
  return { id: String(r.id), doc: String(r.doc), name: String(r.name), series: String(r.series), table: r.tbl === null || r.tbl === undefined ? undefined : Number(r.tbl), kind: String(r.kind) as SourceDef['kind'], connection: s(r.connection), sql: s(r.sql), recipe: s(r.recipe), createdAt: String(r.created_at), createdBy: String(r.created_by), updatedAt: String(r.updated_at), lastAttemptAt: s(r.last_attempt_at), lastSuccessAt: s(r.last_success_at), lastResult: s(r.last_result), lastVersion: s(r.last_version), asOf: s(r.as_of), enabled: Number(r.enabled) !== 0 };
}
function recipeOf(r: Row): RecipeVersion {
  return { id: String(r.id), source: String(r.source), version: Number(r.version), recipe: pj<Record<string, unknown>>(r.recipe, {}), createdAt: String(r.created_at), createdBy: String(r.created_by), environment: pj<Record<string, string>>(r.environment, {}), note: s(r.note) };
}
function datasetOf(r: Row): DatasetVersion {
  return { id: String(r.id), source: String(r.source), doc: String(r.doc), version: Number(r.version), period: s(r.period), hash: String(r.hash), rows: Number(r.rows), columns: Number(r.columns), recipe: s(r.recipe), intake: s(r.intake), reconciliation: pj<DatasetVersion['reconciliation']>(r.reconciliation, { ok: false, checks: [] }), status: String(r.status) as DatasetVersion['status'], createdAt: String(r.created_at), acceptedAt: s(r.accepted_at), acceptedBy: s(r.accepted_by), job: s(r.job) };
}

/** SQLite under the data directory. */
export class SqliteStore implements Store {
  private db: DatabaseSync;
  constructor(path: string, Database: new (p: string) => DatabaseSync) {
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }
  insertJob(job: Job) {
    this.db
      .prepare('INSERT INTO jobs (id, type, doc, status, input, by, created_at, started_at, finished_at, heartbeat_at, attempts, max_attempts, cancel_requested, superseded_at, limits, result, error, worker) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(job.id, job.type, job.doc, job.status, j(job.input), j(job.by), job.createdAt, job.startedAt ?? null, job.finishedAt ?? null, job.heartbeatAt ?? null, job.attempts, job.maxAttempts, job.cancelRequested ?? null, job.supersededAt ?? null, j(job.limits), job.result ? j(job.result) : null, job.error ?? null, job.worker ?? null);
  }
  updateJob(id: string, patch: JobPatch): Job | null {
    const cols: string[] = [];
    const vals: (string | number | null)[] = [];
    const set = (col: string, v: string | number | null | undefined) => {
      if (v === undefined) return;
      cols.push(`${col} = ?`);
      vals.push(v);
    };
    set('status', patch.status);
    set('started_at', patch.startedAt);
    set('finished_at', patch.finishedAt);
    set('heartbeat_at', patch.heartbeatAt);
    set('attempts', patch.attempts);
    set('cancel_requested', patch.cancelRequested);
    set('superseded_at', patch.supersededAt);
    if (patch.result !== undefined) set('result', j(patch.result));
    set('error', patch.error);
    set('worker', patch.worker);
    if (cols.length) this.db.prepare(`UPDATE jobs SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
    return this.getJob(id);
  }
  getJob(id: string): Job | null {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined;
    return r ? jobOf(r) : null;
  }
  listJobs(filter: { doc?: string; status?: JobStatus[]; type?: JobType; limit?: number } = {}): Job[] {
    const where: string[] = [];
    const vals: (string | number)[] = [];
    if (filter.doc) {
      where.push('doc = ?');
      vals.push(filter.doc);
    }
    if (filter.type) {
      where.push('type = ?');
      vals.push(filter.type);
    }
    if (filter.status?.length) {
      where.push(`status IN (${filter.status.map(() => '?').join(', ')})`);
      vals.push(...filter.status);
    }
    const rows = this.db.prepare(`SELECT * FROM jobs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`).all(...vals, Math.min(500, Math.max(1, filter.limit ?? 50))) as Row[];
    return rows.map(jobOf);
  }
  claimNext(types: JobType[], worker: string): Job | null {
    if (!types.length) return null;
    const now = new Date().toISOString();
    // one statement: the oldest queued job of the types becomes running for this worker, or nothing does
    const r = this.db
      .prepare(`UPDATE jobs SET status = 'running', started_at = ?, heartbeat_at = ?, attempts = attempts + 1, worker = ? WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND type IN (${types.map(() => '?').join(', ')}) ORDER BY created_at LIMIT 1) RETURNING *`)
      .get(now, now, worker, ...types) as Row | undefined;
    return r ? jobOf(r) : null;
  }
  interruptRunning(reason: string): Job[] {
    const now = new Date().toISOString();
    const rows = this.db.prepare(`UPDATE jobs SET status = 'interrupted', finished_at = ?, error = ? WHERE status = 'running' RETURNING *`).all(now, `interrupted: ${reason}`) as Row[];
    return rows.map(jobOf);
  }

  upsertSource(src: SourceDef) {
    this.db
      .prepare('INSERT INTO sources (id, doc, name, series, tbl, kind, connection, sql, recipe, created_at, created_by, updated_at, last_attempt_at, last_success_at, last_result, last_version, as_of, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, series = excluded.series, tbl = excluded.tbl, kind = excluded.kind, connection = excluded.connection, sql = excluded.sql, recipe = excluded.recipe, updated_at = excluded.updated_at, last_attempt_at = excluded.last_attempt_at, last_success_at = excluded.last_success_at, last_result = excluded.last_result, last_version = excluded.last_version, as_of = excluded.as_of, enabled = excluded.enabled')
      .run(src.id, src.doc, src.name, src.series, src.table ?? null, src.kind, src.connection ?? null, src.sql ?? null, src.recipe ?? null, src.createdAt, src.createdBy, src.updatedAt, src.lastAttemptAt ?? null, src.lastSuccessAt ?? null, src.lastResult ?? null, src.lastVersion ?? null, src.asOf ?? null, src.enabled ? 1 : 0);
  }
  getSource(id: string): SourceDef | null {
    const r = this.db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as Row | undefined;
    return r ? sourceOf(r) : null;
  }
  listSources(doc: string): SourceDef[] {
    return (this.db.prepare('SELECT * FROM sources WHERE doc = ? ORDER BY created_at').all(doc) as Row[]).map(sourceOf);
  }
  deleteSourcesOf(doc: string): number {
    const ids = (this.db.prepare('SELECT id FROM sources WHERE doc = ?').all(doc) as Row[]).map((r) => String(r.id));
    for (const id of ids) {
      this.db.prepare('DELETE FROM recipe_versions WHERE source = ?').run(id);
      this.db.prepare('DELETE FROM dataset_versions WHERE source = ?').run(id);
    }
    this.db.prepare('DELETE FROM sources WHERE doc = ?').run(doc);
    this.db.prepare('DELETE FROM jobs WHERE doc = ?').run(doc);
    return ids.length;
  }

  insertRecipe(r: RecipeVersion) {
    this.db.prepare('INSERT INTO recipe_versions (id, source, version, recipe, created_at, created_by, environment, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(r.id, r.source, r.version, j(r.recipe), r.createdAt, r.createdBy, j(r.environment), r.note ?? null);
  }
  getRecipe(id: string): RecipeVersion | null {
    const r = this.db.prepare('SELECT * FROM recipe_versions WHERE id = ?').get(id) as Row | undefined;
    return r ? recipeOf(r) : null;
  }
  listRecipes(source: string): RecipeVersion[] {
    return (this.db.prepare('SELECT * FROM recipe_versions WHERE source = ? ORDER BY version').all(source) as Row[]).map(recipeOf);
  }

  insertDataset(d: DatasetVersion) {
    this.db
      .prepare('INSERT INTO dataset_versions (id, source, doc, version, period, hash, rows, columns, recipe, intake, reconciliation, status, created_at, accepted_at, accepted_by, job) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(d.id, d.source, d.doc, d.version, d.period ?? null, d.hash, d.rows, d.columns, d.recipe ?? null, d.intake ?? null, j(d.reconciliation), d.status, d.createdAt, d.acceptedAt ?? null, d.acceptedBy ?? null, d.job ?? null);
  }
  updateDataset(id: string, patch: Partial<Pick<DatasetVersion, 'status' | 'acceptedAt' | 'acceptedBy' | 'reconciliation'>>): DatasetVersion | null {
    const cols: string[] = [];
    const vals: (string | null)[] = [];
    if (patch.status !== undefined) {
      cols.push('status = ?');
      vals.push(patch.status);
    }
    if (patch.acceptedAt !== undefined) {
      cols.push('accepted_at = ?');
      vals.push(patch.acceptedAt);
    }
    if (patch.acceptedBy !== undefined) {
      cols.push('accepted_by = ?');
      vals.push(patch.acceptedBy);
    }
    if (patch.reconciliation !== undefined) {
      cols.push('reconciliation = ?');
      vals.push(j(patch.reconciliation));
    }
    if (cols.length) this.db.prepare(`UPDATE dataset_versions SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
    return this.getDataset(id);
  }
  getDataset(id: string): DatasetVersion | null {
    const r = this.db.prepare('SELECT * FROM dataset_versions WHERE id = ?').get(id) as Row | undefined;
    return r ? datasetOf(r) : null;
  }
  listDatasets(source: string, limit = 50): DatasetVersion[] {
    return (this.db.prepare('SELECT * FROM dataset_versions WHERE source = ? ORDER BY version DESC LIMIT ?').all(source, limit) as Row[]).map(datasetOf);
  }
  close() {
    this.db.close();
  }
}

let store: Store | null = null;
let opening: Promise<Store> | null = null;

/** The store, opened once: `${GRIDWRIGHT_DATA}/companion/store.sqlite` (GRIDWRIGHT_STORE names another file). */
export async function openStore(): Promise<Store> {
  if (store) return store;
  if (opening) return opening;
  opening = (async () => {
    // node:sqlite is marked experimental by Node ≥ 22.13 although its API is settled; the warning would print once per start
    const warn = process.emitWarning;
    process.emitWarning = ((w: unknown, ...rest: unknown[]) => {
      if (typeof w === 'string' && /SQLite is an experimental feature/.test(w)) return;
      return (warn as (...a: unknown[]) => void).call(process, w, ...rest);
    }) as typeof process.emitWarning;
    try {
      const mod = (await import('node:sqlite')) as { DatabaseSync: new (p: string) => DatabaseSync };
      mkdirSync(join(DATA_DIR, 'companion'), { recursive: true });
      const path = process.env.GRIDWRIGHT_STORE ?? join(DATA_DIR, 'companion', 'store.sqlite');
      store = new SqliteStore(path, mod.DatabaseSync);
      return store;
    } finally {
      process.emitWarning = warn;
    }
  })();
  return opening;
}

/** The store when it is open (after startup); throws otherwise — callers on the request path open it at start. */
export function theStore(): Store {
  if (!store) throw new Error('the store is not open (node:sqlite unavailable? Node ≥ 22.13 is required)');
  return store;
}

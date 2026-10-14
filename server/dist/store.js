// The companion's structured store: jobs, sources, recipe versions and dataset versions — what
// needs transactions, constraints and a query, as opposed to a document's state (JSON next to the
// log). One interface; the first implementation is SQLite in the data directory (node:sqlite, one
// file, WAL, part of the same backup), so that a single-node install needs no second service. A
// PostgreSQL implementation is the same interface when the layer is shared or the volumes warrant
// it. Nothing here is the authority on a document: placements still go through the operation log.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './storage.js';
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
const j = (v) => JSON.stringify(v ?? null);
const pj = (v, fallback) => {
    if (typeof v !== 'string')
        return fallback;
    try {
        return JSON.parse(v);
    }
    catch {
        return fallback;
    }
};
const s = (v) => (v === null || v === undefined ? undefined : String(v));
function jobOf(r) {
    return {
        id: String(r.id),
        type: String(r.type),
        doc: String(r.doc),
        status: String(r.status),
        input: pj(r.input, {}),
        by: pj(r.by, { id: 'api', name: 'someone' }),
        createdAt: String(r.created_at),
        startedAt: s(r.started_at),
        finishedAt: s(r.finished_at),
        heartbeatAt: s(r.heartbeat_at),
        attempts: Number(r.attempts),
        maxAttempts: Number(r.max_attempts),
        cancelRequested: s(r.cancel_requested),
        supersededAt: s(r.superseded_at),
        limits: pj(r.limits, { timeoutMs: 600_000 }),
        result: r.result ? pj(r.result, undefined) : undefined,
        error: s(r.error),
        worker: s(r.worker),
    };
}
function sourceOf(r) {
    return { id: String(r.id), doc: String(r.doc), name: String(r.name), series: String(r.series), table: r.tbl === null || r.tbl === undefined ? undefined : Number(r.tbl), kind: String(r.kind), connection: s(r.connection), sql: s(r.sql), recipe: s(r.recipe), createdAt: String(r.created_at), createdBy: String(r.created_by), updatedAt: String(r.updated_at), lastAttemptAt: s(r.last_attempt_at), lastSuccessAt: s(r.last_success_at), lastResult: s(r.last_result), lastVersion: s(r.last_version), asOf: s(r.as_of), enabled: Number(r.enabled) !== 0 };
}
function recipeOf(r) {
    return { id: String(r.id), source: String(r.source), version: Number(r.version), recipe: pj(r.recipe, {}), createdAt: String(r.created_at), createdBy: String(r.created_by), environment: pj(r.environment, {}), note: s(r.note) };
}
function datasetOf(r) {
    return { id: String(r.id), source: String(r.source), doc: String(r.doc), version: Number(r.version), period: s(r.period), hash: String(r.hash), rows: Number(r.rows), columns: Number(r.columns), recipe: s(r.recipe), intake: s(r.intake), reconciliation: pj(r.reconciliation, { ok: false, checks: [] }), status: String(r.status), createdAt: String(r.created_at), acceptedAt: s(r.accepted_at), acceptedBy: s(r.accepted_by), job: s(r.job) };
}
/** SQLite under the data directory. */
export class SqliteStore {
    db;
    constructor(path, Database) {
        this.db = new Database(path);
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
        this.db.exec(SCHEMA);
    }
    insertJob(job) {
        this.db
            .prepare('INSERT INTO jobs (id, type, doc, status, input, by, created_at, started_at, finished_at, heartbeat_at, attempts, max_attempts, cancel_requested, superseded_at, limits, result, error, worker) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(job.id, job.type, job.doc, job.status, j(job.input), j(job.by), job.createdAt, job.startedAt ?? null, job.finishedAt ?? null, job.heartbeatAt ?? null, job.attempts, job.maxAttempts, job.cancelRequested ?? null, job.supersededAt ?? null, j(job.limits), job.result ? j(job.result) : null, job.error ?? null, job.worker ?? null);
    }
    updateJob(id, patch) {
        const cols = [];
        const vals = [];
        const set = (col, v) => {
            if (v === undefined)
                return;
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
        if (patch.result !== undefined)
            set('result', j(patch.result));
        set('error', patch.error);
        set('worker', patch.worker);
        if (cols.length)
            this.db.prepare(`UPDATE jobs SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
        return this.getJob(id);
    }
    getJob(id) {
        const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
        return r ? jobOf(r) : null;
    }
    listJobs(filter = {}) {
        const where = [];
        const vals = [];
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
        const rows = this.db.prepare(`SELECT * FROM jobs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`).all(...vals, Math.min(500, Math.max(1, filter.limit ?? 50)));
        return rows.map(jobOf);
    }
    claimNext(types, worker) {
        if (!types.length)
            return null;
        const now = new Date().toISOString();
        // one statement: the oldest queued job of the types becomes running for this worker, or nothing does
        const r = this.db
            .prepare(`UPDATE jobs SET status = 'running', started_at = ?, heartbeat_at = ?, attempts = attempts + 1, worker = ? WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND type IN (${types.map(() => '?').join(', ')}) ORDER BY created_at LIMIT 1) RETURNING *`)
            .get(now, now, worker, ...types);
        return r ? jobOf(r) : null;
    }
    interruptRunning(reason) {
        const now = new Date().toISOString();
        const rows = this.db.prepare(`UPDATE jobs SET status = 'interrupted', finished_at = ?, error = ? WHERE status = 'running' RETURNING *`).all(now, `interrupted: ${reason}`);
        return rows.map(jobOf);
    }
    upsertSource(src) {
        this.db
            .prepare('INSERT INTO sources (id, doc, name, series, tbl, kind, connection, sql, recipe, created_at, created_by, updated_at, last_attempt_at, last_success_at, last_result, last_version, as_of, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, series = excluded.series, tbl = excluded.tbl, kind = excluded.kind, connection = excluded.connection, sql = excluded.sql, recipe = excluded.recipe, updated_at = excluded.updated_at, last_attempt_at = excluded.last_attempt_at, last_success_at = excluded.last_success_at, last_result = excluded.last_result, last_version = excluded.last_version, as_of = excluded.as_of, enabled = excluded.enabled')
            .run(src.id, src.doc, src.name, src.series, src.table ?? null, src.kind, src.connection ?? null, src.sql ?? null, src.recipe ?? null, src.createdAt, src.createdBy, src.updatedAt, src.lastAttemptAt ?? null, src.lastSuccessAt ?? null, src.lastResult ?? null, src.lastVersion ?? null, src.asOf ?? null, src.enabled ? 1 : 0);
    }
    getSource(id) {
        const r = this.db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
        return r ? sourceOf(r) : null;
    }
    listSources(doc) {
        return this.db.prepare('SELECT * FROM sources WHERE doc = ? ORDER BY created_at').all(doc).map(sourceOf);
    }
    deleteSourcesOf(doc) {
        const ids = this.db.prepare('SELECT id FROM sources WHERE doc = ?').all(doc).map((r) => String(r.id));
        for (const id of ids) {
            this.db.prepare('DELETE FROM recipe_versions WHERE source = ?').run(id);
            this.db.prepare('DELETE FROM dataset_versions WHERE source = ?').run(id);
        }
        this.db.prepare('DELETE FROM sources WHERE doc = ?').run(doc);
        this.db.prepare('DELETE FROM jobs WHERE doc = ?').run(doc);
        return ids.length;
    }
    insertRecipe(r) {
        this.db.prepare('INSERT INTO recipe_versions (id, source, version, recipe, created_at, created_by, environment, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(r.id, r.source, r.version, j(r.recipe), r.createdAt, r.createdBy, j(r.environment), r.note ?? null);
    }
    getRecipe(id) {
        const r = this.db.prepare('SELECT * FROM recipe_versions WHERE id = ?').get(id);
        return r ? recipeOf(r) : null;
    }
    listRecipes(source) {
        return this.db.prepare('SELECT * FROM recipe_versions WHERE source = ? ORDER BY version').all(source).map(recipeOf);
    }
    insertDataset(d) {
        this.db
            .prepare('INSERT INTO dataset_versions (id, source, doc, version, period, hash, rows, columns, recipe, intake, reconciliation, status, created_at, accepted_at, accepted_by, job) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(d.id, d.source, d.doc, d.version, d.period ?? null, d.hash, d.rows, d.columns, d.recipe ?? null, d.intake ?? null, j(d.reconciliation), d.status, d.createdAt, d.acceptedAt ?? null, d.acceptedBy ?? null, d.job ?? null);
    }
    updateDataset(id, patch) {
        const cols = [];
        const vals = [];
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
        if (cols.length)
            this.db.prepare(`UPDATE dataset_versions SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
        return this.getDataset(id);
    }
    getDataset(id) {
        const r = this.db.prepare('SELECT * FROM dataset_versions WHERE id = ?').get(id);
        return r ? datasetOf(r) : null;
    }
    listDatasets(source, limit = 50) {
        return this.db.prepare('SELECT * FROM dataset_versions WHERE source = ? ORDER BY version DESC LIMIT ?').all(source, limit).map(datasetOf);
    }
    close() {
        this.db.close();
    }
}
let store = null;
let opening = null;
/** The store, opened once: `${GRIDWRIGHT_DATA}/companion/store.sqlite` (GRIDWRIGHT_STORE names another file). */
export async function openStore() {
    if (store)
        return store;
    if (opening)
        return opening;
    opening = (async () => {
        // node:sqlite is marked experimental by Node ≥ 22.13 although its API is settled; the warning would print once per start
        const warn = process.emitWarning;
        process.emitWarning = ((w, ...rest) => {
            if (typeof w === 'string' && /SQLite is an experimental feature/.test(w))
                return;
            return warn.call(process, w, ...rest);
        });
        try {
            const mod = (await import('node:sqlite'));
            mkdirSync(join(DATA_DIR, 'companion'), { recursive: true });
            const path = process.env.GRIDWRIGHT_STORE ?? join(DATA_DIR, 'companion', 'store.sqlite');
            store = new SqliteStore(path, mod.DatabaseSync);
            return store;
        }
        finally {
            process.emitWarning = warn;
        }
    })();
    return opening;
}
/** The store when it is open (after startup); throws otherwise — callers on the request path open it at start. */
export function theStore() {
    if (!store)
        throw new Error('the store is not open (node:sqlite unavailable? Node ≥ 22.13 is required)');
    return store;
}

// Per-document operation log (audit trail) and checkpoints.
//
//   data/history/log.sqlite             every document's entries; (file, seq) is unique, so a number is
//                                       never handed out twice — not after a restart, not for a large entry
//   data/history/<fileId>/<seq>.json    document snapshots ("checkpoints") taken at saves / undo-redo
//
// The server is the single sequencer: every op accepted over the WebSocket gets the next seq,
// is appended here, and only then broadcast — so every client applies the same order.
// Logs written by earlier versions (<fileId>.ops.jsonl, one JSON entry per line) are imported on
// first use and kept aside as <fileId>.ops.jsonl.migrated.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { DATA_DIR } from './storage.js';
/** Validate a run record sent by a client (shape only; hashes are the client's statement). */
export function sanitiseRun(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const r = raw;
    const num = (k) => (Number.isFinite(Number(r[k])) ? Number(r[k]) : null);
    const table = num('table');
    const row = num('row');
    const col = num('col');
    if (table === null || row === null || col === null)
        return null;
    const hex = (k) => (typeof r[k] === 'string' && /^[0-9a-f]{8,64}$/.test(r[k]) ? r[k] : '');
    const rt = (r.runtime && typeof r.runtime === 'object' ? r.runtime : {});
    const packages = {};
    if (rt.packages && typeof rt.packages === 'object') {
        for (const [k, v] of Object.entries(rt.packages).slice(0, 200))
            packages[String(k).slice(0, 80)] = String(v).slice(0, 80);
    }
    const deps = Array.isArray(r.deps)
        ? r.deps.slice(0, 500).map((d) => ({ table: Number(d.table), r0: Number(d.r0), c0: Number(d.c0), r1: Number(d.r1), c1: Number(d.c1) })).filter((d) => [d.table, d.r0, d.c0, d.r1, d.c1].every(Number.isFinite))
        : [];
    return {
        table,
        row,
        col,
        kind: String(r.kind ?? '').slice(0, 20),
        codeHash: hex('codeHash'),
        inputsHash: hex('inputsHash'),
        deps,
        outputHash: hex('outputHash'),
        ok: !!r.ok,
        error: typeof r.error === 'string' ? r.error.slice(0, 500) : undefined,
        ms: Math.max(0, num('ms') ?? 0),
        runtime: { name: String(rt.name ?? '').slice(0, 40), version: String(rt.version ?? '').slice(0, 200), packages },
        at: typeof r.at === 'string' ? r.at.slice(0, 40) : new Date().toISOString(),
        startedAt: typeof r.startedAt === 'string' ? r.startedAt.slice(0, 40) : undefined,
    };
}
const HISTORY_DIR = () => join(DATA_DIR, 'history');
const safeId = (id) => /^[a-zA-Z0-9_-]{1,64}$/.test(id);
function cpDir(fileId) {
    return join(HISTORY_DIR(), fileId);
}
export function ensureHistoryDir() {
    mkdirSync(HISTORY_DIR(), { recursive: true });
}
// --- the log: one SQLite database ----------------------------------------------------------------
// An entry is stored as its JSON without seq and ts (those are columns); has_op and checkpoint are
// kept apart so replays and "what changed since" are index lookups, not scans of the whole log.
const SCHEMA_VERSION = 1;
let conn = null;
let q = null;
function db() {
    if (q)
        return q;
    ensureHistoryDir();
    const d = new DatabaseSync(join(HISTORY_DIR(), 'log.sqlite'));
    // an audit log: every commit reaches the disk (FULL), readers never block the writer (WAL)
    // WAL + NORMAL: a committed entry survives a crash of the server and the file is never corrupted; a power cut
    // may lose the last moments (as the earlier JSONL log could). FULL would fsync every op before it is broadcast.
    d.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;');
    d.exec(`CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY,
    file TEXT NOT NULL,
    seq INTEGER NOT NULL,
    ts TEXT NOT NULL,
    has_op INTEGER NOT NULL,
    checkpoint INTEGER NOT NULL,
    entry TEXT NOT NULL,
    UNIQUE (file, seq)
  )`);
    const v = Number(d.prepare('PRAGMA user_version').get().user_version);
    if (v > SCHEMA_VERSION)
        throw new Error(`the history log (${join(HISTORY_DIR(), 'log.sqlite')}) is from a newer Gridwright (schema ${v}; this one knows ${SCHEMA_VERSION})`);
    if (v < SCHEMA_VERSION)
        d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    conn = d;
    q = {
        head: d.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM entries WHERE file = ?'),
        // the number is taken inside the insert, under SQLite's write lock: two writers cannot get the same one
        insert: d.prepare('INSERT INTO entries (file, seq, ts, has_op, checkpoint, entry) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM entries WHERE file = ?), ?, ?, ?, ?) RETURNING seq'),
        since: d.prepare('SELECT seq, ts, entry FROM entries WHERE file = ? AND seq > ? ORDER BY seq LIMIT ?'),
        recent: d.prepare('SELECT seq, ts, entry FROM entries WHERE file = ? AND seq < ? ORDER BY seq DESC LIMIT ?'),
        all: d.prepare('SELECT seq, ts, entry FROM entries WHERE file = ? ORDER BY seq'),
        ops: d.prepare('SELECT seq, ts, entry FROM entries WHERE file = ? AND seq > ? AND seq <= ? AND has_op = 1 ORDER BY seq'),
        changes: d.prepare('SELECT COUNT(*) AS n FROM entries WHERE file = ? AND seq > ? AND (has_op = 1 OR checkpoint = 1)'),
        del: d.prepare('DELETE FROM entries WHERE file = ?'),
        has: d.prepare('SELECT 1 AS x FROM entries WHERE file = ? LIMIT 1'),
    };
    importLegacyLogs(d);
    return q;
}
function toEntry(r) {
    return { seq: Number(r.seq), ts: r.ts, ...JSON.parse(r.entry) };
}
function stored(e) {
    const { seq: _s, ts: _t, ...rest } = e;
    return JSON.stringify(rest);
}
/**
 * Import the logs of earlier versions (<id>.ops.jsonl): every readable line, in file order. A number
 * that is not above the previous one — the restart bug handed numbers out again — gets the next free
 * number and a note saying what it was. Checkpoint files keep their names. The old file is renamed
 * <id>.ops.jsonl.migrated (kept, not deleted). One transaction per document: all of it or none.
 */
function importLegacyLogs(d) {
    let names = [];
    try {
        names = readdirSync(HISTORY_DIR()).filter((n) => n.endsWith('.ops.jsonl'));
    }
    catch {
        return;
    }
    for (const name of names) {
        const fileId = name.slice(0, -'.ops.jsonl'.length);
        const path = join(HISTORY_DIR(), name);
        if (!safeId(fileId))
            continue;
        let renumbered = 0;
        let imported = 0;
        let skipped = 0;
        d.exec('BEGIN IMMEDIATE');
        try {
            // a previous start that imported but could not rename: the rows are there, only the rename is left
            if (!q.has.get(fileId)) {
                const put = d.prepare('INSERT INTO entries (file, seq, ts, has_op, checkpoint, entry) VALUES (?, ?, ?, ?, ?, ?)');
                let last = 0;
                for (const line of readFileSync(path, 'utf8').split('\n')) {
                    if (!line.trim())
                        continue;
                    let e;
                    try {
                        e = JSON.parse(line);
                    }
                    catch {
                        skipped++; // a torn or damaged line
                        continue;
                    }
                    if (!e || typeof e !== 'object') {
                        skipped++;
                        continue;
                    }
                    let seq = Number(e.seq);
                    if (!Number.isInteger(seq) || seq <= last) {
                        const was = Number.isFinite(seq) ? String(seq) : 'none';
                        seq = last + 1;
                        e.note = `${e.note ? `${e.note} ` : ''}(renumbered from ${was} when the log moved to SQLite)`.slice(0, 400);
                        renumbered++;
                    }
                    last = seq;
                    put.run(fileId, seq, typeof e.ts === 'string' ? e.ts : new Date(0).toISOString(), e.op ? 1 : 0, e.checkpoint ? 1 : 0, stored(e));
                    imported++;
                }
            }
            d.exec('COMMIT');
        }
        catch (err) {
            d.exec('ROLLBACK');
            console.error(`history: could not import ${name}: ${err.message} — left as it is`);
            continue;
        }
        try {
            renameSync(path, `${path}.migrated`);
        }
        catch (err) {
            if (err.code !== 'ENOENT')
                console.error(`history: imported ${name} but could not rename it: ${err.message}`);
        }
        if (imported || renumbered || skipped)
            console.log(`history: imported ${imported} entr${imported === 1 ? 'y' : 'ies'} of ${fileId}${renumbered ? `, ${renumbered} renumbered (numbers used twice by an earlier version)` : ''}${skipped ? `, ${skipped} unreadable line${skipped === 1 ? '' : 's'} skipped` : ''}`);
    }
}
/** Close the log (tests; a clean shutdown). */
export function closeHistory() {
    conn?.close();
    conn = null;
    q = null;
}
/** Highest seq in the log (0 when empty). */
export function currentSeq(fileId) {
    if (!safeId(fileId))
        return 0;
    return Number(db().head.get(fileId).seq);
}
/** Append an entry; returns the assigned seq. */
const appendListeners = new Set();
/** Be told of every appended entry (the companion re-checks a document after it changes). */
export function onAppend(fn) {
    appendListeners.add(fn);
    return () => appendListeners.delete(fn);
}
export function appendEntry(fileId, entry) {
    if (!safeId(fileId))
        throw new Error('bad file id');
    const ts = new Date().toISOString();
    const row = db().insert.get(fileId, fileId, ts, entry.op ? 1 : 0, entry.checkpoint ? 1 : 0, stored(entry));
    const seq = Number(row.seq);
    const full = { seq, ts, ...entry };
    for (const fn of appendListeners) {
        try {
            fn(fileId, full);
        }
        catch (e) {
            console.error('append listener failed:', e.message);
        }
    }
    return seq;
}
/** Entries with seq > since (ascending), capped. */
export function entriesSince(fileId, since, limit = 5000) {
    if (!safeId(fileId))
        return [];
    return db().since.all(fileId, since, limit).map(toEntry);
}
/** How many entries that change the content (ops, checkpoints) come after `since` — runs and notes do not count. */
export function contentChangesSince(fileId, since) {
    if (!safeId(fileId))
        return 0;
    return Number(db().changes.get(fileId, since).n);
}
/** Most recent entries (descending), optionally before a seq. */
export function recentEntries(fileId, limit = 200, before) {
    if (!safeId(fileId))
        return [];
    return db().recent.all(fileId, before ? before : Number.MAX_SAFE_INTEGER, limit).map(toEntry);
}
export function readAll(fileId) {
    if (!safeId(fileId))
        return [];
    return db().all.all(fileId).map(toEntry);
}
/** Write a checkpoint of the document as of `seq` (idempotent per seq). */
export function writeCheckpoint(fileId, seq, json) {
    if (!safeId(fileId))
        return;
    const dir = cpDir(fileId);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${seq}.json`);
    if (existsSync(p))
        return;
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, json);
    renameSync(tmp, p);
    pruneCheckpoints(fileId);
}
export function checkpointSeqs(fileId) {
    const dir = cpDir(fileId);
    if (!safeId(fileId) || !existsSync(dir))
        return [];
    return readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => Number(f.slice(0, -5)))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b);
}
const DAY = 86_400_000;
/**
 * Checkpoint retention: everything from the last 24 h, one per day for 30 days, one per week
 * after that, and always the first and the latest. Ages come from the files' mtimes.
 */
export function compactCheckpoints(fileId, now = Date.now()) {
    const seqs = checkpointSeqs(fileId);
    if (seqs.length <= 2)
        return [];
    const dir = cpDir(fileId);
    const aged = seqs.map((seq) => {
        let age = 0;
        try {
            age = now - statSync(join(dir, `${seq}.json`)).mtimeMs;
        }
        catch {
            /* treat as new */
        }
        return { seq, age };
    });
    const keep = new Set([seqs[0], seqs[seqs.length - 1]]);
    const buckets = new Set();
    // newest first so the most recent checkpoint of each day / week is the one kept
    for (const { seq, age } of [...aged].sort((a, b) => a.age - b.age)) {
        if (age < DAY) {
            keep.add(seq);
            continue;
        }
        const key = age < 30 * DAY ? `d${Math.floor(age / DAY)}` : `w${Math.floor(age / (7 * DAY))}`;
        if (!buckets.has(key)) {
            buckets.add(key);
            keep.add(seq);
        }
    }
    const dropped = [];
    for (const s of seqs) {
        if (keep.has(s))
            continue;
        try {
            unlinkSync(join(dir, `${s}.json`));
            dropped.push(s);
        }
        catch {
            /* ignore */
        }
    }
    return dropped;
}
function pruneCheckpoints(fileId) {
    compactCheckpoints(fileId);
}
/** Audit trail as CSV (one line per log entry). */
export function historyCsv(fileId) {
    const esc = (v) => {
        const s = v === undefined || v === null ? '' : String(v);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = ['seq,timestamp,author,login,origin,type,table,range,detail,note'];
    for (const e of readAll(fileId)) {
        if (e.run) {
            const r = e.run;
            const pk = Object.entries(r.runtime?.packages ?? {}).map(([k, v]) => `${k}=${v}`).join(' ');
            lines.push([e.seq, e.ts, e.author?.name ?? '', e.author?.login ?? '', e.origin, 'code_run', r.table, a1(r.row, r.col), `${r.kind} ${r.ok ? 'ok' : 'failed'} ${r.ms} ms; code ${r.codeHash}; inputs ${r.inputsHash}; output ${r.outputHash}; ${r.runtime?.name} ${r.runtime?.version}${pk ? '; ' + pk : ''}${r.error ? '; ' + r.error : ''}`, e.note ?? ''].map(esc).join(','));
            continue;
        }
        const op = e.op ?? {};
        const type = e.checkpoint && !e.op ? 'checkpoint' : String(op.type ?? '');
        const d = describeOp(op);
        lines.push([e.seq, e.ts, e.author?.name ?? '', e.author?.login ?? '', e.origin, type, op.table ?? '', d.range, d.detail, e.note ?? ''].map(esc).join(','));
    }
    return lines.join('\n') + '\n';
}
export function colLetters(col) {
    let s = '';
    let c = col + 1;
    while (c > 0) {
        const r = (c - 1) % 26;
        s = String.fromCharCode(65 + r) + s;
        c = Math.floor((c - 1) / 26);
    }
    return s;
}
const a1 = (r, c) => `${colLetters(Number(c))}${Number(r) + 1}`;
/** Human-readable range and detail of an op (for the CSV and the history panel). */
export function describeOp(op) {
    const n = (k) => Number(op[k]);
    const rect = () => `${a1(op.r0, op.c0)}:${a1(op.r1, op.c1)}`;
    switch (op.type) {
        case 'set_cell':
            return { range: a1(op.row, op.col), detail: String(op.input ?? '').slice(0, 500) };
        case 'set_cells': {
            const values = op.values ?? [];
            const cols = Math.max(1, ...values.map((r) => r.length));
            return { range: `${a1(op.row, op.col)}:${a1(n('row') + values.length - 1, n('col') + cols - 1)}`, detail: `${values.length}×${cols} values` };
        }
        case 'clear_range':
            return { range: rect(), detail: 'cleared' };
        case 'set_format':
            return { range: rect(), detail: JSON.stringify(op.format ?? {}).slice(0, 300) };
        case 'insert_rows':
        case 'delete_rows':
            return { range: `row ${n('at') + 1}`, detail: `${op.count} row(s)` };
        case 'insert_cols':
        case 'delete_cols':
            return { range: `column ${colLetters(n('at'))}`, detail: `${op.count} column(s)` };
        case 'add_table':
            return { range: '', detail: `${op.name ?? 'table'} ${op.rows}×${op.cols}` };
        case 'rename_table':
            return { range: '', detail: `→ ${op.name}` };
        case 'add_signoff':
            return { range: rect(), detail: `${op.by ?? ''}${op.locked ? ' (locked)' : ''}${op.note ? ': ' + op.note : ''}` };
        case 'remove_signoff':
            return { range: '', detail: `sign-off #${op.id} removed` };
        case 'set_signoff_locked':
            return { range: '', detail: `sign-off #${op.id} ${op.locked ? 'locked' : 'unlocked'}` };
        case 'merge_cells':
        case 'unmerge_cells':
            return { range: rect(), detail: op.type === 'merge_cells' ? 'merged' : 'unmerged' };
        case 'add_chart':
        case 'update_chart': {
            const c = op.chart ?? {};
            return { range: '', detail: `${c.kind ?? 'chart'}: ${String(c.title ?? '').slice(0, 120)}` };
        }
        case 'delete_chart':
            return { range: '', detail: `chart #${op.id} deleted` };
        case 'set_name':
            return { range: '', detail: `${op.name} = ${op.reference ?? '(removed)'}` };
        case 'restore_cells':
            return { range: '', detail: `${op.cells?.length ?? 0} cell(s) restored (undo/redo)` };
        case 'restore_tables':
            return { range: '', detail: `${op.tables?.length ?? 0} table(s) restored (undo/redo)` };
        case 'set_metric': {
            // governed metric (7.5): the definition in words, so the audit trail says what every number using it means
            const m = op.metric;
            if (!m)
                return { range: '', detail: `metric ${op.name} removed` };
            const s = m.measure ?? {};
            const what = s.agg === 'ratio' ? `ratio ${s.numerator} / ${s.denominator}` : `${s.agg || 'sum'}${s.field ? ` of ${s.field}` : ''}`;
            const extra = [s.currency ? `currency column ${s.currency}` : '', m.currency ? `reporting ${m.currency}` : '', m.format ? `format ${m.format}` : ''].filter(Boolean).join('; ');
            return { range: '', detail: `metric ${op.name} = ${what} on ${m.table ?? ''}${extra ? `; ${extra}` : ''}`.slice(0, 300) };
        }
        case 'rename_metric':
            return { range: '', detail: `metric ${op.name} renamed to ${op.to}` };
        case 'restore_metrics':
            return { range: '', detail: `${op.metrics?.length ?? 0} metric(s) restored (undo/redo)` };
        default:
            return { range: '', detail: '' };
    }
}
/** Latest checkpoint at or before `seq` plus the ops after it, for client-side replay. */
export function replayBundle(fileId, seq) {
    const seqs = checkpointSeqs(fileId).filter((s) => s <= seq);
    const cp = seqs.length ? seqs[seqs.length - 1] : 0;
    const json = cp ? readFileSync(join(cpDir(fileId), `${cp}.json`), 'utf8') : null;
    const ops = safeId(fileId) ? db().ops.all(fileId, cp, seq).map(toEntry) : [];
    if (!json && cp === 0 && !checkpointSeqs(fileId).length && ops.length === 0)
        return null;
    return { checkpointSeq: cp, json, ops };
}
/** Does an op touch a given cell? (used for per-cell history) */
export function opTouchesCell(op, table, row, col) {
    if (op.table !== table && op.type !== 'add_table' && op.type !== 'restore_cells' && op.type !== 'restore_tables')
        return false;
    if (op.type === 'restore_tables')
        return (op.tables ?? []).some((t) => t.id === table);
    const num = (k) => Number(op[k]);
    switch (op.type) {
        case 'set_cell':
        case 'code_result':
            return num('row') === row && num('col') === col;
        case 'set_cells': {
            const values = op.values;
            const r0 = num('row');
            const c0 = num('col');
            const rows = values?.length ?? 0;
            const cols = Math.max(0, ...(values ?? []).map((r) => r.length));
            return row >= r0 && row < r0 + rows && col >= c0 && col < c0 + cols;
        }
        case 'clear_range':
        case 'set_format':
            return row >= num('r0') && row <= num('r1') && col >= num('c0') && col <= num('c1');
        case 'insert_rows':
        case 'delete_rows':
            return row >= num('at');
        case 'insert_cols':
        case 'delete_cols':
            return col >= num('at');
        case 'resize_table':
        case 'delete_table':
        case 'set_pivot':
        case 'restore_tables':
            return true;
        case 'merge_cells':
        case 'unmerge_cells':
        case 'add_signoff':
            return row >= num('r0') && row <= num('r1') && col >= num('c0') && col <= num('c1');
        case 'restore_cells':
            return (op.cells ?? []).some((c) => c.table === table && c.row === row && c.col === col);
        default:
            return false;
    }
}
export function deleteHistory(fileId) {
    if (!safeId(fileId))
        return;
    db().del.run(fileId);
    const dir = cpDir(fileId);
    if (existsSync(dir)) {
        for (const f of readdirSync(dir)) {
            try {
                unlinkSync(join(dir, f));
            }
            catch {
                /* ignore */
            }
        }
    }
}

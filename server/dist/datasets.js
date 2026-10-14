// Datasets: a file brought in for a guided import, kept per client with its original, its raw tables,
// its profile and every run of its recipe. The heavy work (reading, profiling, running, relating)
// happens in worker threads under a memory ceiling and a deadline; the main thread keeps the
// metadata, the jobs and their progress, places outputs in a document through the log, and answers
// "how was this made?" for any placed table or row.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { addRecord } from './companion.js';
import { openDocument, tableMetas } from './headless.js';
import { appendEntry, writeCheckpoint } from './history.js';
import { actionsToOps } from './proposals.js';
import { DATA_DIR, DEFAULT_TENANT, readFile, writeFile } from './storage.js';
import { describe, readsOf, STAGE_OF, StepSchema } from './dssteps.js';
import { getRecipe, matchRecipes, recordUse } from './recipes.js';
export const MAX_DATASET_BYTES = Math.max(1, Number(process.env.GRIDWRIGHT_DATASET_MAX_MB) || 100) * 1024 * 1024;
const LIMITS = { maxRows: Math.max(1000, Number(process.env.GRIDWRIGHT_DATASET_MAX_ROWS) || 2_000_000), maxCols: 256, maxInflated: Math.max(64, Number(process.env.GRIDWRIGHT_DATASET_MAX_INFLATED_MB) || 1024) * 1024 * 1024 };
const HEAP_MB = Math.max(256, Number(process.env.GRIDWRIGHT_DATASET_HEAP_MB) || 1536);
const JOB_MS = Math.max(30, Number(process.env.GRIDWRIGHT_DATASET_TIMEOUT_S) || 900) * 1000;
const PREVIEW_MS = 30_000;
const MAX_WORKERS = Math.max(1, Number(process.env.GRIDWRIGHT_DATASET_WORKERS) || 2);
const KEEP_RUNS = 5;
/** rows placed per output: a fact table is browsed in the import view; the workbook gets the first rows */
export const PLACE_MAX_ROWS = 50_000;
export const PLACE_DEFAULT_ROWS = 10_000;
const now = () => new Date().toISOString();
const ID = /^[a-f0-9]{12}$/;
const safeTenant = (t) => (/^[a-zA-Z0-9_-]{1,64}$/.test(t) ? t : DEFAULT_TENANT);
const root = (tenant) => join(DATA_DIR, 'datasets', safeTenant(tenant));
const dirOf = (tenant, id) => {
    if (!ID.test(id))
        throw new Error('no such dataset');
    return join(root(tenant), id);
};
const metaPath = (tenant, id) => join(dirOf(tenant, id), 'meta.json');
export const rawPath = (tenant, id) => join(dirOf(tenant, id), 'raw.sqlite');
const runDb = (tenant, id, run) => {
    if (!ID.test(run))
        throw new Error('no such run');
    return join(dirOf(tenant, id), 'runs', `${run}.sqlite`);
};
const runJson = (tenant, id, run) => join(dirOf(tenant, id), 'runs', `${run}.json`);
const mergeDb = (tenant, id, merge) => {
    if (!ID.test(merge))
        throw new Error('no such merge');
    return join(dirOf(tenant, id), 'merges', `${merge}.sqlite`);
};
function writeJson(path, v) {
    writeFileSync(`${path}.tmp`, JSON.stringify(v), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
}
export function readMeta(tenant, id) {
    try {
        return JSON.parse(readFileSync(metaPath(tenant, id), 'utf8'));
    }
    catch {
        return null;
    }
}
function writeMeta(m) {
    writeJson(metaPath(m.tenant, m.id), m);
    placementIndex.delete(m.tenant);
}
function mustMeta(tenant, id) {
    const m = readMeta(tenant, id);
    if (!m)
        throw new Error('no such dataset');
    return m;
}
export function readProfiles(tenant, id) {
    try {
        return JSON.parse(readFileSync(join(dirOf(tenant, id), 'profile.json'), 'utf8'));
    }
    catch {
        return { profiles: [], proposal: null };
    }
}
export function readRun(tenant, id, run) {
    try {
        return JSON.parse(readFileSync(runJson(tenant, id, run), 'utf8'));
    }
    catch {
        return null;
    }
}
export function listDatasets(tenant) {
    const r = root(tenant);
    if (!existsSync(r))
        return [];
    return readdirSync(r)
        .filter((d) => ID.test(d))
        .map((d) => readMeta(tenant, d))
        .filter((m) => !!m)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
// ------------------------------------------------------------------ workers and jobs
const jobs = new Map();
const queue = [];
let running = 0;
function workerFile() {
    const js = new URL('./dsworker.js', import.meta.url);
    return existsSync(fileURLToPath(js)) ? js : new URL('./dsworker.ts', import.meta.url);
}
/** One task in its own worker: memory-capped, killed at the deadline. */
function inWorker(task, ms, onProgress) {
    return new Promise((resolve, reject) => {
        const w = new Worker(workerFile(), { workerData: task, resourceLimits: { maxOldGenerationSizeMb: HEAP_MB, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 }, execArgv: process.execArgv.filter((a) => !a.startsWith('--max-old-space-size')) });
        let settled = false;
        const done = (fn) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            void w.terminate();
            fn();
        };
        const timer = setTimeout(() => done(() => reject(new Error(`the task took longer than ${Math.round(ms / 1000)} s and was stopped`))), ms);
        w.on('message', (m) => {
            if (m.progress)
                return onProgress?.(m.progress);
            done(() => (m.ok ? resolve(m.out) : reject(new Error(m.error || 'the task failed'))));
        });
        w.on('error', (e) => done(() => reject(/ERR_WORKER_OUT_OF_MEMORY|heap/i.test(String(e)) ? new Error('the file needs more memory than a task is allowed; split it or raise GRIDWRIGHT_DATASET_HEAP_MB') : e)));
        w.on('exit', (code) => done(() => reject(new Error(`the task stopped (exit ${code})`))));
    });
}
function slot(fn) {
    return new Promise((resolve, reject) => {
        const start = () => {
            running++;
            fn()
                .then(resolve, reject)
                .finally(() => {
                running--;
                queue.shift()?.();
            });
        };
        if (running < MAX_WORKERS)
            start();
        else
            queue.push(start);
    });
}
function startJob(tenant, dataset, kind, fn, after) {
    // one heavy job per dataset at a time
    for (const j of jobs.values())
        if (j.tenant === tenant && j.dataset === dataset && (j.status === 'queued' || j.status === 'running'))
            throw new Error(`a ${j.kind} job is already running on this dataset`);
    const job = { id: randomBytes(6).toString('hex'), tenant, dataset, kind, status: 'queued', startedAt: now() };
    jobs.set(job.id, job);
    void slot(async () => {
        job.status = 'running';
        try {
            job.result = await fn(job);
            job.status = 'done';
        }
        catch (e) {
            job.status = 'failed';
            job.error = e?.message ?? String(e);
        }
        finally {
            job.endedAt = now();
            try {
                after?.(job);
            }
            catch (e) {
                console.error('after-job step failed:', e.message);
            }
            // finished jobs are kept for an hour for the person who started them
            setTimeout(() => jobs.delete(job.id), 3600_000).unref();
        }
    });
    return job;
}
export function jobOf(tenant, id) {
    const j = jobs.get(id);
    return j && j.tenant === tenant ? j : null;
}
export function activeJobs(tenant, dataset) {
    return [...jobs.values()].filter((j) => j.tenant === tenant && j.dataset === dataset && (j.status === 'queued' || j.status === 'running'));
}
const progressInto = (job) => (p) => {
    job.phase = p.phase;
    job.done = p.done;
    job.of = p.of;
};
// ------------------------------------------------------------------ bringing a file in
const EXT = /\.(xlsx|xlsm|csv|tsv|txt)$/i;
export function createDataset(tenant, by, fileName, buf) {
    const file = fileName.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f]/g, '').slice(0, 200) || 'file';
    const m = EXT.exec(file);
    if (!m)
        throw new Error('bring an .xlsx, .xlsm, .csv, .tsv or .txt file (an old .xls workbook: save it as .xlsx first)');
    if (!buf.length)
        throw new Error('the file is empty');
    if (buf.length > MAX_DATASET_BYTES)
        throw new Error(`the file is larger than ${Math.round(MAX_DATASET_BYTES / 1048576)} MB`);
    const ext = m[1].toLowerCase();
    const xlsx = ext === 'xlsx' || ext === 'xlsm';
    if (xlsx && !(buf[0] === 0x50 && buf[1] === 0x4b))
        throw new Error('this is not an Excel workbook (.xlsx is a zip file)');
    const id = randomBytes(6).toString('hex');
    const dir = dirOf(tenant, id);
    mkdirSync(join(dir, 'runs'), { recursive: true, mode: 0o700 });
    const src = join(dir, `source.${ext}`);
    writeFileSync(src, buf, { mode: 0o600 });
    const meta = { id, tenant, name: file.replace(EXT, ''), file, ext, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), createdAt: now(), createdBy: by.name || by.login || 'someone', status: 'reading', sheets: [], runs: [], placements: [], merges: [] };
    writeMeta(meta);
    const job = startJob(tenant, id, 'read', async (j) => {
        try {
            const out = await inWorker({ task: 'read', src, kind: xlsx ? 'xlsx' : 'delimited', raw: rawPath(tenant, id), limits: LIMITS }, JOB_MS, progressInto(j));
            writeJson(join(dir, 'profile.json'), { profiles: out.profiles, proposal: out.proposal });
            const mm = mustMeta(tenant, id);
            mm.status = 'ready';
            mm.sheets = out.sheets;
            mm.encoding = out.encoding;
            mm.delimiter = out.delimiter;
            if (out.proposal)
                mm.draft = { steps: out.proposal.steps, roles: out.proposal.roles, at: now(), by: 'proposer' };
            // a saved recipe for this layout: its steps (adapted to this file) replace the proposal
            const h0 = out.proposal?.steps[0];
            const main = h0 && h0.type === 'header' ? out.profiles.find((p) => p.index === h0.sheet) : out.profiles[0];
            const best = main ? matchRecipes(tenant, main)[0] : undefined;
            if (best) {
                const rec = getRecipe(tenant, best.recipe);
                mm.match = { recipe: best.recipe, version: best.version, name: best.name, score: best.score, summary: best.summary.slice(0, 12), blocked: best.blocked.length, auto: !!rec?.auto };
                const v = rec?.versions.find((x) => x.version === best.version);
                mm.draft = { steps: best.steps, roles: v?.roles ?? mm.draft?.roles ?? {}, at: now(), by: `recipe ${best.name} v${best.version}`, recipe: { id: best.recipe, version: best.version } };
            }
            writeMeta(mm);
            return { sheets: out.sheets.length, rows: out.sheets.reduce((a, s) => a + s.rows, 0) };
        }
        catch (e) {
            const mm = mustMeta(tenant, id);
            mm.status = 'failed';
            mm.error = e?.message ?? String(e);
            writeMeta(mm);
            throw e;
        }
    }, (j) => {
        // an automatic recipe that fits closely runs at once (the person still reviews and places it)
        if (j.status !== 'done')
            return;
        const mm = readMeta(tenant, id);
        if (!mm?.match?.auto || mm.match.score < 0.9 || mm.match.blocked || mm.match.summary.some((s) => s.level === 'error') || !mm.draft)
            return;
        runFull(tenant, id, by, mm.draft.steps, mm.draft.roles, mm.draft.recipe);
        mm.match.ran = true;
        writeMeta(mm);
    });
    return { dataset: meta, job };
}
export function deleteDataset(tenant, id) {
    // only this client's datasets: an unknown id (or another client's) is not quietly “deleted”
    mustMeta(tenant, id);
    if (activeJobs(tenant, id).length)
        throw new Error('a job is running on this dataset');
    rmSync(dirOf(tenant, id), { recursive: true, force: true });
    placementIndex.delete(tenant);
}
export function renameDataset(tenant, id, name) {
    const m = mustMeta(tenant, id);
    m.name = name.trim().slice(0, 120) || m.name;
    writeMeta(m);
    return m;
}
export function sourcePath(tenant, id) {
    const m = mustMeta(tenant, id);
    return join(dirOf(tenant, id), `source.${m.ext}`);
}
// ------------------------------------------------------------------ steps: draft, preview, run
function validSteps(steps) {
    if (!Array.isArray(steps) || !steps.length)
        throw new Error('a recipe needs steps');
    if (steps.length > 120)
        throw new Error('at most 120 steps');
    const out = steps.map((s, i) => {
        const r = StepSchema.safeParse(s);
        if (!r.success)
            throw new Error(`step ${i + 1}: ${r.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('; ')}`);
        return r.data;
    });
    if (out[0].type !== 'header')
        throw new Error('the first step reads the header');
    const ids = new Set();
    for (const s of out) {
        if (ids.has(s.id))
            throw new Error(`two steps are called ${s.id}`);
        ids.add(s.id);
    }
    return out;
}
export function saveDraft(tenant, id, by, steps, roles, recipe) {
    const m = mustMeta(tenant, id);
    m.draft = { steps: validSteps(steps), roles, at: now(), by: by.name || by.login || 'someone', recipe: recipe ?? m.draft?.recipe };
    writeMeta(m);
    return m;
}
/** The steps on the first rows: what the data looks like after each change, in about a second. */
let previews = 0;
/** Each step in plain words, with the column labels known at that point (the timeline and the audit). */
export function describeSteps(steps) {
    const label = new Map();
    return steps.map((s) => {
        if (s.type === 'header')
            s.columns.forEach((c) => label.set(c.key, c.label));
        const into = s.into;
        if (into)
            label.set(into.key, into.label);
        const g = s.groupInto;
        if (g)
            label.set(g.key, g.label);
        if (s.type === 'rename')
            label.set(s.column, s.label);
        return { id: s.id, text: describe(s, (k) => label.get(k) ?? k), stage: s.stage ?? STAGE_OF[s.type] };
    });
}
export async function preview(tenant, id, steps, sample = 3000) {
    const m = mustMeta(tenant, id);
    if (m.status !== 'ready')
        throw new Error(m.status === 'reading' ? 'the file is still being read' : 'the file could not be read');
    if (previews >= 4)
        throw new Error('the server is busy with other previews; try again in a moment');
    previews++;
    try {
        const valid = validSteps(steps);
        const out = await inWorker({ task: 'run', raw: rawPath(tenant, id), out: null, steps: valid, sheets: m.sheets, sample: Math.min(20_000, Math.max(100, sample)), preview: 25 }, PREVIEW_MS);
        return { ...out, described: describeSteps(valid) };
    }
    finally {
        previews--;
    }
}
/** Run the steps on every row, keep the run (the last five), then compute its insights. */
export function runFull(tenant, id, by, stepsIn, roles, recipe) {
    const m = mustMeta(tenant, id);
    if (m.status !== 'ready')
        throw new Error('the file is not ready');
    const steps = validSteps(stepsIn);
    return startJob(tenant, id, 'run', async (job) => {
        const run = randomBytes(6).toString('hex');
        const out = await inWorker({ task: 'run', raw: rawPath(tenant, id), out: runDb(tenant, id, run), steps, sheets: m.sheets, preview: 25 }, JOB_MS, progressInto(job));
        const meta = { id: run, at: now(), by: by.name || by.login || 'someone', ok: out.ok, failedAt: out.failedAt, rows: out.rows, ms: out.ms, unit: out.unit, steps, roles, recipe, outputs: out.outputs, checks: out.checks, results: out.results, columns: out.columns };
        if (out.ok) {
            job.phase = 'insights';
            try {
                meta.insights = await inWorker({ task: 'insights', run: runDb(tenant, id, run), roles, unit: out.unit }, 120_000);
            }
            catch (e) {
                console.error('insights failed:', e.message);
                meta.insightsError = e.message.slice(0, 300);
            }
        }
        writeJson(runJson(tenant, id, run), meta);
        const mm = mustMeta(tenant, id);
        const { results: _r, steps: _s, insights: _i, columns: _c, ...summary } = meta;
        mm.runs.unshift(summary);
        mm.draft = { steps, roles, at: now(), by: meta.by, recipe };
        // older runs go, unless a placed table still points at them
        const keep = new Set(mm.placements.map((p) => p.run));
        for (const old of mm.runs.slice(KEEP_RUNS)) {
            if (keep.has(old.id))
                continue;
            rmSync(runDb(tenant, id, old.id), { force: true });
            rmSync(runJson(tenant, id, old.id), { force: true });
        }
        mm.runs = mm.runs.filter((r, i) => i < KEEP_RUNS || keep.has(r.id));
        writeMeta(mm);
        if (recipe)
            recordUse(tenant, recipe.id, { dataset: id, file: mm.file, run, at: meta.at, version: recipe.version, ok: out.ok, rows: out.rows, score: 1 });
        return { run, ok: out.ok, rows: out.rows, failedAt: out.failedAt };
    });
}
function openRun(path) {
    if (!existsSync(path))
        throw new Error('this run is no longer kept');
    return new DatabaseSync(path, { readOnly: true });
}
const TABLE = /^(work|out_[a-z][a-z0-9_]{0,62}|_issues|_removed|_checks)$/;
/** A page of a run's table, with the column descriptions. */
export function pageOfRun(tenant, id, run, table, offset, limit, filter) {
    if (!TABLE.test(table))
        throw new Error('no such table');
    const db = openRun(runDb(tenant, id, run));
    try {
        if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table))
            throw new Error('no such table in this run');
        const cols = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((c) => c.name);
        const args = [];
        let where = '';
        if (filter && cols.includes(filter.column)) {
            where = ` WHERE "${filter.column}" = ?`;
            args.push(filter.value);
        }
        const st = db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${table}"${where} LIMIT ? OFFSET ?`);
        st.setReturnArrays(true);
        const rows = st.all(...args, Math.min(500, Math.max(1, limit)), Math.max(0, offset));
        const total = Number(db.prepare(`SELECT count(*) n FROM "${table}"${where}`).get(...args).n);
        return { columns: cols, rows, total };
    }
    finally {
        db.close();
    }
}
/** Every issue of a run (rejected values, failed checks), a page at a time, optionally for one step. */
export function issuesOf(tenant, id, run, step, offset, limit) {
    const db = openRun(runDb(tenant, id, run));
    try {
        const where = step ? 'WHERE step = ?' : '';
        const args = step ? [step] : [];
        const rows = db.prepare(`SELECT step, kind, severity, row, col, value, detail FROM _issues ${where} ORDER BY row LIMIT ? OFFSET ?`).all(...args, Math.min(500, limit), offset);
        const total = db.prepare(`SELECT count(*) n FROM _issues ${where}`).get(...args).n;
        const removed = db.prepare(`SELECT count(*) n FROM _removed`).get().n;
        return { rows, total, removed };
    }
    finally {
        db.close();
    }
}
// ------------------------------------------------------------------ placing outputs in a document
const letters = (c) => {
    let s = '';
    let n = c;
    for (;;) {
        s = String.fromCharCode(65 + (n % 26)) + s;
        if (n < 26)
            break;
        n = Math.floor(n / 26) - 1;
    }
    return s;
};
const formatOf = (c) => {
    if (c.type === 'date')
        return 'yyyy-mm-dd';
    if (c.type !== 'number')
        return null;
    if (c.unit === '%')
        return '0.0%';
    if (c.unit === 'AOA' || c.unit === 'Kz')
        return '#,##0.00 "Kz"';
    if (c.unit === 'EUR' || c.unit === '€')
        return '€#,##0.00';
    if (c.unit === 'USD' || c.unit === '$')
        return '$#,##0.00';
    if (c.unit)
        return '#,##0.00';
    return null;
};
export function placeOutputs(tenant, id, run, doc, by, keys, notify, maxRows = PLACE_DEFAULT_ROWS, from) {
    const cap = Math.max(1, Math.min(PLACE_MAX_ROWS, Math.floor(maxRows)));
    const m = mustMeta(tenant, id);
    // the tables come from a run, or from a merge analysis made on this dataset
    const mg = from ? m.merges.find((x) => x.id === from.merge) : undefined;
    if (from && !mg)
        throw new Error('no such merge');
    if (mg && !existsSync(mergeDb(tenant, id, mg.id)))
        throw new Error('this analysis is no longer stored: run it again');
    run = mg ? (mg.run ?? m.runs.find((x) => x.ok)?.id) : run;
    if (!run)
        throw new Error('place a finished run');
    const r = readRun(tenant, id, run);
    if (!mg && (!r || !r.ok))
        throw new Error('place a finished run');
    const vs = mg ? ` (vs ${mg.otherName})` : '';
    const available = mg
        ? mg.result.tables.map((x) => ({ key: x.key, label: `${x.label}${vs}`, role: 'analysis', rows: x.rows, columns: x.columns, place: true, step: '' }))
        : r.outputs;
    const chosen = available.filter((o) => keys.includes(o.key));
    if (!chosen.length)
        throw new Error('choose at least one output');
    const db = openRun(mg ? mergeDb(tenant, id, mg.id) : runDb(tenant, id, run));
    // one open of the document: names are checked, ops translated and applied on the same book
    const { book } = openDocument(doc);
    const metas = tableMetas(book);
    const actions = [];
    const formats = [];
    const plan = [];
    try {
        for (const o of chosen) {
            if (!/^[a-z][a-z0-9_]{0,62}$/.test(o.key))
                throw new Error('no such table');
            const st = db.prepare(`SELECT * FROM "out_${o.key}" LIMIT ?`);
            st.setReturnArrays(true);
            const rows = st.all(cap);
            const cols = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(`out_${o.key}`).map((c) => c.name);
            // the row in the file goes first: every placed row can be traced back to its line
            // (rows that exist only in the other file point at that file: their column says so)
            const rowHeader = mg && o.key === 'only_there' ? `Row in ${mg.otherName}` : 'Row in file';
            const header = cols.map((c) => (c === '_row' ? rowHeader : (o.columns.find((x) => x.key === c)?.label ?? c)));
            const kinds = cols.map((c) => (c === '_row' ? 'number' : (o.columns.find((x) => x.key === c)?.type ?? 'text')));
            const cell = (v, i) => {
                if (v === null || v === undefined)
                    return '';
                if (typeof v === 'bigint')
                    return Number(v);
                // text stays text: an id like "13871, 1393" or "000123" is not a number, and "=..." from a file is never a formula
                return typeof v === 'string' && kinds[i] !== 'number' && kinds[i] !== 'date' ? asText(v) : v;
            };
            const values = [header.map((h) => asText(h)), ...rows.map((row) => row.map(cell))];
            let name = o.label.replace(/[^\p{L}\p{N} _-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || o.key;
            const base = name;
            for (let n = 2; metas.some((t) => t.name.toLowerCase() === name.toLowerCase()) || plan.some((p) => p.name.toLowerCase() === name.toLowerCase()); n++)
                name = `${base} ${n}`;
            plan.push({ output: o, name, rows: rows.length, truncated: o.rows > rows.length, widths: widthsOf(header, rows, cols.map((c) => o.columns.find((x) => x.key === c))) });
            actions.push({ action: 'add_table', name, rows: values.length, cols: header.length, values: values });
            cols.forEach((c, i) => {
                const meta = o.columns.find((x) => x.key === c);
                const f = meta ? formatOf(meta) : null;
                if (f && rows.length)
                    formats.push({ action: 'set_format', table: name, ref: `${letters(i)}2:${letters(i)}${rows.length + 1}`, format: { number_format: f } });
            });
        }
    }
    catch (e) {
        book.free();
        throw e;
    }
    finally {
        db.close();
    }
    const entries = [];
    const note = mg ? `dataset ${id} merge ${mg.id}` : `dataset ${id} run ${run}`;
    let metasAfter;
    try {
        // translate and apply on the open book (no before/after diff: nobody reviews 50,000 rows of it)
        const apply = (acts, strict) => {
            if (!acts.length)
                return;
            const { ops, errors } = actionsToOps(book, acts);
            if (errors.length && strict)
                throw new Error(`cannot place: ${errors.join('; ')}`);
            for (const op of ops) {
                const ch = JSON.parse(book.apply(JSON.stringify(op)));
                if (ch.error) {
                    if (strict)
                        throw new Error(`cannot place: ${String(op.type)}: ${ch.error}`);
                    continue;
                }
                pending.push(op);
            }
        };
        // all or nothing: every op is applied to the book first, the log is written only when all fit
        const pending = [];
        // one table at a time: each new table is placed below the ones already in the book (a batch would stack them all at the same spot)
        actions.forEach((a, i) => {
            apply([a], true);
            const id = JSON.parse(book.tables()).find((x) => x.name === plan[i].name)?.id;
            if (id === undefined)
                return;
            plan[i].widths.forEach((width, col) => {
                const op = { type: 'set_col_width', table: id, col, width };
                const ch = JSON.parse(book.apply(JSON.stringify(op)));
                if (!ch.error)
                    pending.push(op);
            });
        });
        apply(formats, false);
        metasAfter = tableMetas(book);
        for (const op of pending) {
            const seq = appendEntry(doc, { author: by, origin: 'import', op, note });
            entries.push({ seq, ts: now(), author: by, origin: 'import', op });
        }
        // persist the result: the book now holds exactly the state at the last seq (nothing else ran in between), so a
        // reload does not depend on an open editor saving it
        if (entries.length) {
            const json = book.to_json();
            writeFile(doc, readFile(doc)?.name ?? 'Untitled', json);
            writeCheckpoint(doc, entries[entries.length - 1].seq, json);
        }
    }
    finally {
        book.free();
    }
    notify?.(entries);
    const placed = { doc, at: now(), by: by.name || by.login || 'someone', run, ...(mg ? { merge: mg.id } : {}), tables: [] };
    for (const p of plan) {
        const t = metasAfter.find((x) => x.name === p.name);
        if (!t)
            continue;
        placed.tables.push({ output: p.output.key, table: t.id, name: p.name, rows: p.rows, truncated: p.truncated || undefined });
        try {
            const what = mg ? `${mg.kind === 'compare' ? 'comparing' : mg.kind === 'reconcile' ? 'reconciling' : 'appending'} ${m.file} with ${mg.otherName} (guided import${mg.keyLabels ? `, on ${mg.keyLabels.a} = ${mg.keyLabels.b}` : ''})` : `${m.file} (guided import, run ${run.slice(0, 6)})`;
            addRecord(doc, by, 'user', { kind: 'source', text: `${p.output.label} from ${what}: ${p.rows.toLocaleString('en-GB')} rows${p.truncated ? ` of ${p.output.rows.toLocaleString('en-GB')}` : ''}`, source: m.name, links: [{ table: t.id }], coverage: { rows: p.rows } });
        }
        catch (e) {
            console.error('source record failed:', e.message);
        }
    }
    const mm = mustMeta(tenant, id);
    mm.placements.push(placed);
    writeMeta(mm);
    return placed;
}
/** A text value as cell input: quoted with a leading apostrophe (as in Excel) whenever the engine would otherwise
 *  read it as a number, date, true/false or a formula. */
const MONTH = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;
export function asText(s) {
    const t = s.trim();
    if (!t)
        return s;
    if (/^[=+\-@'(.\d€$£]/.test(t) || /^(true|false)$/i.test(t) || /(kz|aoa|%)$/i.test(t) || (/\d/.test(t) && MONTH.test(t)))
        return `'${s}`;
    return s;
}
/** Column widths that fit the header and the formatted values (sampled), so numbers do not show as ####. */
function widthsOf(header, rows, meta) {
    const sample = rows.slice(0, 300);
    return header.map((h, i) => {
        const m = meta[i];
        let chars = h.length * 1.1; // headers are bold
        for (const row of sample) {
            const v = row[i];
            if (v === null || v === undefined || v === '')
                continue;
            const s = typeof v === 'number' && m?.type === 'number' ? `${v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${m.unit ? ' Kz.' : ''}` : String(v);
            chars = Math.max(chars, s.length);
        }
        return Math.round(Math.min(340, Math.max(72, chars * 7.2 + 20)));
    });
}
// ------------------------------------------------------------------ lineage: how was this made?
const placementIndex = new Map();
function placementFor(tenant, doc, table) {
    let idx = placementIndex.get(tenant);
    if (!idx) {
        idx = new Map();
        for (const d of listDatasets(tenant))
            for (const p of d.placements)
                for (const t of p.tables)
                    idx.set(`${p.doc}:${t.table}`, { dataset: d.id, placement: p, output: t.output });
        placementIndex.set(tenant, idx);
    }
    return idx.get(`${doc}:${table}`) ?? null;
}
export const isPlacedTable = (tenant, doc, table) => !!placementFor(tenant, doc, table);
/** `row` is the data row of the placed table; `source`, when given, is its "Row in file" — still right after the table is sorted. */
export function lineageOf(tenant, doc, table, row, source) {
    const p = placementFor(tenant, doc, table);
    if (!p)
        return null;
    const m = readMeta(tenant, p.dataset);
    const r = m ? readRun(tenant, p.dataset, p.placement.run) : null;
    if (!m || !r)
        return null;
    const mg = p.placement.merge ? m.merges.find((x) => x.id === p.placement.merge) : undefined;
    const mt = mg?.result.tables.find((x) => x.key === p.output);
    const output = mg
        ? mt && { key: mt.key, label: `${mt.label} (vs ${mg.otherName})`, role: 'analysis', rows: mt.rows, columns: mt.columns, place: true, step: '' }
        : r.outputs.find((o) => o.key === p.output);
    if (!output)
        return null;
    const t = p.placement.tables.find((x) => x.table === table);
    const header = r.steps.find((s) => s.type === 'header');
    const sheet = header && header.type === 'header' ? m.sheets[header.sheet]?.name : undefined;
    const labels = new Map(r.columns.map((c) => [c.key, c.label]));
    const L = (k) => labels.get(k) ?? k;
    const outStep = r.steps.find((s) => s.id === output.step);
    // the chain: the output's own step, the steps that wrote what it reads, back to the header (every row step counts: filters and drops shape all outputs)
    // — for a merge, every cleaning step: the comparison reads the whole clean table
    const stage = (s) => s.stage ?? STAGE_OF[s.type];
    const reads = new Set(outStep ? readsOf(outStep) : []);
    const steps = r.steps
        .filter((s) => s.enabled !== false && (s.type !== 'table' && s.type !== 'pivot' && s.type !== 'ageing' && s.type !== 'exceptions' ? true : s.id === output.step))
        .map((s) => {
        const res = r.results.find((x) => x.id === s.id);
        return { id: s.id, type: s.type, stage: stage(s), text: describe(s, L), why: s.why, by: s.by, status: res?.status ?? 'skipped', rowsIn: res?.rowsIn ?? 0, rowsOut: res?.rowsOut ?? 0, changed: res?.changed ?? 0, rejected: res?.rejected ?? 0, issues: res?.issues ?? 0, notes: res?.notes ?? [], examples: (res?.examples ?? []).slice(0, 6), direct: !!mg || s.id === output.step || s.type === 'header' || s.type === 'filter' || s.type === 'drop_rows' || (s.type !== 'check' && s.type !== 'duplicates' && readsOf(s).some((k) => reads.has(k))) };
    });
    const out = {
        dataset: { id: m.id, name: m.name, file: m.file, size: m.size, sha256: m.sha256, createdAt: m.createdAt, createdBy: m.createdBy, sheet },
        run: { id: r.id, at: r.at, by: r.by, rows: r.rows, ms: r.ms, recipe: r.recipe },
        placement: { at: p.placement.at, by: p.placement.by, name: t.name, rows: t.rows, truncated: t.truncated },
        output,
        steps,
        checks: r.checks,
        ...(mg ? { merge: { id: mg.id, kind: mg.kind, other: mg.other, otherName: mg.otherName, keyLabels: mg.keyLabels, notes: mg.result.notes, at: mg.at, by: mg.by } } : {}),
    };
    const dbPath = mg ? mergeDb(tenant, p.dataset, mg.id) : runDb(tenant, p.dataset, r.id);
    if (((row !== undefined && row >= 0) || source !== undefined) && existsSync(dbPath)) {
        const db = openRun(dbPath);
        try {
            const hasRow = db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = '_row'`).get(`out_${output.key}`) !== undefined;
            const v = (source !== undefined && hasRow
                ? db.prepare(`SELECT * FROM "out_${output.key}" WHERE _row = ? LIMIT 1`).get(source)
                : db.prepare(`SELECT * FROM "out_${output.key}" LIMIT 1 OFFSET ?`).get(Math.max(0, row ?? 0)));
            if (v) {
                const info = { index: row ?? -1, issues: [] };
                if (typeof v._row === 'number' || typeof v._row === 'bigint') {
                    const src = Number(v._row);
                    info.sourceRow = src;
                    info.cleaned = output.columns.map((c) => ({ label: c.label, key: c.key, value: v[c.key] ?? null }));
                    // the row's own file: a document only in the other file of a comparison points at that file
                    const there = mg && output.key === 'only_there';
                    const ds = there ? readMeta(tenant, mg.other) : m;
                    const rr = there ? (mg.otherRun ? readRun(tenant, mg.other, mg.otherRun) : null) : r;
                    if (there && ds)
                        info.file = ds.file;
                    if (ds && rr)
                        Object.assign(info, sourceRowOf(tenant, ds, rr, src));
                }
                else if (outStep && outStep.type === 'table' && outStep.groupBy.length) {
                    // a summary row: the group it stands for and the rows of the clean table behind it
                    info.group = outStep.groupBy.map((g, i) => ({ label: g.label ?? L(g.column), value: v[output.columns[i]?.key] ?? null }));
                    const conds = outStep.groupBy.map((g) => `"${g.column}" IS ?`).join(' AND ');
                    const args = outStep.groupBy.map((_, i) => (v[output.columns[i]?.key] ?? null));
                    const n = db.prepare(`SELECT count(*) n FROM work WHERE ${conds}`).get(...args).n;
                    const sample = db.prepare(`SELECT _row FROM work WHERE ${conds} ORDER BY _row LIMIT 12`).all(...args).map((x) => Number(x._row));
                    info.members = { count: Number(n), sampleRows: sample };
                }
                else
                    info.group = output.columns.map((c) => ({ label: c.label, value: v[c.key] ?? null })).slice(0, 4);
                out.row = info;
            }
        }
        finally {
            db.close();
        }
    }
    return out;
}
/** A line of a file as it arrived (under its own headers) and what the run flagged on it. */
function sourceRowOf(tenant, m, r, src) {
    const res = { issues: [] };
    const path = runDb(tenant, m.id, r.id);
    if (existsSync(path)) {
        const db = openRun(path);
        try {
            res.issues = db.prepare('SELECT step, kind, severity, col, value, detail FROM _issues WHERE row = ? LIMIT 50').all(src);
        }
        finally {
            db.close();
        }
    }
    const header = r.steps.find((s) => s.type === 'header');
    if (header && header.type === 'header' && existsSync(rawPath(tenant, m.id))) {
        const raw = new DatabaseSync(rawPath(tenant, m.id), { readOnly: true });
        try {
            const rr = raw.prepare(`SELECT * FROM raw_${header.sheet} WHERE _r = ?`).get(src);
            const hr = raw.prepare(`SELECT * FROM raw_${header.sheet} WHERE _r = ?`).get(header.row);
            if (rr)
                res.original = header.columns.map((c) => ({ header: String(hr?.[`c${c.index}`] ?? c.label), key: c.key, value: rr[`c${c.index}`] ?? null }));
        }
        finally {
            raw.close();
        }
    }
    return res;
}
// ------------------------------------------------------------------ related data and merge analyses
function sideOf(tenant, m) {
    const last = m.runs.find((r) => r.ok);
    if (!last)
        return null;
    const r = readRun(tenant, m.id, last.id);
    if (!r || !existsSync(runDb(tenant, m.id, r.id)))
        return null;
    return { id: m.id, name: m.name, run: runDb(tenant, m.id, r.id), columns: r.columns, roles: r.roles, rows: r.rows };
}
export async function relatedOf(tenant, id) {
    const m = mustMeta(tenant, id);
    const base = sideOf(tenant, m);
    if (!base)
        throw new Error('run the recipe first: related data is found in the cleaned table');
    const others = listDatasets(tenant)
        .filter((d) => d.id !== id && d.status === 'ready')
        .map((d) => sideOf(tenant, d))
        .filter((s) => !!s)
        .slice(0, 12);
    if (!others.length)
        return { relations: [], ms: 0, runs: {} };
    const out = await slot(() => inWorker({ task: 'relate', input: { base, others } }, 180_000));
    return { ...out, runs: Object.fromEntries(others.map((o) => [o.id, o.name])) };
}
export function startMerge(tenant, id, by, kind, otherId, key) {
    const m = mustMeta(tenant, id);
    const o = mustMeta(tenant, otherId);
    const base = sideOf(tenant, m);
    const other = sideOf(tenant, o);
    if (!base || !other)
        throw new Error('both datasets need a finished run');
    if (kind !== 'append' && !key)
        throw new Error(kind === 'reconcile' ? 'a reconciliation needs the key on each side' : 'a comparison needs the document number on each side');
    return startJob(tenant, id, 'combine', async (job) => {
        job.phase = kind === 'append' ? 'appending' : kind === 'compare' ? 'comparing the documents' : 'reconciling';
        const merge = randomBytes(6).toString('hex');
        mkdirSync(join(dirOf(tenant, id), 'merges'), { recursive: true, mode: 0o700 });
        const result = await inWorker({ task: 'combine', input: { kind, base, other, key, out: mergeDb(tenant, id, merge) } }, JOB_MS);
        let insights;
        if (kind === 'append') {
            try {
                insights = await inWorker({ task: 'insights', run: mergeDb(tenant, id, merge), roles: base.roles, unit: base.columns.find((c) => c.key === base.roles.amount)?.unit }, 120_000);
            }
            catch (e) {
                console.error('merge insights failed:', e.message);
            }
        }
        const mm = mustMeta(tenant, id);
        const keyLabels = key ? { a: base.columns.find((c) => c.key === key.a)?.label ?? key.a, b: other.columns.find((c) => c.key === key.b)?.label ?? key.b } : undefined;
        const entry = { id: merge, at: now(), by: by.name || by.login || 'someone', kind, other: otherId, otherName: o.name, key, keyLabels, run: m.runs.find((r) => r.ok)?.id, otherRun: o.runs.find((r) => r.ok)?.id, result: insights ? { ...result, insights } : result };
        mm.merges.unshift(entry);
        // the last five are kept, and every merge whose tables were placed in a workbook (their lineage reads it)
        const placed = new Set(mm.placements.map((x) => x.merge).filter(Boolean));
        const keep = mm.merges.filter((x, i) => i < 5 || placed.has(x.id));
        for (const old of mm.merges)
            if (!keep.includes(old))
                rmSync(mergeDb(tenant, id, old.id), { force: true });
        mm.merges = keep;
        writeMeta(mm);
        return entry;
    });
}
export function pageOfMerge(tenant, id, merge, table, offset, limit) {
    // the client names a table by its key (“reconcile”, “monthly”); the database holds it as out_<key> (the series is “work”)
    if (table !== 'work' && !table.startsWith('out_'))
        table = `out_${table}`;
    if (!/^(work|out_[a-z][a-z0-9_]{0,62})$/.test(table))
        throw new Error('no such table');
    const db = openRun(mergeDb(tenant, id, merge));
    try {
        if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table))
            throw new Error('no such table in this analysis');
        const cols = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((c) => c.name);
        const st = db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${table}" LIMIT ? OFFSET ?`);
        st.setReturnArrays(true);
        return { columns: cols, rows: st.all(Math.min(500, limit), offset), total: Number(db.prepare(`SELECT count(*) n FROM "${table}"`).get().n) };
    }
    finally {
        db.close();
    }
}
/** Disk use of a client's datasets (shown to administrators). */
export function usageOf(tenant) {
    let bytes = 0;
    const walk = (p) => {
        for (const f of readdirSync(p, { withFileTypes: true })) {
            const q = join(p, f.name);
            if (f.isDirectory())
                walk(q);
            else
                bytes += statSync(q).size;
        }
    };
    const r = root(tenant);
    if (existsSync(r))
        walk(r);
    return { datasets: listDatasets(tenant).length, bytes };
}
/** The file as it arrived: rows of one sheet, title rows and all (row numbers as in Excel). */
export function rawRows(tenant, id, sheet, offset, limit) {
    const m = mustMeta(tenant, id);
    const s = m.sheets.find((x) => x.index === sheet);
    if (!s)
        throw new Error('no such sheet');
    const db = new DatabaseSync(rawPath(tenant, id), { readOnly: true });
    try {
        const cols = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(`raw_${s.index}`).map((c) => c.name).filter((c) => c !== '_r');
        const st = db.prepare(`SELECT _r, ${cols.map((c) => `"${c}"`).join(', ') || 'NULL'} FROM raw_${s.index} WHERE _r > ? ORDER BY _r LIMIT ?`);
        st.setReturnArrays(true);
        return { sheet: s, columns: cols.length, rows: st.all(Math.max(0, offset), Math.min(500, Math.max(1, limit))) };
    }
    finally {
        db.close();
    }
}

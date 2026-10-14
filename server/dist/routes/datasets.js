// Routes for guided imports: datasets (a file brought in, its profile, its steps and runs), recipes
// (saved steps), the assistant, related data and merges, placing outputs in a document, and the
// lineage behind a placed table. Everything is scoped to the caller's client; changing anything needs
// an editor, placing needs edit access to the document, lineage needs view access.
import express from 'express';
import { z } from 'zod';
import { createReadStream } from 'node:fs';
import { assist, validateAction } from '../dsassist.js';
import { activeJobs, createDataset, deleteDataset, issuesOf, jobOf, lineageOf, listDatasets, MAX_DATASET_BYTES, pageOfMerge, pageOfRun, PLACE_MAX_ROWS, placeOutputs, preview, describeSteps, rawRows, readMeta, readProfiles, readRun, relatedOf, renameDataset, runFull, saveDraft, sourcePath, startMerge, } from '../datasets.js';
import { RolesSchema, StepSchema } from '../dssteps.js';
import { identityOf } from '../identity.js';
import { broadcastEntries } from '../multiplayer.js';
import { deleteRecipe, diffLayout, getRecipe, listRecipes, saveRecipe, updateRecipe } from '../recipes.js';
import { DEFAULT_TENANT } from '../storage.js';
import { ACCOUNTS } from '../tenancy.js';
import { authorOf, body, docPermission, fail as failAs, requireRole } from './common.js';
import { currentSeq } from '../history.js';
/** The client the request acts in, or a 400 when accounts mode has none. */
function tenantOf(req, res) {
    const t = identityOf(req).tenant;
    if (t)
        return t;
    if (ACCOUNTS) {
        res.status(400).json({ error: 'choose a client first' });
        return null;
    }
    return DEFAULT_TENANT;
}
const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
};
const editor = requireRole('editor');
/** a dataset, run, analysis or table that is not there — or is another client's — is a 404 */
const fail = (res, e, status = 400) => failAs(res, e, /^no such (dataset|run|merge|table|recipe|job)\b/.test(e?.message ?? '') ? 404 : status);
const raw = express.raw({ type: () => true, limit: MAX_DATASET_BYTES });
const RecipeRef = z.object({ id: z.string().regex(/^[a-f0-9]{12}$/), version: z.number().int().min(1) }).optional();
const StepsBody = z.object({ steps: z.array(z.unknown()).min(1).max(120), roles: RolesSchema.default({}), recipe: RecipeRef });
export function registerDatasetRoutes(app) {
    // ---------------------------------------------------------------- datasets
    app.get('/api/datasets', (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        res.json({ datasets: listDatasets(t).map((d) => ({ id: d.id, name: d.name, file: d.file, size: d.size, createdAt: d.createdAt, createdBy: d.createdBy, status: d.status, error: d.error, rows: d.sheets.reduce((a, s) => a + s.rows, 0), sheets: d.sheets.length, runs: d.runs.length, lastRun: d.runs[0] ?? null, placements: d.placements.length, match: d.match ?? null, recipe: d.draft?.recipe ?? null })) });
    });
    app.post('/api/datasets', editor, raw, (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        try {
            const name = String(req.query.name ?? req.headers['x-file-name'] ?? '');
            const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
            const r = createDataset(t, authorOf(req), decodeURIComponent(name), buf);
            res.status(201).json(r);
        }
        catch (e) {
            fail(res, e);
        }
    });
    app.get('/api/datasets/:ds', (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        const m = readMeta(t, req.params.ds);
        if (!m)
            return void res.status(404).json({ error: 'no such dataset' });
        const { profiles, proposal } = readProfiles(t, m.id);
        res.json({ dataset: m, profiles, proposal, jobs: activeJobs(t, m.id) });
    });
    app.patch('/api/datasets/:ds', editor, (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        const b = body(z.object({ name: z.string().min(1).max(120) }), req, res);
        if (!b)
            return;
        try {
            res.json({ dataset: renameDataset(t, req.params.ds, b.name) });
        }
        catch (e) {
            fail(res, e, 404);
        }
    });
    app.delete('/api/datasets/:ds', editor, (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        try {
            deleteDataset(t, req.params.ds);
            res.json({ ok: true });
        }
        catch (e) {
            fail(res, e);
        }
    });
    app.get('/api/datasets/:ds/source', (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        const m = readMeta(t, req.params.ds);
        if (!m)
            return void res.status(404).json({ error: 'no such dataset' });
        res.setHeader('content-type', 'application/octet-stream');
        res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(m.file)}`);
        createReadStream(sourcePath(t, m.id)).pipe(res);
    });
    app.get('/api/datasets/:ds/raw', (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        try {
            res.json(rawRows(t, req.params.ds, num(req.query.sheet, 0), num(req.query.offset, 0), num(req.query.limit, 40)));
        }
        catch (e) {
            fail(res, e, 404);
        }
    });
    app.put('/api/datasets/:ds/draft', editor, (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        const b = body(StepsBody, req, res);
        if (!b)
            return;
        try {
            res.json({ dataset: saveDraft(t, req.params.ds, authorOf(req), b.steps, b.roles, b.recipe) });
        }
        catch (e) {
            fail(res, e);
        }
    });
    app.post('/api/datasets/:ds/preview', editor, async (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        const b = body(z.object({ steps: z.array(z.unknown()).min(1).max(120), sample: z.number().int().min(100).max(20_000).optional() }), req, res);
        if (!b)
            return;
        try {
            res.json(await preview(t, req.params.ds, b.steps, b.sample));
        }
        catch (e) {
            fail(res, e, /busy/.test(String(e.message)) ? 429 : 400);
        }
    });
    app.post('/api/datasets/:ds/run', editor, (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        const b = body(StepsBody, req, res);
        if (!b)
            return;
        try {
            res.status(202).json({ job: runFull(t, req.params.ds, authorOf(req), b.steps, b.roles, b.recipe) });
        }
        catch (e) {
            fail(res, e, /already running/.test(String(e.message)) ? 409 : 400);
        }
    });
    app.get('/api/datasets/jobs/:job', (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        const j = jobOf(t, req.params.job);
        if (!j)
            return void res.status(404).json({ error: 'no such job' });
        res.json({ job: j });
    });
    app.get('/api/datasets/:ds/runs/:run', (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        try {
            const r = readRun(t, req.params.ds, req.params.run);
            if (!r)
                return void res.status(404).json({ error: 'no such run' });
            res.json({ run: { ...r, described: describeSteps(r.steps) } });
        }
        catch (e) {
            fail(res, e, 404);
        }
    });
    app.get('/api/datasets/:ds/runs/:run/table/:table', (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        try {
            const f = typeof req.query.column === 'string' && typeof req.query.value === 'string' ? { column: req.query.column, value: req.query.value } : undefined;
            res.json(pageOfRun(t, req.params.ds, req.params.run, req.params.table, num(req.query.offset, 0), num(req.query.limit, 100), f));
        }
        catch (e) {
            fail(res, e, 404);
        }
    });
    app.get('/api/datasets/:ds/runs/:run/issues', (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        try {
            res.json(issuesOf(t, req.params.ds, req.params.run, typeof req.query.step === 'string' ? req.query.step : undefined, num(req.query.offset, 0), num(req.query.limit, 100)));
        }
        catch (e) {
            fail(res, e, 404);
        }
    });
    // a whole output as CSV (UTF-8 with BOM, so Excel reads the accents)
    app.get('/api/datasets/:ds/runs/:run/export/:table', (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        try {
            const first = pageOfRun(t, req.params.ds, req.params.run, req.params.table, 0, 1);
            const r = readRun(t, req.params.ds, req.params.run);
            const out = r.outputs.find((o) => `out_${o.key}` === req.params.table);
            const labels = first.columns.map((c) => (c === '_row' ? 'Row in file' : (out?.columns.find((x) => x.key === c)?.label ?? r.columns.find((x) => x.key === c)?.label ?? c)));
            const esc = (v) => {
                if (v === null || v === undefined)
                    return '';
                const s = String(v);
                // a cell starting with = + - @ would run as a formula when opened in a spreadsheet
                const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
                return /[",\n\r;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
            };
            res.setHeader('content-type', 'text/csv; charset=utf-8');
            res.setHeader('content-disposition', `attachment; filename="${(out?.key ?? req.params.table).replace(/[^a-z0-9_]/g, '')}.csv"`);
            res.write('\ufeff' + labels.map(esc).join(',') + '\n');
            for (let off = 0; off < first.total; off += 500) {
                const p = pageOfRun(t, req.params.ds, req.params.run, req.params.table, off, 500);
                res.write(p.rows.map((row) => row.map(esc).join(',')).join('\n') + '\n');
            }
            res.end();
        }
        catch (e) {
            if (!res.headersSent)
                fail(res, e, 404);
            else
                res.end();
        }
    });
    // ---------------------------------------------------------------- assistant
    app.post('/api/datasets/:ds/assist', editor, async (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        const b = body(z.object({ question: z.string().min(1).max(2000), steps: z.array(z.unknown()).min(1).max(120), roles: RolesSchema.default({}), focus: z.string().max(80).optional(), result: z.unknown().optional() }), req, res);
        if (!b)
            return;
        const m = readMeta(t, req.params.ds);
        if (!m)
            return void res.status(404).json({ error: 'no such dataset' });
        const steps = b.steps.map((s) => StepSchema.safeParse(s)).filter((r) => r.success).map((r) => r.data);
        const h = steps[0];
        const { profiles } = readProfiles(t, m.id);
        const profile = profiles.find((p) => h && h.type === 'header' && p.index === h.sheet) ?? profiles[0];
        if (!profile)
            return void res.status(400).json({ error: 'the file has no profile yet' });
        const id = identityOf(req);
        try {
            res.json(await assist({ tenant: id.tenant, login: id.login || undefined, file: m.file, profile, steps, roles: b.roles, result: b.result ?? null, question: b.question, focus: b.focus }));
        }
        catch (e) {
            fail(res, e, 502);
        }
    });
    // a step typed or edited by hand goes through the same validation as the assistant's
    app.post('/api/datasets/:ds/validate-step', editor, (req, res) => {
        const b = body(z.object({ steps: z.array(z.unknown()).min(1).max(120), action: z.object({ op: z.enum(['add', 'update', 'remove']), after: z.string().optional(), id: z.string().optional(), step: z.unknown().optional(), why: z.string().max(400).optional() }) }), req, res);
        if (!b)
            return;
        const steps = b.steps.map((s) => StepSchema.safeParse(s)).filter((r) => r.success).map((r) => r.data);
        const v = validateAction(steps, b.action);
        if (v.step)
            v.step.by = 'person';
        res.json(v);
    });
    // ---------------------------------------------------------------- related data and merges
    app.get('/api/datasets/:ds/related', async (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        try {
            res.json(await relatedOf(t, req.params.ds));
        }
        catch (e) {
            fail(res, e);
        }
    });
    app.post('/api/datasets/:ds/merge', editor, (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        const b = body(z.object({ kind: z.enum(['append', 'reconcile', 'compare']), other: z.string().regex(/^[a-f0-9]{12}$/), key: z.object({ a: z.string().max(64), b: z.string().max(64) }).optional() }), req, res);
        if (!b)
            return;
        try {
            res.status(202).json({ job: startMerge(t, req.params.ds, authorOf(req), b.kind, b.other, b.key) });
        }
        catch (e) {
            fail(res, e);
        }
    });
    app.get('/api/datasets/:ds/merges/:merge/table/:table', (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        try {
            res.json(pageOfMerge(t, req.params.ds, req.params.merge, req.params.table, num(req.query.offset, 0), num(req.query.limit, 100)));
        }
        catch (e) {
            fail(res, e, 404);
        }
    });
    // ---------------------------------------------------------------- recipes
    app.get('/api/recipes', (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        res.json({ recipes: listRecipes(t).map((r) => ({ ...r, versions: r.versions.map((v) => ({ version: v.version, at: v.at, by: v.by, note: v.note, steps: v.steps.length, sheet: v.sheet, columns: v.columns.length })), uses: r.uses.slice(-20).reverse() })) });
    });
    app.get('/api/recipes/:rid', (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        const r = getRecipe(t, req.params.rid);
        if (!r)
            return void res.status(404).json({ error: 'recipe not found' });
        res.json({ recipe: r });
    });
    app.post('/api/recipes', editor, (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        const b = body(z.object({ id: z.string().regex(/^[a-f0-9]{12}$/).optional(), dataset: z.string().regex(/^[a-f0-9]{12}$/), run: z.string().regex(/^[a-f0-9]{12}$/).optional(), name: z.string().min(1).max(120), description: z.string().max(600).optional(), auto: z.boolean().optional(), note: z.string().max(300).optional() }), req, res);
        if (!b)
            return;
        const m = readMeta(t, b.dataset);
        if (!m)
            return void res.status(404).json({ error: 'no such dataset' });
        const r = b.run ? readRun(t, m.id, b.run) : null;
        const steps = r?.steps ?? m.draft?.steps;
        const roles = r?.roles ?? m.draft?.roles ?? {};
        if (!steps?.length)
            return void res.status(400).json({ error: 'nothing to save yet' });
        const h = steps[0];
        const profile = readProfiles(t, m.id).profiles.find((p) => h.type === 'header' && p.index === h.sheet);
        if (!profile)
            return void res.status(400).json({ error: 'the file has no profile' });
        try {
            const rec = saveRecipe(t, authorOf(req).name || 'someone', { id: b.id, name: b.name, description: b.description, auto: b.auto, note: b.note, steps, roles, profile, dataset: m.id, file: m.file, run: r?.id });
            saveDraft(t, m.id, authorOf(req), steps, roles, { id: rec.id, version: rec.current });
            res.status(b.id ? 200 : 201).json({ recipe: rec });
        }
        catch (e) {
            fail(res, e);
        }
    });
    app.patch('/api/recipes/:rid', editor, (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        const b = body(z.object({ name: z.string().min(1).max(120).optional(), description: z.string().max(600).optional(), auto: z.boolean().optional() }), req, res);
        if (!b)
            return;
        try {
            res.json({ recipe: updateRecipe(t, req.params.rid, b) });
        }
        catch (e) {
            fail(res, e, 404);
        }
    });
    app.delete('/api/recipes/:rid', editor, (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        try {
            deleteRecipe(t, req.params.rid);
            res.json({ ok: true });
        }
        catch (e) {
            fail(res, e, 404);
        }
    });
    /** what changes if this recipe is used on this file: the layout diff and the adapted steps */
    app.get('/api/datasets/:ds/recipe-diff/:rid', (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        const m = readMeta(t, req.params.ds);
        const r = getRecipe(t, req.params.rid);
        if (!m || !r)
            return void res.status(404).json({ error: 'not found' });
        const v = r.versions.find((x) => x.version === num(req.query.version, r.current)) ?? r.versions[r.versions.length - 1];
        const { profiles } = readProfiles(t, m.id);
        const profile = profiles.find((p) => p.name === v.sheet) ?? [...profiles].sort((a, b) => b.rows - a.rows)[0];
        if (!profile)
            return void res.status(400).json({ error: 'the file has no profile' });
        res.json({ diff: diffLayout(r, profile, v.version), roles: v.roles });
    });
    // ---------------------------------------------------------------- documents: placing and lineage
    app.post('/api/files/:id/datasets/place', editor, (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        if (!docPermission(req, res, 'edit'))
            return;
        const b = body(z.object({ dataset: z.string().regex(/^[a-f0-9]{12}$/), run: z.string().regex(/^[a-f0-9]{12}$/).optional(), merge: z.string().regex(/^[a-f0-9]{12}$/).optional(), outputs: z.array(z.string().max(64)).min(1).max(12), maxRows: z.number().int().min(1).max(PLACE_MAX_ROWS).optional() }), req, res);
        if (!b)
            return;
        try {
            if (!b.run && !b.merge)
                return void res.status(400).json({ error: 'choose a run or a merge to place' });
            const placement = placeOutputs(t, b.dataset, b.run, req.params.id, authorOf(req), b.outputs, (e) => broadcastEntries(req.params.id, e), b.maxRows, b.merge ? { merge: b.merge } : undefined);
            // the log position after the placement: a browser that missed the broadcast catches up to it
            res.json({ placement, seq: currentSeq(req.params.id) });
        }
        catch (e) {
            fail(res, e);
        }
    });
    app.get('/api/files/:id/lineage', (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        if (!docPermission(req, res, 'view'))
            return;
        const table = num(req.query.table, -1);
        const row = req.query.row === undefined ? undefined : num(req.query.row, -1);
        try {
            const source = req.query.source === undefined ? undefined : num(req.query.source, -1);
            const l = lineageOf(t, req.params.id, table, row !== undefined && row >= 0 ? row : undefined, source !== undefined && source > 0 ? source : undefined);
            if (!l)
                return void res.status(404).json({ error: 'this table was not made by a guided import' });
            res.json({ lineage: l });
        }
        catch (e) {
            fail(res, e);
        }
    });
    // a quick check the client uses to offer "How was this made?" on the right click
    app.get('/api/files/:id/lineage/tables', (req, res) => {
        const t = tenantOf(req, res);
        if (!t)
            return;
        if (!docPermission(req, res, 'view'))
            return;
        const tables = [];
        for (const d of listDatasets(t))
            for (const p of d.placements)
                if (p.doc === req.params.id)
                    for (const x of p.tables)
                        tables.push({ table: x.table, dataset: d.id, run: p.run, output: x.output, name: x.name });
        res.json({ tables });
    });
}

// Saved recipes: the steps of a guided import kept per client, versioned, with the layout they were made
// for. A new file is matched against them (same headers, types, values), the differences are listed in
// plain words (a column renamed, moved, missing or new; a type changed; a value no rule covers), and the
// recipe is adapted to the new layout — by key, so every later step still finds its columns.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DATA_DIR } from './storage.js';
import { describe, readsOf, StepSchema } from './dssteps.js';
const now = () => new Date().toISOString();
const safeTenant = (t) => (/^[a-zA-Z0-9_-]{1,64}$/.test(t) ? t : '_');
const file = (tenant) => join(DATA_DIR, 'recipes', `${safeTenant(tenant)}.json`);
export const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function load(tenant) {
    const p = file(tenant);
    if (!existsSync(p))
        return [];
    try {
        return JSON.parse(readFileSync(p, 'utf8'));
    }
    catch {
        return [];
    }
}
function save(tenant, list) {
    mkdirSync(join(DATA_DIR, 'recipes'), { recursive: true, mode: 0o700 });
    const p = file(tenant);
    writeFileSync(`${p}.tmp`, JSON.stringify(list, null, 1), { mode: 0o600 });
    renameSync(`${p}.tmp`, p);
}
export const listRecipes = (tenant) => load(tenant);
export const getRecipe = (tenant, id) => load(tenant).find((r) => r.id === id) ?? null;
function columnsOf(steps, profile) {
    const h = steps.find((s) => s.type === 'header');
    if (!h || h.type !== 'header')
        throw new Error('a recipe starts with a header step');
    return h.columns.map((c) => {
        const p = profile.columns.find((x) => x.index === c.index);
        return { key: c.key, label: c.label, header: p?.label ?? c.label, index: c.index, type: p?.inferred ?? 'text', values: p && p.inferred === 'category' ? p.top.map((t) => String(t.value)).slice(0, 40) : undefined };
    });
}
/** Save the steps as a new recipe, or as the next version of one. */
export function saveRecipe(tenant, by, input) {
    const steps = input.steps.map((s) => StepSchema.parse(s));
    const list = load(tenant);
    const version = { at: now(), by, note: input.note?.slice(0, 300), steps, roles: input.roles, sheet: input.profile.name, headerRow: input.profile.headerRow, columns: columnsOf(steps, input.profile) };
    let r = input.id ? list.find((x) => x.id === input.id) : undefined;
    if (input.id && !r)
        throw new Error('recipe not found');
    if (r) {
        const v = Math.max(...r.versions.map((x) => x.version)) + 1;
        r.versions.push({ ...version, version: v });
        r.current = v;
        r.name = input.name.slice(0, 120) || r.name;
        if (input.description !== undefined)
            r.description = input.description.slice(0, 600);
        if (input.auto !== undefined)
            r.auto = input.auto;
    }
    else {
        r = { id: randomBytes(6).toString('hex'), name: input.name.slice(0, 120), description: input.description?.slice(0, 600), createdAt: now(), createdBy: by, auto: !!input.auto, current: 1, versions: [{ ...version, version: 1 }], uses: [] };
        list.push(r);
    }
    r.uses.push({ dataset: input.dataset, file: input.file, run: input.run, at: now(), version: r.current, score: 1 });
    if (r.uses.length > 200)
        r.uses = r.uses.slice(-200);
    save(tenant, list);
    return r;
}
export function updateRecipe(tenant, id, patch) {
    const list = load(tenant);
    const r = list.find((x) => x.id === id);
    if (!r)
        throw new Error('recipe not found');
    if (patch.name)
        r.name = patch.name.slice(0, 120);
    if (patch.description !== undefined)
        r.description = patch.description.slice(0, 600);
    if (patch.auto !== undefined)
        r.auto = patch.auto;
    save(tenant, list);
    return r;
}
export function deleteRecipe(tenant, id) {
    const list = load(tenant);
    const i = list.findIndex((x) => x.id === id);
    if (i < 0)
        throw new Error('recipe not found');
    list.splice(i, 1);
    save(tenant, list);
}
export function recordUse(tenant, id, use) {
    const list = load(tenant);
    const r = list.find((x) => x.id === id);
    if (!r)
        return;
    const had = r.uses.find((u) => u.dataset === use.dataset && u.run === use.run);
    if (had)
        Object.assign(had, use);
    else
        r.uses.push(use);
    if (r.uses.length > 200)
        r.uses = r.uses.slice(-200);
    save(tenant, list);
}
/** word-overlap similarity of two headers (0..1) */
function similar(a, b) {
    const A = new Set(norm(a).split(' ').filter(Boolean));
    const B = new Set(norm(b).split(' ').filter(Boolean));
    if (!A.size || !B.size)
        return 0;
    const inter = [...A].filter((x) => B.has(x)).length;
    const j = inter / (A.size + B.size - inter);
    // a header that contains the other (“Valor” / “Valor Total”) is close
    const na = norm(a);
    const nb = norm(b);
    return Math.max(j, na && nb && (na.includes(nb) || nb.includes(na)) ? 0.6 : 0);
}
const compatible = (a, b) => a === b || (a === 'category' && b === 'text') || (a === 'text' && b === 'category') || (a === 'identifier' && (b === 'text' || b === 'number')) || ((a === 'text' || a === 'number') && b === 'identifier');
/** Compare a recipe version with a new file's profile: what matches, what changed, and the adapted steps. */
export function diffLayout(r, profile, version = r.current) {
    const v = r.versions.find((x) => x.version === version) ?? r.versions[r.versions.length - 1];
    const cols = profile.columns.filter((c) => c.inferred !== 'empty');
    const used = new Set();
    const changes = [];
    const mapped = new Map();
    // 1. the same header (moved or not)
    for (const rc of v.columns) {
        const c = cols.find((x) => !used.has(x.index) && norm(x.label) === norm(rc.header));
        if (!c)
            continue;
        used.add(c.index);
        mapped.set(rc.key, c);
        changes.push(c.index === rc.index ? { kind: 'same', key: rc.key, header: rc.header, index: c.index } : { kind: 'moved', key: rc.key, header: rc.header, from: rc.index, to: c.index });
        if (!compatible(rc.type, c.inferred) && c.inferred !== 'empty')
            changes.push({ kind: 'type', key: rc.key, header: rc.header, was: rc.type, now: c.inferred });
    }
    // 2. a renamed header: a similar name or the same position, with a compatible type
    for (const rc of v.columns) {
        if (mapped.has(rc.key))
            continue;
        let best = null;
        for (const c of cols) {
            if (used.has(c.index) || !compatible(rc.type, c.inferred))
                continue;
            let s = similar(rc.header, c.label);
            if (c.index === rc.index)
                s += 0.35;
            if (rc.values?.length && c.top.length) {
                const vs = new Set(rc.values);
                const hit = c.top.filter((t) => vs.has(String(t.value))).length / Math.min(c.top.length, rc.values.length);
                s += hit * 0.5;
            }
            if (!best || s > best.s)
                best = { c, s };
        }
        if (best && best.s >= 0.5) {
            used.add(best.c.index);
            mapped.set(rc.key, best.c);
            changes.push({ kind: 'renamed', key: rc.key, from: rc.header, to: best.c.label, index: best.c.index, confidence: Math.min(1, Math.round(best.s * 100) / 100) });
        }
    }
    // 3. missing and new
    const steps = v.steps.map((s) => structuredClone(s));
    const missingKeys = v.columns.filter((rc) => !mapped.has(rc.key)).map((rc) => rc.key);
    for (const rc of v.columns.filter((x) => !mapped.has(x.key)))
        changes.push({ kind: 'missing', key: rc.key, header: rc.header, usedBy: steps.filter((s) => s.type !== 'header' && readsOf(s).includes(rc.key)).map((s) => s.id) });
    const taken = new Set(v.columns.map((c) => c.key));
    const added = [];
    for (const c of cols.filter((x) => !used.has(x.index))) {
        changes.push({ kind: 'new', header: c.label, index: c.index, type: c.inferred });
        let key = c.key;
        for (let n = 2; taken.has(key); n++)
            key = `${c.key.slice(0, 58)}_${n}`;
        taken.add(key);
        added.push({ index: c.index, key, label: c.label });
    }
    const known = new Set(v.columns.map((rc) => norm(rc.header)));
    for (const c of profile.columns.filter((x) => x.inferred === 'empty' && x.label && !known.has(norm(x.label))))
        changes.push({ kind: 'new', header: c.label, index: c.index, type: 'empty' });
    // 4. values no rule covers: a condition on a category that meets a value it never saw
    const values = [];
    for (const rc of v.columns.filter((x) => x.values?.length)) {
        const c = mapped.get(rc.key);
        if (!c)
            continue;
        const seen = new Set(rc.values);
        const fresh = c.top.filter((t) => !seen.has(String(t.value)) && t.value !== null && t.value !== '');
        if (!fresh.length)
            continue;
        const usedBy = steps.filter((s) => s.type !== 'header' && s.type !== 'table' && s.type !== 'pivot' && readsOf(s).includes(rc.key)).map((s) => s.id);
        values.push({ key: rc.key, header: c.label, values: fresh.map((t) => ({ value: String(t.value), count: t.count })), usedBy });
    }
    // 5. the adapted header step
    const h = steps.find((s) => s.type === 'header');
    if (h && h.type === 'header') {
        h.sheet = profile.index;
        h.row = profile.headerRow;
        h.columns = [...v.columns.filter((rc) => mapped.has(rc.key)).map((rc) => ({ index: mapped.get(rc.key).index, key: rc.key, label: rc.label })), ...added].sort((a, b) => a.index - b.index);
        h.why = `Adapted from “${r.name}” v${v.version}: ${h.columns.length} columns mapped by header${added.length ? `, ${added.length} new kept` : ''}${missingKeys.length ? `, ${missingKeys.length} missing` : ''}.`;
    }
    const blocked = steps.filter((s) => s.type !== 'header').map((s) => ({ step: s.id, missing: readsOf(s).filter((k) => missingKeys.includes(k)) })).filter((b) => b.missing.length);
    for (const b of blocked) {
        const s = steps.find((x) => x.id === b.step);
        s.enabled = false;
    }
    // 6. score and summary
    const matched = changes.filter((c) => c.kind === 'same' || c.kind === 'moved').length;
    const renamed = changes.filter((c) => c.kind === 'renamed');
    const score = Math.round(((matched + renamed.reduce((a, c) => a + c.confidence, 0) * 0.8) / Math.max(v.columns.length, cols.length)) * 100) / 100;
    const summary = [];
    const label = (k) => v.columns.find((c) => c.key === k)?.label ?? v.columns.find((c) => c.key === k)?.header ?? k;
    // steps named the way the timeline shows them, not by their ids
    const named = (ids) => ids
        .map((id) => steps.find((s) => s.id === id))
        .filter((s) => !!s)
        .map((s) => {
        const d = describe(s, label).replace(/\.$/, '');
        return `“${d.length > 70 ? `${d.slice(0, 69)}…` : d}”`;
    })
        .join(', ');
    for (const c of changes) {
        if (c.kind === 'missing')
            summary.push({
                level: c.usedBy.length ? 'error' : 'warning',
                text: `“${c.header}” is not in this file${c.usedBy.length ? `; ${c.usedBy.length === 1 ? 'one step uses it and is' : `${c.usedBy.length} steps use it and are`} switched off until it is mapped: ${named(c.usedBy)}` : ''}.`,
            });
        if (c.kind === 'renamed')
            summary.push({ level: c.confidence >= 0.8 ? 'info' : 'warning', text: `“${c.from}” is now called “${c.to}” (${Math.round(c.confidence * 100)}% sure); mapped, please confirm.` });
        if (c.kind === 'type')
            summary.push({ level: 'warning', text: `“${c.header}” was ${c.was}, now reads as ${c.now}.` });
        if (c.kind === 'new')
            summary.push({ level: 'info', text: c.type === 'empty' ? `New column “${c.header}” is empty in this file; left out.` : `New column “${c.header}” (${c.type}); kept in the clean table.` });
    }
    const moved = changes.filter((c) => c.kind === 'moved');
    if (moved.length)
        summary.push({ level: 'info', text: `${moved.length} column${moved.length === 1 ? '' : 's'} changed position (${moved.slice(0, 4).map((c) => c.header).join(', ')}); matched by header.` });
    for (const vc of values)
        summary.push({ level: vc.usedBy.length ? 'warning' : 'info', text: `“${vc.header}” has value${vc.values.length === 1 ? '' : 's'} not seen before: ${vc.values.slice(0, 4).map((x) => `“${x.value}” (${x.count.toLocaleString('en-GB')})`).join(', ')}${vc.usedBy.length ? ` — check ${named(vc.usedBy)} (e.g. is it a credit note?)` : ''}.` });
    if (profile.headerRow !== v.headerRow)
        summary.push({ level: 'info', text: `The header moved from row ${v.headerRow} to row ${profile.headerRow}.` });
    if (profile.name !== v.sheet)
        summary.push({ level: 'info', text: `The sheet is “${profile.name}” (was “${v.sheet}”).` });
    const order = { error: 0, warning: 1, info: 2 };
    summary.sort((a, b) => order[a.level] - order[b.level]);
    if (!summary.length)
        summary.push({ level: 'info', text: 'Same layout as the recipe: every column found where it was.' });
    return { recipe: r.id, version: v.version, name: r.name, score, sheet: { was: v.sheet, now: profile.name }, headerRow: { was: v.headerRow, now: profile.headerRow }, columns: changes, values, summary, steps, blocked };
}
/** The saved recipes that fit a file best (score ≥ 0.5), best first. */
export function matchRecipes(tenant, profile) {
    return load(tenant)
        .map((r) => diffLayout(r, profile))
        .filter((d) => d.score >= 0.5)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
}

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
import { DATA_DIR } from '../storage.js';
export const RECORD_KINDS = ['fact', 'source', 'objective', 'constraint', 'hypothesis', 'contradiction', 'decision', 'exclusion', 'question', 'expectation', 'scenario'];
/** kinds that frame every conclusion: changing one makes earlier conclusions provisional */
export const ASSUMPTION_KINDS = ['objective', 'constraint', 'exclusion'];
export const LIVE = (r) => r.status !== 'retired' && r.status !== 'superseded' && r.status !== 'resolved';
export const DIR = () => join(DATA_DIR, 'companion');
export const pathOf = (doc) => join(DIR(), `${doc}.json`);
export const safeId = (id) => /^[a-zA-Z0-9_-]{1,64}$/.test(id);
export const MAX_OBS = 500;
export const MAX_EVENTS = 300;
export const MAX_RUNS = 100;
export const MAX_INVESTIGATIONS = 40;
export function readJson(path, fallback) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return fallback;
    }
}
export function writeJsonAtomic(path, value) {
    mkdirSync(DIR(), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 1));
    renameSync(tmp, path);
}
export function loadState(doc) {
    if (!safeId(doc))
        throw new Error('bad document id');
    const s = readJson(pathOf(doc), { doc, records: [], watches: [], events: [] });
    s.records ??= [];
    s.watches ??= [];
    s.events ??= [];
    s.assumptionsSeq ??= 0;
    s.dismissed ??= [];
    s.runs ??= [];
    s.investigations ??= [];
    for (const w of s.watches)
        w.history ??= [];
    for (const i of s.investigations) {
        i.steps ??= [];
        i.runs ??= [];
        i.records ??= [];
        i.proposals ??= [];
    }
    return s;
}
export function saveState(s) {
    if (s.events.length > MAX_EVENTS)
        s.events = s.events.slice(-MAX_EVENTS);
    for (const w of s.watches)
        if (w.observations.length > MAX_OBS)
            w.observations = w.observations.slice(-MAX_OBS);
    if ((s.runs ?? []).length > MAX_RUNS)
        s.runs = s.runs.slice(-MAX_RUNS);
    if ((s.investigations ?? []).length > MAX_INVESTIGATIONS)
        s.investigations = s.investigations.slice(-MAX_INVESTIGATIONS);
    writeJsonAtomic(pathOf(s.doc), s);
}
export function deleteCompanion(doc) {
    if (safeId(doc) && existsSync(pathOf(doc)))
        unlinkSync(pathOf(doc));
}
export function hasCompanion(doc) {
    return safeId(doc) && existsSync(pathOf(doc));
}
export const now = () => new Date().toISOString();
export const today = () => now().slice(0, 10);
export const who = (a) => a.name || a.login || 'someone';
export function event(s, e) {
    s.events.push({ at: now(), ...e });
}
export const short = (t, n = 160) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
/** A changed frame: everything concluded before it is provisional until re-checked. */
export function bumpAssumptions(s, r, how, by) {
    s.assumptionsSeq = (s.assumptionsSeq ?? 0) + 1;
    fenceRunning(s, `${r.kind} “${short(r.text, 80)}” ${how}`);
    if (how === 'added')
        return; // "Kept what matters" is already in the activity
    const had = (s.investigations ?? []).filter((i) => i.status === 'done' && i.assumptionsSeq < (s.assumptionsSeq ?? 0)).length;
    event(s, { kind: 'assumption', text: `Assumption ${how}: ${r.kind} “${short(r.text, 100)}” — ${had ? `${had} earlier investigation${had === 1 ? ' is' : 's are'} now provisional; ` : ''}conclusions reached before it are provisional until re-checked`, by: who(by), level: 'watch' });
}
let fenceHook = null;
/** Called whenever a document's running work is fenced (jobs.ts supersedes the document's jobs). */
export function setFenceHook(fn) {
    fenceHook = fn;
}
/** A running investigation under a direction that just changed: its result, when it comes, is superseded — kept as history, never current. */
export function fenceRunning(s, why) {
    for (const i of s.investigations ?? []) {
        if (i.status === 'running' && !i.superseded) {
            i.superseded = now();
            event(s, { kind: 'investigation', text: `The investigation “${short(i.question, 80)}” was overtaken (${why}): whatever it finds is kept as history, not applied`, level: 'quiet' });
        }
    }
    try {
        fenceHook?.(s.doc, why);
    }
    catch (e) {
        console.error('fence hook failed:', e.message);
    }
}
export const loadStateQuiet = (doc) => {
    try {
        return loadState(doc);
    }
    catch {
        return { doc, records: [], watches: [], events: [] };
    }
};
export const hoursSince = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 3_600_000 : Infinity);
/** An event from another module (an intake, a first reading): kept in the same activity. */
export function noteEvent(doc, e) {
    const s = loadState(doc);
    event(s, e);
    saveState(s);
}
export function markSeen(doc) {
    const s = loadState(doc);
    s.seenAt = now();
    saveState(s);
}

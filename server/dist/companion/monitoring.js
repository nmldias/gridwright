// Monitoring: watches (what is watched, why, under which conditions, with what authority), the
// freshness of sources from data changes only, the deterministic checks that run on every change
// and on a timer — observations keyed by period, comparability, typed invalid states, one evolving
// issue per watch, decisions' conditions, expectations, review dates, cross-checks between sources —
// the suggestions read off the columns, and the scheduling of all that.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { currentSeq, onAppend, readAll } from '../history.js';
import { engineAvailable, errorMessage, openDocument, tableByName, tableMetas } from '../headless.js';
import { newId, readFile } from '../storage.js';
import { DIR, event, hasCompanion, hoursSince, LIVE, loadState, loadStateQuiet, now, saveState, short, today, who } from './state.js';
import { affectedBy, graphOf, periodReaches, periodsOf, tablesReferenced } from './relations.js';
// ------------------------------------------------------------------ watches
const OPS = ['>', '>=', '<', '<=', '=', '!='];
export function normaliseDef(input) {
    const kind = input.kind === 'check' || input.kind === 'change' || input.kind === 'worsening' ? input.kind : 'threshold';
    const formula = String(input.formula ?? '').trim();
    if (!formula)
        throw new Error('formula required');
    const def = {
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
        def.op = OPS.includes(input.op) ? input.op : '>';
        def.value = Number(input.value ?? 0) || 0;
    }
    if (kind === 'worsening')
        def.bad = input.bad === 'down' ? 'down' : 'up';
    return def;
}
const hashDef = (d) => createHash('sha256').update(JSON.stringify([d.formula, d.table ?? '', d.kind, d.op ?? '', d.value ?? '', d.bad ?? '', d.scope])).digest('hex').slice(0, 12);
export function addWatch(doc, by, origin, input) {
    const s = loadState(doc);
    const def = normaliseDef(input);
    const w = {
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
export function updateWatch(doc, id, by, patch) {
    const s = loadState(doc);
    const w = s.watches.find((x) => x.id === id);
    if (!w)
        throw new Error('watch not found');
    if (patch.approve) {
        w.authority = 'approved';
        if (w.health === 'proposed')
            w.health = 'unchecked';
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
export function removeWatch(doc, id, by) {
    const s = loadState(doc);
    const i = s.watches.findIndex((x) => x.id === id);
    if (i < 0)
        return false;
    const [w] = s.watches.splice(i, 1);
    // a decision that leaned on it is no longer watched there
    for (const r of s.records)
        for (const c of r.conditions ?? [])
            if (c.watch === w.id)
                c.watch = undefined;
    event(s, { kind: 'watch', text: `Stopped watching: ${w.def.purpose}`, by: who(by), level: 'quiet' });
    saveState(s);
    return true;
}
// ------------------------------------------------------------------ sources and freshness
/** What the document's tables are fed by, and when each last changed — from the audit log, not from anyone's say-so. */
/** Operations that change what a table says — not how it looks, where it sits or what it is called. */
const DATA_OPS = new Set(['set_cell', 'set_cells', 'clear_range', 'resize_table', 'insert_rows', 'delete_rows', 'insert_cols', 'delete_cols', 'add_table', 'delete_table', 'code_result', 'set_header_rows', 'set_pivot']);
export function sourceStatus(doc, entries, state) {
    if (!engineAvailable() || !readFile(doc))
        return [];
    const log = entries ?? readAll(doc);
    const last = new Map();
    const supply = new Map();
    for (const e of log) {
        const t = typeof e.op?.table === 'number' ? e.op.table : e.run ? e.run.table : undefined;
        if (t === undefined)
            continue;
        // formatting, moving, renaming, widths, notes and saves do not make data current
        const isData = !!e.run || (e.op && DATA_OPS.has(String(e.op.type)));
        if (!isData)
            continue;
        last.set(t, e.ts);
        if (e.origin === 'import')
            supply.set(t, 'import');
        else if (e.origin === 'sql' || (e.run && e.run.kind === 'sql'))
            supply.set(t, 'live');
        else if (e.origin === 'user' && !supply.has(t))
            supply.set(t, 'manual');
    }
    // a table with no logged data change of its own is as fresh as the document's birth (its first save), not its last save
    const birth = (log.find((e) => e.checkpoint && e.note === 'created') ?? log[0])?.ts;
    const periods = state ? periodsOf(state) : periodsOf(loadStateQuiet(doc));
    const { book } = openDocument(doc);
    try {
        return tableMetas(book).map((t) => ({ name: t.name, kind: 'table', lastChange: last.get(t.id) ?? birth, asOf: periods.get(t.id), supply: supply.get(t.id) ?? 'unknown', rows: t.rows }));
    }
    finally {
        book.free();
    }
}
export function evaluate(doc, def, formula = def.formula) {
    const { book } = openDocument(doc);
    try {
        const t = def.table ? tableByName(book, def.table) : tableMetas(book)[0];
        if (!t)
            return { value: null, error: def.table ? `table “${def.table}” not found` : 'the document has no table' };
        const v = JSON.parse(book.preview(t.id, formula));
        if (!v)
            return { value: null };
        if ('e' in v && v.e)
            return { value: null, error: String(v.e) };
        if ('n' in v)
            return { value: v.n ?? null };
        if ('b' in v)
            return { value: !!v.b };
        if ('s' in v)
            return { value: v.s ?? null };
        return { value: null };
    }
    catch (e) {
        return { value: null, error: errorMessage(e) };
    }
    finally {
        book.free();
    }
}
/** The rule in words: “more than 1”, “must stay TRUE”, “getting worse”, “any change”. */
export function ruleText(d) {
    if (d.kind === 'threshold') {
        const opWord = d.op === '>' ? 'more than' : d.op === '>=' ? 'at least' : d.op === '<' ? 'below' : d.op === '<=' ? 'at most' : d.op === '=' ? 'equal to' : 'different from';
        return `${opWord} ${fmt(d.value ?? 0)}`;
    }
    if (d.kind === 'check')
        return 'must stay TRUE';
    if (d.kind === 'worsening')
        return d.bad === 'down' ? 'falling, snapshot after snapshot' : 'rising, snapshot after snapshot';
    return 'any change';
}
export const dateWord = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
export const whenOf = (o) => o.period ?? dateWord(o.at);
export const compare = (v, op, limit) => (op === '>' ? v > limit : op === '>=' ? v >= limit : op === '<' ? v < limit : op === '<=' ? v <= limit : op === '=' ? v === limit : v !== limit);
export const fmt = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('en-GB') : v.toLocaleString('en-GB', { maximumFractionDigits: 2 })) : String(v));
/** Run every approved watch of a document; returns what changed level. Cheap: formulas only, no model. */
export function checkDocument(doc, reason = 'change', changedTables = []) {
    if (!engineAvailable() || !readFile(doc))
        return { attention: 0, changed: false, affected: [] };
    const s = loadState(doc);
    const seq = currentSeq(doc);
    const log = readAll(doc);
    const sources = sourceStatus(doc, log, s);
    let changed = false;
    let attention = 0;
    const at = now();
    // which analyses the change reaches, by the graph's edges (named in the activity; every watch is still evaluated — it is cheap)
    let affected = [];
    if (changedTables.length && s.watches.length) {
        try {
            const g = graphOf(doc);
            const a = affectedBy(g, changedTables.map((t) => `table:${t}`));
            affected = a.watches.map((id) => s.watches.find((w) => w.id === id)?.def.purpose ?? id);
            const names = changedTables.map((t) => g.nodes.find((n) => n.id === `table:${t}`)?.label ?? `table ${t}`);
            if (affected.length)
                event(s, { kind: 'trace', text: `${names.join(', ')} changed → reassessing ${affected.join(', ')}`, level: 'quiet' });
        }
        catch {
            /* the graph is a convenience; the checks run regardless */
        }
    }
    const periodOfTable = periodsOf(s);
    let metas = [];
    let cellsOf = null;
    const { book } = openDocument(doc);
    try {
        metas = tableMetas(book);
        const cache = new Map();
        cellsOf = (id) => {
            if (!cache.has(id))
                cache.set(id, JSON.parse(book.cells(id)));
            return cache.get(id);
        };
        const sortKey = (o) => o.period ?? '\uffff';
        const byPeriod = (a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
        for (const w of s.watches) {
            if (w.authority !== 'approved')
                continue;
            const { value, error } = evaluate(doc, w.def);
            const complement = w.def.complement ? evaluate(doc, w.def, w.def.complement) : null;
            const complementValue = complement && !complement.error && typeof complement.value === 'number' ? complement.value : complement ? null : undefined;
            const readTables = tablesReferenced(w.def.formula, metas);
            const ctxTable = !readTables.length && w.def.table ? metas.find((m) => m.name.toLowerCase() === w.def.table.toLowerCase()) : undefined;
            const tablesRead = readTables.length ? readTables : ctxTable ? [ctxTable.id] : metas[0] ? [metas[0].id] : [];
            const period = tablesRead.map((t) => periodOfTable.get(t)).find(Boolean);
            const population = tablesRead.reduce((n, id) => {
                const m = metas.find((x) => x.id === id);
                return n + (m ? Math.max(0, m.rows - m.header_rows) : 0);
            }, 0);
            // freshness: an essential source older than allowed means no conclusion is presented
            let fresh = true;
            if (w.def.freshnessHours && w.def.sources?.length) {
                for (const name of w.def.sources) {
                    const src = sources.find((x) => x.name.toLowerCase() === name.toLowerCase());
                    if (!src || hoursSince(src.lastChange) > w.def.freshnessHours)
                        fresh = false;
                }
            }
            // typed invalid states: a blank, a text or an error is never "within bounds"
            let invalid;
            if (error)
                invalid = 'error';
            else if (w.def.kind === 'check')
                invalid = typeof value === 'boolean' ? undefined : value === null ? 'blank' : 'text';
            else
                invalid = typeof value === 'number' ? undefined : value === null ? 'blank' : 'text';
            // observation identity: one per (definition, period); the same period is revised, never counted twice
            const key = period ?? '';
            const mine = w.observations.filter((o) => o.def === w.defHash);
            let obs = [...mine].reverse().find((o) => (o.period ?? '') === key);
            const earlier = mine.filter((o) => o !== obs).sort(byPeriod);
            const prevOrdered = [...earlier].reverse().find((o) => sortKey(o) <= (period ?? '\uffff') && !o.error && !o.invalid);
            let comparable = true;
            let note;
            if (prevOrdered && typeof prevOrdered.population === 'number' && prevOrdered.population > 0 && population > 0) {
                const ratio = Math.min(prevOrdered.population, population) / Math.max(prevOrdered.population, population);
                if (ratio < 0.5) {
                    comparable = false;
                    note = `coverage changed (${prevOrdered.population} → ${population} rows): not compared with the previous snapshot`;
                }
            }
            let breach = false;
            if (!invalid) {
                if (w.def.kind === 'threshold')
                    breach = typeof value === 'number' && compare(value, w.def.op ?? '>', w.def.value ?? 0);
                else if (w.def.kind === 'check')
                    breach = value === false;
                else if (w.def.kind === 'change')
                    breach = (!!prevOrdered && comparable && prevOrdered.value !== value) || (!!obs && obs.value !== value && !obs.invalid && !obs.error);
                else if (w.def.kind === 'worsening')
                    breach = !!prevOrdered && comparable && typeof value === 'number' && typeof prevOrdered.value === 'number' && (w.def.bad === 'down' ? value < prevOrdered.value : value > prevOrdered.value);
            }
            let novel = false;
            let revised = false;
            if (obs) {
                const changedObs = obs.value !== value || !!obs.error !== !!error || obs.fresh !== fresh || obs.complement !== complementValue || obs.invalid !== invalid || obs.breach !== breach || obs.population !== population;
                if (changedObs) {
                    obs.previous = { value: obs.value, at: obs.at };
                    obs.revisions = (obs.revisions ?? 0) + 1;
                    Object.assign(obs, { at, seq, value, complement: complementValue, error, breach, fresh, invalid, population, comparable: comparable ? undefined : false, note });
                    novel = true;
                    revised = true;
                }
                else
                    obs.seq = seq;
            }
            else {
                obs = { at, seq, period, value, complement: complementValue, error, breach, fresh, def: w.defHash, population, invalid, comparable: comparable ? undefined : false, note };
                w.observations.push(obs);
                novel = true;
            }
            if (novel)
                changed = true;
            w.lastChecked = at;
            // the ordered periods under this definition; the sustained run is counted over them, newest first
            const ordered = w.observations.filter((o) => o.def === w.defHash).sort(byPeriod);
            let run = 0;
            for (let i = ordered.length - 1; i >= 0 && ordered[i].breach && !ordered[i].error && !ordered[i].invalid; i--)
                run++;
            const prevHealth = w.health;
            // a worsening watch needs one more period than its sustain: the one it worsens from
            const needed = w.def.kind === 'worsening' ? w.def.sustain + 1 : w.def.sustain;
            if (invalid === 'error') {
                w.health = 'error';
            }
            else if (invalid) {
                w.health = 'invalid';
            }
            else if (!fresh) {
                w.health = 'stale';
            }
            else if (!comparable) {
                w.health = 'baseline';
            }
            else if (ordered.length < needed) {
                w.health = 'baseline';
            }
            else if (run >= w.def.sustain) {
                w.health = 'attention';
            }
            else {
                w.health = 'ok';
            }
            // one issue per watch: opened when the breach is sustained, strengthened or revised while it lasts,
            // resolved when the period that breached is corrected, or after two later periods within bounds
            if (w.health === 'attention') {
                attention++;
                const trail = ordered.slice(-Math.max(needed, 3));
                const evidence = trail.map((o) => `${whenOf(o)}: ${fmt(o.value)}${o.revisions ? ' (revised)' : ''}`);
                const before = trail.length > 1 ? trail[trail.length - 2] : undefined;
                const movement = revised && obs.previous && obs.previous.value !== value ? ` (revised from ${fmt(obs.previous.value)}, same snapshot${period ? ` ${period}` : ''})` : before && typeof before.value === 'number' && typeof value === 'number' && before.value !== value ? ` (was ${fmt(before.value)} on ${whenOf(before)})` : '';
                const summary = w.def.kind === 'worsening'
                    ? `${w.def.purpose}: ${fmt(value)}${movement} — ${w.def.bad === 'down' ? 'falling' : 'rising'} ${run === 1 ? 'since the last snapshot' : `for ${run} snapshots running`}`
                    : w.def.kind === 'check'
                        ? `${w.def.purpose}: no longer holds${run > 1 ? ` (${run} snapshots running)` : ''}`
                        : `${w.def.purpose}: ${fmt(value)}${movement} — ${ruleText(w.def)}${run > 1 ? `, ${run} snapshots running` : ''}`;
                const uncertainty = [];
                if (w.def.scope)
                    uncertainty.push(`Scope as defined: ${w.def.scope}`);
                if (!period)
                    uncertainty.push('No snapshot period: the figure is the table as edited, not a dated observation');
                const staleOthers = (w.def.sources ?? []).map((n) => sources.find((x) => x.name.toLowerCase() === n.toLowerCase())).filter((x) => x && x.supply === 'import');
                if (staleOthers.length)
                    uncertainty.push(`${staleOthers.map((x) => x.name).join(', ')}: manually supplied snapshot${staleOthers.length > 1 ? 's' : ''}; a newer version may exist`);
                const next = w.def.response === 'case' ? 'Open a decision case: investigate and propose options; nothing is changed by the watch itself.' : w.def.response === 'note' ? 'Noted in the activity; no decision requested.' : 'Investigate before the next decision that depends on this figure; the watch changes nothing by itself.';
                if (!w.issue || w.issue.status !== 'open') {
                    w.issue = { id: newId(), watch: w.id, openedAt: at, updatedAt: at, status: 'open', revision: 1, summary, evidence, uncertainty, next };
                    event(s, { kind: 'issue', text: `Needs attention — ${summary}`, level: 'attention' });
                    changed = true;
                }
                else if (novel) {
                    const moved = obs.previous && typeof obs.previous.value === 'number' && typeof value === 'number' ? (w.def.op === '<' || w.def.op === '<=' ? value < obs.previous.value : value > obs.previous.value) : before && typeof before.value === 'number' && typeof value === 'number' ? (w.def.op === '<' || w.def.op === '<=' ? value < before.value : value > before.value) : false;
                    w.issue.revision++;
                    w.issue.updatedAt = at;
                    w.issue.summary = summary;
                    w.issue.evidence = evidence;
                    w.issue.uncertainty = uncertainty;
                    w.issue.interpretation = undefined; // the words no longer describe the evidence
                    event(s, { kind: 'issue', text: `${moved ? 'Worse again' : 'Still'} — ${summary}`, level: 'attention' });
                    changed = true;
                }
            }
            else if (w.issue && w.issue.status === 'open' && w.health === 'ok') {
                const last = ordered[ordered.length - 1];
                const byRevision = revised && last === obs && !last.breach;
                const backWithin = ordered.length >= 2 && ordered.slice(-2).every((o) => !o.breach && !o.error && !o.invalid);
                if (byRevision || backWithin) {
                    w.issue.status = 'resolved';
                    w.issue.resolvedAt = at;
                    w.issue.updatedAt = at;
                    w.issue.next = byRevision ? `Revised: the ${whenOf(last)} snapshot now reads ${fmt(value)}, within bounds.` : `Back within bounds (${fmt(value)}) on two snapshots.`;
                    w.history.push(w.issue);
                    if (w.history.length > 20)
                        w.history = w.history.slice(-20);
                    event(s, { kind: 'issue', text: `Resolved — ${w.def.purpose} is back within bounds (${fmt(value)})${byRevision ? ' after a revision of the same snapshot' : ''}`, level: 'watch' });
                    w.issue = undefined;
                    changed = true;
                }
            }
            const prevComparable = prevOrdered;
            if (w.health !== prevHealth && !(w.health === 'attention' && prevHealth !== 'attention')) {
                if (w.health === 'stale')
                    event(s, { kind: 'check', text: `Not checked: ${w.def.purpose} — ${(w.def.sources ?? []).join(', ')} older than ${w.def.freshnessHours} h`, level: 'watch' });
                else if (w.health === 'error')
                    event(s, { kind: 'check', text: `Cannot evaluate “${w.def.purpose}”: ${error}`, level: 'watch' });
                else if (w.health === 'invalid')
                    event(s, { kind: 'check', text: `Cannot assess “${w.def.purpose}”: the formula gives ${invalid === 'blank' ? 'no value (blank)' : 'text, not a number'} — neither within bounds nor out of them`, level: 'watch' });
                else if (w.health === 'baseline' && !comparable)
                    event(s, { kind: 'check', text: `${w.def.purpose}: ${fmt(value)} — ${note}; the trend starts again from here`, level: 'watch' });
                else if (w.health === 'baseline' && prevHealth === 'unchecked')
                    event(s, { kind: 'check', text: `${w.def.purpose}: ${fmt(value)} now${period ? ` (${period})` : ''} — watching for the next snapshot before saying more`, level: 'quiet' });
                changed = true;
            }
            else if (novel && !invalid && !error && revised && obs.previous && obs.previous.value !== value && w.health !== 'attention') {
                // the same snapshot read again after a correction or an edit: a revision, not a movement between periods
                event(s, { kind: 'check', text: `${w.def.purpose}: ${fmt(value)} (revised from ${fmt(obs.previous.value)}, same snapshot${period ? ` ${period}` : ''})`, level: breach ? 'watch' : 'quiet' });
            }
            else if (novel && !invalid && !error && !revised && prevComparable && prevComparable.value !== value && w.health !== 'attention' && comparable) {
                // a movement that is not (yet) an issue is worth a look, in plain words
                const worse = w.def.kind === 'worsening' ? breach : w.def.kind === 'threshold' && typeof value === 'number' && typeof prevComparable.value === 'number' ? (w.def.op === '<' || w.def.op === '<=' ? value < prevComparable.value : value > prevComparable.value) : false;
                const tail = w.health === 'baseline' && breach ? ' — watching for another snapshot before raising it' : '';
                event(s, { kind: 'check', text: `${w.def.purpose}: ${fmt(value)} (was ${fmt(prevComparable.value)} on ${whenOf(prevComparable)})${worse ? ', worse' : ''}${tail}`, level: worse || w.def.kind === 'change' ? 'watch' : 'quiet' });
            }
            else if (novel && !invalid && !error && !revised && prevComparable && prevComparable.value === value && typeof complementValue === 'number' && typeof prevComparable.complement === 'number' && complementValue !== prevComparable.complement) {
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
        if (assessDecisions(s, at))
            changed = true;
        if (assessExpectations(s, metas, cellsOf, periodOfTable, sources, at))
            changed = true;
        if (crossCheck(s, metas, cellsOf, at))
            changed = true;
        if (assessReviews(s))
            changed = true;
        attention += s.records.filter((r) => r.kind === 'decision' && LIVE(r) && r.revisit).length;
    }
    finally {
        book.free();
    }
    void reason;
    saveState(s);
    return { attention, changed, affected };
}
/** A decision's conditions: each tied to a watch holds while the watch is not in attention; a failing one asks for the decision to be revisited. */
function assessDecisions(s, at) {
    let changed = false;
    for (const r of s.records) {
        if (r.kind !== 'decision' || !LIVE(r) || !r.conditions?.length)
            continue;
        let failing = null;
        for (const c of r.conditions) {
            if (!c.watch)
                continue;
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
            if (!holds && !failing)
                failing = { c, summary: w.issue?.summary ?? `${w.def.purpose} no longer within bounds` };
        }
        if (failing && !r.revisit) {
            r.revisit = { at, condition: failing.c.text, summary: failing.summary };
            event(s, { kind: 'decision', text: `Revisit “${short(r.text, 100)}”: the condition “${failing.c.text}” no longer appears to hold — ${failing.summary}`, level: 'attention' });
            changed = true;
        }
        else if (!failing && r.revisit) {
            r.revisit = undefined;
            event(s, { kind: 'decision', text: `The conditions behind “${short(r.text, 100)}” hold again`, level: 'quiet' });
            changed = true;
        }
    }
    return changed;
}
/** The three situations an expectation can be in, kept apart in words: the evidence arrived; it has not arrived in a source we did check; we could not check. Whether the event happened is the person's to say. */
export function expectationState(r, metas, cellsOf, periodOfTable, sources) {
    const src = r.source?.trim().toLowerCase();
    const table = src ? metas.find((m) => m.name.toLowerCase() === src) : undefined;
    const period = table ? periodOfTable.get(table.id) : undefined;
    const status = table ? sources.find((x) => x.name === table.name) : undefined;
    const asOf = period ?? (status?.lastChange ? status.lastChange.slice(0, 10) : undefined);
    if (table && r.match && cellsOf) {
        const needle = r.match.toLowerCase();
        const found = cellsOf(table.id).some((c) => c.r >= table.header_rows && c.v && 's' in c.v && c.v.s.toLowerCase().includes(needle));
        if (found)
            return { state: 'met', text: `Arrived: “${r.match}” is in ${table.name}${asOf ? ` (snapshot ${asOf})` : ''}` };
    }
    const due = r.due;
    if (!due || today() < due)
        return { state: 'open', text: `Expected${due ? ` by ${due}` : ''}${r.source ? ` in ${r.source}` : ''}` };
    if (!table)
        return { state: 'unchecked', text: `Not checked: there is no table “${r.source ?? '?'}” to look in — add the source, or say whether it arrived` };
    if (!r.match)
        return { state: 'unchecked', text: `Not checked: nothing to recognise it by in ${table.name} — set what the evidence row would carry, or say whether it arrived` };
    const reached = periodReaches(period, due) ?? (status?.lastChange ? status.lastChange.slice(0, 10) >= due : null);
    if (reached)
        return { state: 'missing', text: `No evidence of it in ${table.name} as of ${asOf} (due ${due}): the evidence has not arrived — or the event did not happen, which is yours to say` };
    return { state: 'unchecked', text: `Not checked: ${table.name} has not been refreshed since ${asOf ?? 'its last snapshot'} (due ${due}) — a newer snapshot would tell` };
}
function assessExpectations(s, metas, cellsOf, periodOfTable, sources, at) {
    let changed = false;
    for (const r of s.records) {
        if (r.kind !== 'expectation' || !LIVE(r))
            continue;
        if (r.expected && (r.expected.state === 'didnt' || (r.expected.state === 'met' && r.expected.text.includes('said so'))))
            continue; // the person's word stands
        const next = expectationState(r, metas, cellsOf, periodOfTable, sources);
        if (!r.expected || r.expected.state !== next.state || r.expected.text !== next.text) {
            const was = r.expected?.state;
            r.expected = { ...next, at };
            if (next.state !== 'open' && next.state !== was)
                event(s, { kind: 'expectation', text: `${short(r.text, 100)} — ${next.text}`, level: next.state === 'missing' ? 'watch' : next.state === 'met' ? 'quiet' : 'watch' });
            changed = true;
        }
    }
    return changed;
}
/** Consequential assumptions carry a review date: past it, they are asked to be reconfirmed, once. */
function assessReviews(s) {
    let changed = false;
    const t = today();
    for (const r of s.records) {
        if (!LIVE(r) || !r.reviewBy || r.reviewRaised || r.reviewBy > t)
            continue;
        r.reviewRaised = true;
        event(s, { kind: 'assumption', text: `Reconfirm “${short(r.text, 100)}” — set ${r.arrivedAt.slice(0, 10)}, review by ${r.reviewBy}; the circumstances it was made under may have changed`, level: 'watch' });
        changed = true;
    }
    return changed;
}
// ------------------------------------------------------------------ conflicts between sources
const ID_HEADER = /\b(vin|id|ref|reference|chassis|invoice|factura|fatura|cheque|no\.?|number|code|c[oó]digo|matr[ií]cula|plate)\b/i;
const normHeader = (h) => h.trim().toLowerCase().replace(/\s+/g, ' ');
function columnsOf(cells, t) {
    const out = [];
    for (const c of cells) {
        if (c.r !== t.header_rows - 1 || !c.v || !('s' in c.v) || !c.v.s.trim())
            continue;
        out.push({ index: c.c, header: c.v.s.trim(), key: normHeader(c.v.s) });
    }
    return out;
}
/** Two tables that both carry an identifier and a figure under the same header should agree row by row; where they do not, the conflict is kept, with what depends on it. */
function crossCheck(s, metas, cellsOf, at) {
    if (!cellsOf)
        return false;
    const tables = metas.filter((t) => !t.pivot && t.header_rows >= 1 && t.rows - t.header_rows >= 1);
    if (tables.length < 2)
        return false;
    // two snapshots of one series (the current one and a historical one) are the same source at two times, not two sources
    const seriesOf = new Map();
    for (const r of s.records)
        if (r.kind === 'source' && r.source && r.status !== 'retired')
            for (const l of r.links ?? [])
                if (typeof l.table === 'number')
                    seriesOf.set(l.table, r.source.replace(/\s*\(history\)$/, '').toLowerCase());
    const seen = new Set();
    let changed = false;
    const watchesReading = (header, names) => s.watches.filter((w) => names.some((n) => w.def.formula.toLowerCase().includes(`${n.toLowerCase()}[${header.toLowerCase()}]`) || w.def.formula.toLowerCase().includes(`'${n.toLowerCase()}'[${header.toLowerCase()}]`))).map((w) => w.def.purpose);
    for (let i = 0; i < tables.length; i++) {
        for (let j = i + 1; j < tables.length; j++) {
            const a = tables[i];
            const b = tables[j];
            if (seriesOf.get(a.id) && seriesOf.get(a.id) === seriesOf.get(b.id))
                continue;
            const ca = columnsOf(cellsOf(a.id), a);
            const cb = columnsOf(cellsOf(b.id), b);
            const idA = ca.find((c) => ID_HEADER.test(c.header.replace(/_+/g, ' ')) && cb.some((d) => d.key === c.key));
            if (!idA)
                continue;
            const idB = cb.find((d) => d.key === idA.key);
            const shared = ca.filter((c) => c.key !== idA.key && cb.some((d) => d.key === c.key));
            if (!shared.length)
                continue;
            const rowsOf = (t, idCol, valCol) => {
                const m = new Map();
                const byRow = new Map();
                for (const c of cellsOf(t.id)) {
                    if (c.r < t.header_rows)
                        continue;
                    const e = byRow.get(c.r) ?? {};
                    if (c.c === idCol && c.v && 's' in c.v)
                        e.id = c.v.s.trim().toLowerCase();
                    if (c.c === idCol && c.v && 'n' in c.v)
                        e.id = String(c.v.n);
                    if (c.c === valCol && c.v && 'n' in c.v)
                        e.v = c.v.n;
                    byRow.set(c.r, e);
                }
                for (const e of byRow.values())
                    if (e.id && typeof e.v === 'number' && !m.has(e.id))
                        m.set(e.id, e.v);
                return m;
            };
            for (const col of shared) {
                const other = cb.find((d) => d.key === col.key);
                const ra = rowsOf(a, idA.index, col.index);
                const rb = rowsOf(b, idB.index, other.index);
                let n = 0;
                for (const [id, va] of ra) {
                    const vb = rb.get(id);
                    if (vb === undefined)
                        continue;
                    const key = `conflict:${a.id}:${b.id}:${col.key}:${id}`;
                    seen.add(key);
                    const differs = Math.abs(va - vb) > Math.max(0.005 * Math.max(Math.abs(va), Math.abs(vb)), 1e-9);
                    const existing = s.records.find((r) => r.key === key);
                    if (differs) {
                        if (n++ >= 20)
                            break;
                        if (existing && LIVE(existing))
                            continue;
                        if (existing && existing.status === 'resolved' && existing.resolution && !existing.resolution.startsWith('the sources now agree'))
                            continue; // settled by a person: the difference is known
                        const depends = watchesReading(col.header, [a.name, b.name]);
                        const bearing = depends.length ? `bears on: ${depends.join(', ')}` : `any figure built on ${col.header}`;
                        const r = { id: newId(), kind: 'contradiction', text: `${col.header} of ${id.toUpperCase()}: ${a.name} says ${fmt(va)}, ${b.name} says ${fmt(vb)}`, source: `${a.name} ↔ ${b.name}`, arrivedAt: at, by: { id: 'companion', name: 'the companion' }, origin: 'system', status: 'observed', links: [{ table: a.id }, { table: b.id }], bearing, key };
                        s.records.push(r);
                        event(s, { kind: 'conflict', text: `Sources disagree — ${r.text}; ${bearing}. Both are kept until one is confirmed`, level: 'watch' });
                        changed = true;
                    }
                    else if (existing && LIVE(existing)) {
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
export const q = (name) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`);
export const col = (table, header) => `${q(table)}[${header}]`;
export function profileTable(cells, t) {
    const out = [];
    const byCol = new Map();
    for (const c of cells) {
        if (c.r < t.header_rows)
            continue;
        if (!byCol.has(c.c))
            byCol.set(c.c, []);
        byCol.get(c.c).push(c);
    }
    const headerOf = (c) => {
        const h = cells.find((x) => x.r === t.header_rows - 1 && x.c === c);
        return h && h.v && 's' in h.v ? h.v.s.trim() : '';
    };
    const dataRows = Math.max(0, t.rows - t.header_rows);
    for (let c = 0; c < t.cols; c++) {
        const header = headerOf(c);
        if (!header)
            continue;
        const vals = byCol.get(c) ?? [];
        const prof = { index: c, header, n: dataRows, blanks: 0, numbers: 0, unique: 0, yesNo: 0, dates: 0, max: 0 };
        const seen = new Set();
        let filled = 0;
        for (const v of vals) {
            if (!v.v || ('s' in v.v && !v.v.s.trim()))
                continue;
            filled++;
            const key = 'n' in v.v ? String(v.v.n) : 's' in v.v ? v.v.s.trim().toLowerCase() : JSON.stringify(v.v);
            seen.add(key);
            if ('n' in v.v) {
                prof.numbers++;
                prof.max = Math.max(prof.max, v.v.n);
                if (v.f?.number_format && /[dmy]/i.test(v.f.number_format) && !/[#0]/.test(v.f.number_format))
                    prof.dates++;
            }
            else if ('s' in v.v) {
                if (/^(yes|no|y|n|sim|não|nao|true|false)$/i.test(v.v.s.trim()))
                    prof.yesNo++;
                if (/^\d{4}-\d{2}-\d{2}/.test(v.v.s.trim()))
                    prof.dates++;
            }
            else if ('b' in v.v)
                prof.yesNo++;
        }
        prof.blanks = dataRows - filled;
        prof.unique = seen.size;
        out.push(prof);
    }
    return out;
}
export function suggestWatches(doc, includeDismissed = false) {
    if (!engineAvailable() || !readFile(doc))
        return [];
    const s = loadState(doc);
    const have = new Set(s.watches.map((w) => w.def.formula.replace(/\s+/g, '')));
    const periods = periodsOf(s);
    const latestPeriod = [...periods.values()].sort().pop();
    const dismissed = new Map((s.dismissed ?? []).map((d) => [d.id, d]));
    const out = [];
    const add = (id, purpose, why, def) => {
        const d = normaliseDef({ sustain: 2, response: 'brief', ...def, purpose });
        if (have.has(d.formula.replace(/\s+/g, '')))
            return;
        const dm = dismissed.get(id);
        // "not now" comes back with the next snapshot; "not relevant" and "incorrect" stay aside until brought back
        if (dm && !includeDismissed && (dm.reason !== 'not now' || !latestPeriod || dm.period === latestPeriod || !dm.period))
            return;
        out.push({ id, purpose, why, def: d });
    };
    const { book } = openDocument(doc);
    try {
        for (const t of tableMetas(book)) {
            if (t.pivot || t.header_rows < 1 || t.rows - t.header_rows < 2)
                continue;
            const cells = JSON.parse(book.cells(t.id));
            const cols = profileTable(cells, t);
            const dataRows = t.rows - t.header_rows;
            const mostly = (p, k) => p[k] >= Math.max(1, (dataRows - p.blanks) * 0.8);
            const flag = cols.find((p) => mostly(p, 'yesNo') && /reserv|hold|sold|exclu|vendid|block/i.test(p.header)) ?? cols.find((p) => mostly(p, 'yesNo'));
            const flagText = flag ? ` (excluding ${flag.header} = yes)` : '';
            const flagCond = flag ? `, ${col(t.name, flag.header)}, "no"` : '';
            const flagYes = flag ? `, ${col(t.name, flag.header)}, "yes"` : '';
            const rowWord = /vehic|viatur|carro|stock|invent/i.test(t.name) ? 'vehicles' : 'rows';
            const prefix = tableMetas(book).filter((m) => !m.pivot && m.header_rows >= 1 && m.rows - m.header_rows >= 2).length > 1 ? `${t.name}: ` : '';
            const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
            // a row exists when its key column is filled: spare empty rows at the foot of a table are not "missing" anything
            const keyCol = cols.find((p) => !mostly(p, 'numbers') && p.unique >= Math.max(2, (dataRows - p.blanks) * 0.7)) ?? cols[0];
            const present = keyCol ? `, ${col(t.name, keyCol.header)}, "<>"` : '';
            for (const p of cols) {
                const h = p.header;
                if (mostly(p, 'numbers') && /\b(days?|age|ageing|aging|dias|idade)\b/i.test(h) && p.max > 30) {
                    const limit = p.max >= 90 ? 90 : 30;
                    add(`${t.id}:${p.index}:age`, cap(`${prefix}${rowWord} over ${limit} ${/dias/i.test(h) ? 'dias' : 'days'}${flag ? ' (excl. reserved)' : ''}`), `“${h}” reads like days in stock; ageing beyond ${limit} days usually needs a decision${flag ? `; ${flag.header} = yes is left out, and watched alongside so the exclusion cannot hide a movement` : ''}`, { formula: flag ? `=COUNTIFS(${col(t.name, h)}, ">${limit}"${flagCond})` : `=COUNTIF(${col(t.name, h)}, ">${limit}")`, complement: flag ? `=COUNTIFS(${col(t.name, h)}, ">${limit}"${flagYes})` : undefined, kind: 'worsening', bad: 'up', scope: `${t.name}${flagText}`, sources: [t.name] });
                }
                else if (mostly(p, 'dates') && /date|data|entr|receiv|arriv|in\b/i.test(h)) {
                    add(`${t.id}:${p.index}:since`, cap(`${prefix}${rowWord} older than 90 days${flag ? ' (excl. reserved)' : ''}`), `“${h}” is a date; counting what is older than 90 days from today${flag ? `; ${flag.header} = yes is left out` : ''}`, { formula: flag ? `=COUNTIFS(${col(t.name, h)}, "<"&(TODAY()-90)${flagCond})` : `=COUNTIF(${col(t.name, h)}, "<"&(TODAY()-90))`, complement: flag ? `=COUNTIFS(${col(t.name, h)}, "<"&(TODAY()-90)${flagYes})` : undefined, kind: 'worsening', bad: 'up', scope: `${t.name}${flagText}`, sources: [t.name] });
                }
                if (mostly(p, 'numbers') && !mostly(p, 'dates') && /cost|amount|value|price|total|valor|custo|montante|pre[cç]o|margin|margem|landed|cif|fob/i.test(h) && !/days|dias/i.test(h)) {
                    add(`${t.id}:${p.index}:blank`, cap(`${prefix}${rowWord} with no ${h.toLowerCase()}`), `a missing ${h.toLowerCase()} makes a margin or a total provisional`, { formula: `=COUNTIFS(${col(t.name, h)}, ""${present})`, kind: 'threshold', op: '>', value: 0, sustain: 1, scope: t.name, sources: [t.name] });
                    add(`${t.id}:${p.index}:total`, cap(`${prefix}total ${h.toLowerCase()}`), `the total moves when a snapshot changes; a movement is worth a look, not an alarm`, { formula: `=SUM(${col(t.name, h)})`, kind: 'change', sustain: 1, scope: t.name, sources: [t.name] });
                }
                if (!mostly(p, 'numbers') && ID_HEADER.test(h.replace(/_+/g, ' ')) && p.unique >= Math.max(2, (dataRows - p.blanks) * 0.7)) {
                    add(`${t.id}:${p.index}:dup`, cap(`${prefix}duplicate ${h}${/s$/i.test(h) ? '' : 's'}`), `“${h}” looks like an identifier; a duplicate is usually a posting error`, { formula: `=COUNTA(${col(t.name, h)}) - COUNTUNIQUE(${col(t.name, h)})`, kind: 'threshold', op: '>', value: 0, sustain: 1, scope: t.name, sources: [t.name] });
                }
            }
        }
    }
    finally {
        book.free();
    }
    const rank = (x) => (x.id.endsWith(':age') || x.id.endsWith(':since') ? 0 : x.id.endsWith(':blank') ? 1 : x.id.endsWith(':dup') ? 2 : 3);
    return out.sort((a, b) => rank(a) - rank(b)).slice(0, 8);
}
/** Set a suggestion aside with a reason: "not now" returns with the next snapshot; the others wait to be brought back. Reviewable, so that silence is never unexamined. */
export function dismissSuggestion(doc, by, input) {
    const s = loadState(doc);
    const id = String(input.id ?? '').slice(0, 80);
    if (!id)
        throw new Error('id required');
    const reason = input.reason === 'not relevant' || input.reason === 'incorrect' ? input.reason : 'not now';
    const latestPeriod = [...periodsOf(s).values()].sort().pop();
    s.dismissed = (s.dismissed ?? []).filter((d) => d.id !== id);
    const d = { id, purpose: String(input.purpose ?? id).slice(0, 300), reason, at: now(), by: who(by), period: latestPeriod };
    s.dismissed.push(d);
    event(s, { kind: 'trace', text: `Set aside “${d.purpose}” — ${reason}`, by: who(by), level: 'quiet' });
    saveState(s);
    return d;
}
export function restoreSuggestion(doc, by, id) {
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
// ------------------------------------------------------------------ scheduling
const timers = new Map();
let notify = null;
export function setCompanionNotifier(fn) {
    notify = fn;
}
const pendingTables = new Map();
/** Re-check a document shortly after it changed (debounced: a burst of edits is one check). */
export function scheduleCheck(doc, table, delayMs = 1500) {
    if (!hasCompanion(doc))
        return;
    if (typeof table === 'number') {
        if (!pendingTables.has(doc))
            pendingTables.set(doc, new Set());
        pendingTables.get(doc).add(table);
    }
    const t = timers.get(doc);
    if (t)
        clearTimeout(t);
    timers.set(doc, setTimeout(() => {
        timers.delete(doc);
        const tables = [...(pendingTables.get(doc) ?? [])];
        pendingTables.delete(doc);
        try {
            const r = checkDocument(doc, 'change', tables);
            if (r.changed)
                notify?.(doc, { attention: r.attention });
        }
        catch (e) {
            console.error('companion check failed:', errorMessage(e));
        }
    }, delayMs));
}
/** Persistent monitoring: every change schedules a check; a timer re-checks freshness between sessions. */
export function startCompanion(intervalMs = 10 * 60_000) {
    onAppend((doc, entry) => scheduleCheck(doc, typeof entry.op?.table === 'number' ? entry.op.table : entry.run?.table));
    const tick = () => {
        if (!existsSync(DIR()))
            return;
        for (const f of readdirSync(DIR())) {
            if (!f.endsWith('.json'))
                continue;
            const doc = f.slice(0, -5);
            try {
                const r = checkDocument(doc, 'timer');
                if (r.changed)
                    notify?.(doc, { attention: r.attention });
            }
            catch (e) {
                console.error('companion timer check failed:', errorMessage(e));
            }
        }
    };
    const h = setInterval(tick, intervalMs);
    h.unref();
}
export function setInterpretation(doc, issueId, interpretation) {
    const s = loadState(doc);
    const w = s.watches.find((x) => x.issue?.id === issueId);
    if (!w || !w.issue)
        throw new Error('issue not found');
    w.issue.interpretation = interpretation;
    saveState(s);
    return w.issue;
}
export function findIssue(doc, issueId) {
    const s = loadState(doc);
    const w = s.watches.find((x) => x.issue?.id === issueId);
    return w && w.issue ? { watch: w, issue: w.issue } : null;
}
export function openIssues(doc) {
    return loadState(doc)
        .watches.map((w) => w.issue)
        .filter((i) => !!i && i.status === 'open');
}

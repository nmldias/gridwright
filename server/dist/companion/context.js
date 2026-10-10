// Context and decisions: the records a person states, an agent proposes or a check observes —
// facts, sources, objectives, constraints, exclusions, hypotheses, contradictions, decisions with
// their conditions, questions, expectations, scenarios — their life cycle (stated → confirmed →
// resolved / retired / superseded), the applied scope an exclusion maps to, the understanding
// (what we are working toward, what matters now, the next useful move), the brief, and the
// context given to a model — the person's words as theirs, an agent's as its own.
import { engineAvailable, openDocument, tableMetas } from '../headless.js';
import { newId, readFile } from '../storage.js';
import { ASSUMPTION_KINDS, bumpAssumptions, event, fenceRunning, hasCompanion, LIVE, loadState, now, RECORD_KINDS, safeId, saveState, short, today, who } from './state.js';
import { comparePeriods, graphOf, periodsOf, tablesReferenced } from './relations.js';
import { col, profileTable, sourceStatus, updateWatch } from './monitoring.js';
const str = (v, n) => (v === undefined || v === null ? undefined : String(v).trim().slice(0, n) || undefined);
const isoDate = (v) => {
    const t = str(v, 20);
    return t && /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : undefined;
};
const conditionsOf = (v) => {
    if (!Array.isArray(v))
        return undefined;
    const out = [];
    for (const c of v.slice(0, 12)) {
        if (typeof c === 'string') {
            const text = c.trim().slice(0, 300);
            if (text)
                out.push({ text });
        }
        else if (c && typeof c === 'object' && typeof c.text === 'string') {
            const text = c.text.trim().slice(0, 300);
            const w = c.watch;
            if (text)
                out.push({ text, watch: typeof w === 'string' && safeId(w) ? w : undefined, holds: c.holds, since: c.since });
        }
    }
    return out;
};
/** A file name that says the material was generated: a brief, a summary, an export of the companion's own output. */
export const looksDerivative = (name) => /gridwright|companion|brief|summary|resumo|sumário/i.test(name);
export function addRecord(doc, by, origin, input) {
    const s = loadState(doc);
    if (!RECORD_KINDS.includes(input.kind))
        throw new Error(`kind must be one of ${RECORD_KINDS.join(', ')}`);
    const text = String(input.text ?? '').trim().slice(0, 2000);
    if (!text)
        throw new Error('text required');
    const r = {
        id: newId(),
        kind: input.kind,
        text,
        source: str(input.source, 300),
        period: str(input.period, 80),
        arrivedAt: now(),
        by,
        origin,
        // a person's words stand; an agent's reading waits for a person; a check's finding is observed
        status: origin === 'agent' ? 'proposed' : origin === 'system' ? 'observed' : 'stated',
        links: input.links,
        bearing: str(input.bearing, 500),
        due: isoDate(input.due),
        match: str(input.match, 120),
        reviewBy: isoDate(input.reviewBy),
        why: str(input.why, 1000),
        conditions: conditionsOf(input.conditions),
        private: input.private ? true : undefined,
        derivative: input.derivative ? true : undefined,
        key: str(input.key, 200),
    };
    if (r.kind === 'source' && !r.derivative && looksDerivative(r.source ?? ''))
        r.derivative = true;
    if (input.inferred)
        r.inferred = true;
    r.intake = str(input.intake, 80);
    if (input.coverage && typeof input.coverage === 'object')
        r.coverage = { rows: Number(input.coverage.rows) || 0, identifiers: input.coverage.identifiers, idColumn: str(input.coverage.idColumn, 80), entity: str(input.coverage.entity, 120) };
    // a newer period of the same series supersedes the earlier one — authority is by source and period, not by arrival:
    // an older period arriving later is kept as history, and an agent's snapshot never displaces what a person supplied
    let historyNote = '';
    if (r.kind === 'source' && r.source) {
        // the current snapshot is the latest one a person supplied or confirmed; an agent's proposal is never current
        const current = [...s.records].reverse().find((old) => old.kind === 'source' && old.source === r.source && LIVE(old) && old.status !== 'proposed');
        // an agent's proposed snapshot that a person's delivery overtakes is superseded with it
        if (origin !== 'agent')
            for (const old of s.records)
                if (old.kind === 'source' && old.source === r.source && old.status === 'proposed' && (!old.period || !r.period || (comparePeriods(old.period, r.period) ?? -1) <= 0)) {
                    old.status = 'superseded';
                    old.supersededBy = r.id;
                }
        if (current) {
            const order = r.period && current.period ? comparePeriods(r.period, current.period) : null;
            if (origin === 'agent' && current.origin !== 'agent') {
                historyNote = ` — proposed by an agent: ${current.period ? `the ${current.period} snapshot` : 'the current snapshot'} stays current until a person confirms this one`;
            }
            else if (order !== null && order < 0) {
                r.historical = true;
                r.status = 'superseded';
                r.supersededBy = current.id;
                historyNote = ` — older than the current ${current.period} snapshot: kept as history, the current one stands`;
            }
            else {
                current.status = 'superseded';
                current.supersededBy = r.id;
                if (order === 0)
                    historyNote = ` — a re-delivery of ${r.period}: the earlier version of that period is replaced, not counted twice`;
            }
        }
    }
    s.records.push(r);
    const label = r.kind === 'objective' ? 'what matters' : r.kind === 'exclusion' ? 'what to leave out' : r.kind === 'expectation' ? 'what is expected' : r.kind === 'scenario' ? 'a scenario (not a policy)' : r.kind;
    const shown = r.kind === 'source' ? text.replace(/\s*\(.*\)\s*$/, '') + (r.period ? ` (period ${r.period})` : '') + (r.derivative ? ' — generated material, not independent evidence' : '') + historyNote : `${origin === 'agent' ? 'Proposed' : origin === 'system' ? 'Found' : 'Kept'} ${label}: ${short(text)}${r.kind === 'expectation' && r.due ? ` (by ${r.due}${r.source ? ` in ${r.source}` : ''})` : ''}`;
    event(s, { kind: r.kind === 'source' ? 'source' : r.kind === 'expectation' ? 'expectation' : r.kind === 'contradiction' && origin === 'system' ? 'conflict' : 'record', text: shown, by: who(by), level: 'quiet' });
    if (ASSUMPTION_KINDS.includes(r.kind) && origin === 'user')
        bumpAssumptions(s, r, 'added', by);
    if (input.steer && origin === 'user') {
        // a change of direction: the next investigation changes; what was concluded under the earlier direction is provisional
        s.assumptionsSeq = (s.assumptionsSeq ?? 0) + 1;
        fenceRunning(s, 'direction changed');
        event(s, { kind: 'assumption', text: `Direction changed: ${short(text, 120)} — running work is superseded; earlier results are kept as history, not as current`, by: who(by), level: 'watch' });
    }
    saveState(s);
    return r;
}
export function updateRecord(doc, id, by, patch) {
    const s = loadState(doc);
    const r = s.records.find((x) => x.id === id);
    if (!r)
        throw new Error('record not found');
    const wasAssumption = ASSUMPTION_KINDS.includes(r.kind);
    let framed = false;
    if (patch.text !== undefined) {
        const t = String(patch.text).trim().slice(0, 2000);
        if (t && t !== r.text) {
            r.text = t;
            framed = true;
        }
    }
    if (patch.period !== undefined)
        r.period = str(patch.period, 80);
    if (patch.source !== undefined)
        r.source = str(patch.source, 300);
    if (patch.kind && RECORD_KINDS.includes(patch.kind) && patch.kind !== r.kind) {
        r.kind = patch.kind;
        framed = true;
    }
    if (patch.bearing !== undefined)
        r.bearing = str(patch.bearing, 500);
    if (patch.due !== undefined)
        r.due = isoDate(patch.due);
    if (patch.match !== undefined)
        r.match = str(patch.match, 120);
    if (patch.reviewBy !== undefined) {
        r.reviewBy = isoDate(patch.reviewBy);
        r.reviewRaised = undefined;
    }
    if (patch.why !== undefined)
        r.why = str(patch.why, 1000);
    if (patch.conditions !== undefined) {
        const next = conditionsOf(patch.conditions) ?? [];
        // keep what the checks know about conditions that stayed
        for (const c of next) {
            const prev = r.conditions?.find((p) => p.text === c.text && p.watch === c.watch);
            if (prev && c.holds === undefined) {
                c.holds = prev.holds;
                c.since = prev.since;
            }
        }
        r.conditions = next;
    }
    if (patch.private !== undefined)
        r.private = patch.private ? true : undefined;
    if (patch.derivative !== undefined)
        r.derivative = patch.derivative ? true : undefined;
    if (patch.inferred === false && r.inferred) {
        r.inferred = undefined;
        event(s, { kind: 'record', text: `Confirmed the reading: ${r.kind} “${short(r.text, 100)}”`, by: who(by), level: 'quiet' });
    }
    if (patch.resolution !== undefined)
        r.resolution = str(patch.resolution, 1000);
    if (patch.expected) {
        const text = patch.expected === 'met' ? `Arrived — ${who(by)} said so` : patch.expected === 'didnt' ? `Did not happen — ${who(by)} said so` : `Open again`;
        r.expected = { state: patch.expected, text, at: now() };
        event(s, { kind: 'expectation', text: `${short(r.text, 100)}: ${text}`, by: who(by), level: 'quiet' });
    }
    if (patch.status) {
        r.status = patch.status;
        const verb = patch.status === 'retired' ? 'Retired' : patch.status === 'confirmed' ? 'Confirmed' : patch.status === 'resolved' ? 'Resolved' : 'Corrected';
        event(s, { kind: 'record', text: `${verb} ${r.kind}: ${short(r.text)}${patch.status === 'resolved' && r.resolution ? ` — ${short(r.resolution, 120)}` : ''}`, by: who(by), level: 'quiet' });
        if (patch.status === 'retired' && wasAssumption)
            bumpAssumptions(s, r, 'retired', by);
    }
    else if (framed || patch.period !== undefined || patch.conditions !== undefined || patch.why !== undefined) {
        event(s, { kind: 'record', text: `Corrected ${r.kind}: ${short(r.text)}`, by: who(by), level: 'quiet' });
    }
    if (framed && (wasAssumption || ASSUMPTION_KINDS.includes(r.kind)) && !patch.status)
        bumpAssumptions(s, r, 'changed', by);
    saveState(s);
    return r;
}
export function removeRecord(doc, id, by) {
    const s = loadState(doc);
    const i = s.records.findIndex((x) => x.id === id);
    if (i < 0)
        return false;
    const [r] = s.records.splice(i, 1);
    event(s, { kind: 'record', text: `Removed ${r.kind}: ${short(r.text, 120)}`, by: who(by), level: 'quiet' });
    if (ASSUMPTION_KINDS.includes(r.kind) && LIVE(r))
        bumpAssumptions(s, r, 'removed', by);
    saveState(s);
    return true;
}
/** A rejected proposal is a decision with a reason: the context carries it so that the same action is not proposed again unchanged. */
export function recordRejection(doc, by, p) {
    if (!hasCompanion(doc) && !readFile(doc))
        return null;
    const s = loadState(doc);
    const key = `rejected:${p.id}`;
    if (s.records.some((r) => r.key === key))
        return null;
    const r = { id: newId(), kind: 'decision', text: `Rejected “${short(p.title, 120)}”${p.note ? ` — ${short(p.note, 300)}` : ''}`, source: `proposal ${p.id} by ${p.agent}`, why: p.note ? short(p.note, 300) : undefined, arrivedAt: now(), by, origin: 'user', status: 'stated', key };
    s.records.push(r);
    event(s, { kind: 'decision', text: short(r.text), by: who(by), level: 'quiet' });
    saveState(s);
    return r;
}
// ------------------------------------------------------------------ the understanding
/** What we are working toward, what we rest on, what stands, what is uncertain (ranked by what it bears on), and the one next move. */
export function understandingOf(doc, s = loadState(doc)) {
    const live = s.records.filter(LIVE);
    const objective = [...live].reverse().find((r) => r.kind === 'objective' && r.status !== 'proposed');
    const constraints = live.filter((r) => r.kind === 'constraint' && r.status !== 'proposed');
    const exclusions = live.filter((r) => r.kind === 'exclusion' && r.status !== 'proposed');
    const sources = sourceStatus(doc, undefined, s);
    const periodOfTable = periodsOf(s);
    let metas = [];
    let cellsOf = null;
    let book = null;
    if (engineAvailable() && readFile(doc)) {
        try {
            book = openDocument(doc).book;
            metas = tableMetas(book);
            const b = book;
            const cache = new Map();
            cellsOf = (id) => {
                if (!cache.has(id))
                    cache.set(id, JSON.parse(b.cells(id)));
                return cache.get(id);
            };
        }
        catch {
            book = null;
        }
    }
    try {
        const derivativeTables = new Set();
        for (const r of live)
            if (r.kind === 'source' && r.derivative)
                for (const l of r.links ?? [])
                    if (typeof l.table === 'number')
                        derivativeTables.add(l.table);
        const coverage = metas.map((t) => {
            const st = sources.find((x) => x.name === t.name);
            return { name: t.name, period: periodOfTable.get(t.id), rows: Math.max(0, t.rows - t.header_rows), supply: st?.supply ?? 'unknown', lastChange: st?.lastChange, derivative: derivativeTables.has(t.id) || undefined };
        });
        const decisions = live
            .filter((r) => r.kind === 'decision' && !r.key?.startsWith('rejected:'))
            .map((r) => ({ record: r, conditions: (r.conditions ?? []).map((c) => ({ ...c, purpose: c.watch ? s.watches.find((w) => w.id === c.watch)?.def.purpose : undefined })), revisit: r.revisit }));
        const expectations = live.filter((r) => r.kind === 'expectation');
        const scope = cellsOf ? scopeStates(s, exclusions, metas, cellsOf) : [];
        const uncertain = [];
        for (const r of live) {
            if (r.kind === 'question')
                uncertain.push({ kind: 'question', text: r.text, bearing: r.bearing, record: r.id, rank: r.bearing ? 1 : 3 });
            else if (r.kind === 'contradiction')
                uncertain.push({ kind: 'contradiction', text: r.text, bearing: r.bearing, record: r.id, rank: r.status === 'proposed' ? 3 : 1 }); // a kept conflict is material until someone settles it
            else if (r.kind === 'expectation') {
                const st = r.expected?.state ?? (r.due && today() >= r.due ? 'unchecked' : 'open');
                if (st === 'missing')
                    uncertain.push({ kind: 'expectation', text: `${r.text} — ${r.expected?.text ?? 'no evidence yet'}`, bearing: r.bearing, record: r.id, rank: r.bearing ? 0 : 2 });
                else if (st === 'unchecked')
                    uncertain.push({ kind: 'expectation', text: `${r.text} — ${r.expected?.text ?? 'not checked yet'}`, bearing: r.bearing, record: r.id, rank: 4 });
            }
            else if (r.kind === 'hypothesis' && r.status !== 'confirmed')
                uncertain.push({ kind: 'hypothesis', text: r.text, bearing: r.bearing, record: r.id, rank: r.bearing ? 2 : 5 });
            if (r.reviewBy && r.reviewBy <= today() && r.kind !== 'expectation')
                uncertain.push({ kind: 'review', text: `${r.kind} “${short(r.text, 100)}” is due for reconfirmation (review by ${r.reviewBy})`, record: r.id, rank: 3 });
            if (r.status === 'proposed')
                uncertain.push({ kind: 'proposed', text: `${r.kind} proposed by ${who(r.by)}: ${short(r.text, 120)} — confirm or retire`, record: r.id, rank: 6 });
        }
        for (const w of s.watches) {
            if (w.issue?.status === 'open' && /with no |blank|missing|sem /i.test(w.def.purpose))
                uncertain.push({ kind: 'provisional', text: `${w.issue.summary} — any margin or total built on that column is provisional`, watch: w.id, rank: 4 });
            if (w.health === 'stale')
                uncertain.push({ kind: 'stale', text: `“${w.def.purpose}” is not checked: ${(w.def.sources ?? []).join(', ')} not refreshed within ${w.def.freshnessHours} h`, watch: w.id, rank: 4 });
        }
        uncertain.sort((a, b) => a.rank - b.rank);
        const revisit = decisions.find((d) => d.revisit);
        const issues = s.watches.filter((w) => w.issue?.status === 'open');
        const attention = issues.length + decisions.filter((d) => d.revisit).length;
        const since = s.seenAt ? Date.parse(s.seenAt) : 0;
        const worthALook = s.events.some((e) => e.level === 'watch' && Date.parse(e.at) > since);
        const material = uncertain.find((u) => u.rank <= 2);
        // monitoring, truthfully: a failed or impossible check is never "all quiet"
        const approved = s.watches.filter((w) => w.authority === 'approved');
        const cannot = approved.filter((w) => w.health === 'error' || w.health === 'invalid' || w.health === 'stale');
        const awaiting = approved.filter((w) => w.health === 'baseline' || w.health === 'unchecked');
        const monitoring = !approved.length
            ? { state: 'not configured', text: 'Nothing is being watched yet.', cannotAssess: 0 }
            : issues.length || revisit
                ? { state: 'action needed', text: `${attention} need${attention === 1 ? 's' : ''} attention${cannot.length ? `; ${cannot.length} cannot be assessed` : ''}.`, cannotAssess: cannot.length }
                : cannot.length === approved.length
                    ? { state: cannot.every((w) => w.health === 'stale') ? 'source stale' : 'cannot assess', text: `${cannot.length} watch${cannot.length === 1 ? '' : 'es'} cannot be assessed: ${cannot.map((w) => `${w.def.purpose} (${w.health === 'stale' ? 'source stale' : w.health === 'error' ? 'formula error' : 'blank or text where a number should be'})`).join('; ')}.`, cannotAssess: cannot.length }
                    : cannot.length
                        ? { state: 'partially assessed', text: `${approved.length - cannot.length} of ${approved.length} watches assessed; ${cannot.length} cannot be assessed: ${cannot.map((w) => `${w.def.purpose} (${w.health === 'stale' ? 'source stale' : w.health === 'error' ? 'formula error' : 'blank or text'})`).join('; ')}.`, cannotAssess: cannot.length }
                        : awaiting.length === approved.length
                            ? { state: 'awaiting history', text: `${awaiting.length} watch${awaiting.length === 1 ? '' : 'es'} waiting for the next snapshot — no conclusion yet, which is a valid state.`, cannotAssess: 0 }
                            : { state: 'checked, no material issue', text: `${approved.length} watch${approved.length === 1 ? '' : 'es'} checked, no material issue${awaiting.length ? `; ${awaiting.length} still building a baseline` : ''}.`, cannotAssess: 0 };
        let stance;
        let lead;
        let next;
        if (revisit) {
            stance = 'decision';
            lead = 'A decision needs another look';
            next = `Revisit “${short(revisit.record.text, 80)}”: the condition “${revisit.revisit.condition}” no longer appears to hold — ${revisit.revisit.summary}.`;
        }
        else if (issues.length) {
            stance = 'decision';
            lead = `${issues.length} need${issues.length === 1 ? 's' : ''} attention`;
            next = issues[0].issue.next;
        }
        else if (material) {
            stance = 'question';
            lead = material.kind === 'expectation' ? 'Something expected has not arrived' : material.kind === 'contradiction' ? 'Two sources disagree' : 'One question could change the decision';
            next = material.kind === 'expectation' ? `Chase it: ${material.text}` : material.kind === 'contradiction' ? `Settle which source is right — ${material.text}${material.bearing ? ` (${material.bearing})` : ''}.` : `Resolve first: ${material.text}${material.bearing ? ` — ${material.bearing}` : ''}.`;
        }
        else if (cannot.length) {
            stance = 'question';
            lead = `${cannot.length} cannot be assessed`;
            const first = cannot[0];
            next = first.health === 'stale' ? `Refresh ${(first.def.sources ?? []).join(', ') || 'the source'} before relying on “${first.def.purpose}”.` : first.health === 'error' ? `Fix the formula of “${first.def.purpose}”.` : `Check the data behind “${first.def.purpose}”: a blank or text where a number should be — nothing can be concluded from it.`;
        }
        else if (worthALook) {
            stance = 'observation';
            lead = 'Worth a look';
            const last = [...s.events].reverse().find((e) => e.level === 'watch' && Date.parse(e.at) > since);
            next = `Nothing to decide — worth a look: ${last ? short(last.text.replace(/\s+—.*$/, ''), 120) : 'a movement'}.`;
        }
        else {
            stance = 'quiet';
            lead = 'All quiet';
            next = !objective ? 'Say what matters (Objective: …) — the companion can then rank what to resolve next.' : uncertain.length ? `Nothing to decide; when convenient: ${short(uncertain[0].text, 120)}.` : 'Nothing to decide.';
        }
        const parts = [];
        parts.push(objective ? `Working toward: ${objective.text}` : 'No objective stated yet — the companion is reading the material without knowing what it is for');
        if (constraints.length)
            parts.push(`Within: ${constraints.map((c) => c.text).join('; ')}`);
        if (exclusions.length)
            parts.push(`Leaving out: ${exclusions.map((c) => c.text).join('; ')}`);
        const cov = coverage.filter((c) => c.rows > 0);
        parts.push(cov.length ? `Based on these records: ${cov.map((c) => `${c.name} (${c.period ? `snapshot ${c.period}, ` : ''}${c.rows} row${c.rows === 1 ? '' : 's'}${c.supply === 'import' ? ', manually supplied' : c.supply === 'live' ? ', live' : ''}${c.derivative ? ', generated — not independent evidence' : ''})`).join(', ')} — not the complete position` : 'Based on nothing yet: add a file or a table');
        if (decisions.length)
            parts.push(`${decisions.length} decision${decisions.length === 1 ? '' : 's'} standing${decisions.some((d) => d.revisit) ? ', one to revisit' : decisions.some((d) => d.conditions.length) ? ', conditions watched' : ''}`);
        if (uncertain.length)
            parts.push(`${uncertain.length} open uncertaint${uncertain.length === 1 ? 'y' : 'ies'}, first: ${short(uncertain[0].text, 100)}`);
        const statement = parts.join('. ') + '.';
        const investigations = (s.investigations ?? []).map((i) => ({ ...i, stale: i.status === 'done' && i.assumptionsSeq !== (s.assumptionsSeq ?? 0) ? true : undefined }));
        return { objective, constraints, exclusions, coverage, decisions, expectations, uncertain, stance, lead, next, statement, attention, assumptionsSeq: s.assumptionsSeq ?? 0, investigations, monitoring, scope };
    }
    finally {
        book?.free();
    }
}
// ------------------------------------------------------------------ applied scope
// An exclusion recorded is not an exclusion applied: the watches say what population they count.
// "Leave out vehicles reserved for customers" names a yes/no column (Reserved); a watch applies it
// when its formula carries that column = "no". The state is shown, and applying it is one tap.
const FILTERABLE = /^=\s*(COUNTIF|COUNTIFS|SUM|SUMIFS|AVERAGEIF|AVERAGEIFS)\s*\(/i;
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function flagColumnFor(text, metas, cellsOf) {
    const words = text.toLowerCase();
    for (const t of metas) {
        if (t.pivot || t.header_rows < 1)
            continue;
        const cols = profileTable(cellsOf(t.id), t);
        const dataRows = Math.max(0, t.rows - t.header_rows);
        const flags = cols.filter((p) => p.yesNo >= Math.max(1, (dataRows - p.blanks) * 0.8));
        // the column named in the text, else a reservation-like column when the text speaks of reservations
        const named = flags.find((p) => new RegExp(`\\b${esc(p.header.toLowerCase())}`).test(words) || new RegExp(`\\b${esc(p.header.toLowerCase().replace(/e?d$/, ''))}`).test(words));
        const byMeaning = /reserv/.test(words) ? flags.find((p) => /reserv/i.test(p.header)) : /sold|vendid/.test(words) ? flags.find((p) => /sold|vendid/i.test(p.header)) : undefined;
        const f = named ?? byMeaning;
        if (f)
            return { table: t, header: f.header };
    }
    return null;
}
const appliesFlag = (formula, header) => new RegExp(`\\[${esc(header)}\\]\\s*,\\s*"no"`, 'i').test(formula);
function withFlag(formula, table, header, value) {
    const cond = `, ${col(table, header)}, "${value}"`;
    const m = /^=\s*(COUNTIF|COUNTIFS|SUM|SUMIFS|AVERAGEIF|AVERAGEIFS)\s*\(([\s\S]*)\)\s*$/i.exec(formula);
    if (!m)
        return null;
    const fn = m[1].toUpperCase();
    const args = m[2];
    if (fn === 'COUNTIF' || fn === 'COUNTIFS')
        return `=COUNTIFS(${args}${cond})`;
    if (fn === 'SUM')
        return `=SUMIFS(${args}${cond})`;
    if (fn === 'SUMIFS')
        return `=SUMIFS(${args}${cond})`;
    if (fn === 'AVERAGEIF' || fn === 'AVERAGEIFS')
        return `=AVERAGEIFS(${args}${cond})`;
    return null;
}
function scopeStates(s, exclusions, metas, cellsOf) {
    const out = [];
    for (const r of exclusions) {
        const flag = flagColumnFor(r.text, metas, cellsOf);
        if (!flag) {
            out.push({ record: r.id, text: r.text, state: 'no-column', watches: [] });
            continue;
        }
        const reads = s.watches.filter((w) => w.authority === 'approved' && tablesReferenced(w.def.formula, metas).includes(flag.table.id));
        const watches = reads.map((w) => ({ id: w.id, purpose: w.def.purpose, applicable: FILTERABLE.test(w.def.formula), applied: appliesFlag(w.def.formula, flag.header) }));
        const applicable = watches.filter((w) => w.applicable);
        const state = !applicable.length ? 'recorded' : applicable.every((w) => w.applied) ? 'applied' : applicable.some((w) => w.applied) ? 'partly' : 'recorded';
        out.push({ record: r.id, text: r.text, column: flag.header, table: flag.table.name, state, watches });
    }
    return out;
}
/** Apply an exclusion to the watches that read the population: their formulas carry the column = "no" from now on (baselines restart, as the population changed). */
export function applyExclusion(doc, by, recordId) {
    const s = loadState(doc);
    const r = s.records.find((x) => x.id === recordId && x.kind === 'exclusion');
    if (!r)
        throw new Error('exclusion not found');
    const { book } = openDocument(doc);
    let flag = null;
    let metas = [];
    try {
        metas = tableMetas(book);
        const cache = new Map();
        const cellsOf = (id) => {
            if (!cache.has(id))
                cache.set(id, JSON.parse(book.cells(id)));
            return cache.get(id);
        };
        flag = flagColumnFor(r.text, metas, cellsOf);
    }
    finally {
        book.free();
    }
    if (!flag)
        throw new Error('no yes/no column marks what to leave out — say which column (e.g. "Reserved = yes")');
    const applied = [];
    const skipped = [];
    for (const w of s.watches) {
        if (w.authority !== 'approved' || !tablesReferenced(w.def.formula, metas).includes(flag.table.id))
            continue;
        if (appliesFlag(w.def.formula, flag.header))
            continue;
        const next = withFlag(w.def.formula, flag.table.name, flag.header, 'no');
        if (!next) {
            skipped.push(w.def.purpose);
            continue;
        }
        const complement = withFlag(w.def.formula, flag.table.name, flag.header, 'yes') ?? undefined;
        updateWatch(doc, w.id, by, { def: { formula: next, complement, scope: `${w.def.scope || flag.table.name} (excluding ${flag.header} = yes)` }, reason: `exclusion applied: ${r.text}` });
        applied.push(w.def.purpose);
    }
    const s2 = loadState(doc);
    event(s2, { kind: 'record', text: `Applied “${short(r.text, 80)}” to ${applied.length} watch${applied.length === 1 ? '' : 'es'} (${flag.header} = yes left out)${skipped.length ? `; not applicable to ${skipped.join(', ')}` : ''}`, by: who(by), level: 'quiet' });
    saveState(s2);
    return { applied, skipped, column: flag.header };
}
// ------------------------------------------------------------------ brief
export function brief(doc) {
    const s = loadState(doc);
    const sources = sourceStatus(doc, undefined, s);
    const u = understandingOf(doc, s);
    const since = s.seenAt ? Date.parse(s.seenAt) : 0;
    const recent = s.events.filter((e) => Date.parse(e.at) > since);
    const changed = recent
        .filter((e) => e.level !== 'attention' && e.kind !== 'trace')
        .map((e) => e.text)
        .filter((t, i, arr) => arr.lastIndexOf(t) === i)
        .slice(-8);
    const matters = [];
    const next = [];
    const health = { ok: 0, baseline: 0, attention: 0, stale: 0, error: 0, invalid: 0, unchecked: 0, proposed: 0 };
    // a decision to revisit names the issue behind it: that issue is not listed a second time
    const named = new Set();
    for (const d of u.decisions) {
        if (!d.revisit)
            continue;
        matters.push(`Revisit “${short(d.record.text, 100)}”: the condition “${d.revisit.condition}” no longer appears to hold — ${d.revisit.summary}`);
        for (const c of d.conditions)
            if (c.holds === false && c.watch)
                named.add(c.watch);
    }
    for (const w of s.watches) {
        health[w.health]++;
        if (w.lastChecked && (!health.checked || w.lastChecked > health.checked))
            health.checked = w.lastChecked;
        if (w.issue?.status === 'open') {
            if (!named.has(w.id))
                matters.push(w.issue.summary);
            next.push(w.issue.next);
        }
        else if (w.health === 'stale') {
            matters.push(`Not checked: “${w.def.purpose}” — ${(w.def.sources ?? []).join(', ')} not refreshed within ${w.def.freshnessHours} h`);
            next.push(`Refresh ${(w.def.sources ?? []).join(', ')} before relying on “${w.def.purpose}”.`);
        }
        else if (w.health === 'error') {
            const last = w.observations[w.observations.length - 1];
            matters.push(`Cannot evaluate “${w.def.purpose}”: ${last?.error ?? 'error'}`);
            next.push(`Fix the formula of “${w.def.purpose}”.`);
        }
        else if (w.health === 'invalid') {
            const last = [...w.observations].reverse().find((o) => o.def === w.defHash);
            matters.push(`Cannot assess “${w.def.purpose}”: the formula gives ${last?.invalid === 'blank' ? 'no value' : 'text, not a number'} — not within bounds, not out of them`);
            next.push(`Check the data behind “${w.def.purpose}” (a blank or text where a number should be).`);
        }
    }
    health.attention += u.decisions.filter((d) => d.revisit).length;
    for (const m of u.uncertain.filter((x) => x.rank <= 2).slice(0, 3))
        matters.push(m.kind === 'expectation' ? m.text : `${m.kind === 'contradiction' ? 'Sources disagree: ' : m.kind === 'question' ? 'Open question: ' : ''}${m.text}${m.bearing ? ` — ${m.bearing}` : ''}`);
    if (u.next && !next.includes(u.next))
        next.unshift(u.next);
    const proposedRecords = s.records.filter((r) => r.status === 'proposed');
    const proposedWatches = s.watches.filter((w) => w.authority === 'proposed');
    if (proposedWatches.length)
        next.push(`${proposedWatches.length} proposed watch${proposedWatches.length === 1 ? '' : 'es'} await${proposedWatches.length === 1 ? 's' : ''} your approval.`);
    if (proposedRecords.length)
        next.push(`${proposedRecords.length} context item${proposedRecords.length === 1 ? '' : 's'} proposed by an agent await${proposedRecords.length === 1 ? 's' : ''} confirmation.`);
    const stale = u.investigations.filter((i) => i.stale).length;
    if (stale)
        next.push(`${stale} investigation${stale === 1 ? '' : 's'} made under earlier assumptions — re-run before relying on ${stale === 1 ? 'it' : 'them'}.`);
    const baseline = s.watches.filter((w) => w.health === 'baseline');
    if (baseline.length && !matters.length)
        matters.push(`${baseline.length} watch${baseline.length === 1 ? '' : 'es'} still building a baseline — no conclusion yet, which is a valid state.`);
    if (!matters.length) {
        const approved = s.watches.filter((w) => w.authority === 'approved').length;
        matters.push(approved ? (health.checked ? `No material issues detected (${approved} watch${approved === 1 ? '' : 'es'} checked ${health.checked.slice(0, 16).replace('T', ' ')}).` : `${approved} watch${approved === 1 ? '' : 'es'} not checked yet.`) : 'Nothing is being watched yet.');
    }
    if (!next.length)
        next.push(s.watches.length ? 'Nothing to decide.' : 'Tell the companion what matters (Objective: …, Exclude: …) and what to watch.');
    return { changed, matters, next: next.filter((t, i, arr) => arr.indexOf(t) === i), health, sources, stance: u.stance, lead: u.lead, statement: u.statement };
}
/** Everything the panel needs. */
export function snapshot(doc, viewer) {
    const s = loadState(doc);
    const records = s.records.filter((r) => !r.private || !viewer?.login || !r.by.login || r.by.login.toLowerCase() === viewer.login.toLowerCase());
    const u = understandingOf(doc, s);
    return { records, watches: s.watches, events: s.events.slice(-60), brief: brief(doc), seenAt: s.seenAt, graph: graphOf(doc), understanding: u, dismissed: s.dismissed ?? [], runs: (s.runs ?? []).slice(-20), investigations: u.investigations.slice(-10), assumptionsSeq: s.assumptionsSeq ?? 0 };
}
/** The context as data for a model prompt: statuses kept, instructions neutralised, private working context left out for outside agents. */
export function contextForModel(doc, opts = {}) {
    const s = loadState(doc);
    const u = understandingOf(doc, s);
    const visible = (r) => !r.private || (!opts.outside && (!opts.viewer?.login || !r.by.login || r.by.login.toLowerCase() === opts.viewer.login.toLowerCase()));
    const live = s.records.filter((r) => r.status !== 'retired' && r.status !== 'superseded' && visible(r));
    return {
        understanding: { statement: u.statement, stance: u.stance, next: u.next, coverage: u.coverage, uncertain: u.uncertain.slice(0, 8), assumptionsSeq: u.assumptionsSeq },
        records: live.map((r) => ({ id: r.id, kind: r.kind, status: r.status, text: r.text, source: r.source, period: r.period, arrived: r.arrivedAt.slice(0, 10), by: who(r.by), bearing: r.bearing, due: r.due, expected: r.expected?.text, why: r.why, conditions: r.conditions?.map((c) => ({ text: c.text, holds: c.holds })), resolution: r.resolution, derivative: r.derivative })),
        rejected: s.records.filter((r) => r.key?.startsWith('rejected:')).map((r) => ({ text: r.text, note: r.why, at: r.arrivedAt.slice(0, 10) })),
        setAside: (s.dismissed ?? []).map((d) => ({ purpose: d.purpose, reason: d.reason })),
        watches: s.watches.map((w) => ({ id: w.id, purpose: w.def.purpose, scope: w.def.scope, formula: w.def.formula, kind: w.def.kind, op: w.def.op, value: w.def.value, sustain: w.def.sustain, authority: w.authority, health: w.health, last: w.observations.slice(-5).map((o) => ({ at: o.at, period: o.period, value: o.value, complement: o.complement, breach: o.breach, fresh: o.fresh })), issue: w.issue?.status === 'open' ? { id: w.issue.id, summary: w.issue.summary, evidence: w.issue.evidence, uncertainty: w.issue.uncertainty } : undefined })),
        investigations: u.investigations.slice(-5).map((i) => ({ question: i.question, status: i.status, answer: i.answer, stale: i.stale, at: i.startedAt.slice(0, 10) })),
        sources: sourceStatus(doc),
    };
}

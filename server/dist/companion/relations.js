// Relations between what the companion holds: the periods of snapshots and their order, and the
// graph of tables, sources, watches, issues and records with the edges read off the workbook
// (formulas, references) and the context (links, bearings) — what a change reaches.
import { engineAvailable, openDocument, tableMetas } from '../headless.js';
import { listConnections, readFile } from '../storage.js';
import { loadState } from './state.js';
import { sourceStatus } from './monitoring.js';
/** The snapshot period of each table: its latest live source record (set by the person or read from the file name). */
export function periodsOf(s) {
    const periodOfTable = new Map();
    for (const r of s.records) {
        if (r.kind !== 'source' || r.status === 'retired' || r.status === 'superseded')
            continue;
        for (const l of r.links ?? [])
            if (typeof l.table === 'number' && r.period)
                periodOfTable.set(l.table, r.period);
    }
    return periodOfTable;
}
/** Order of two periods when both are dates, months or ISO weeks (2026-10-06 < 2026-10-13, 2026-09 < 2026-10, W40 < W41); null when they cannot be compared. */
export function comparePeriods(a, b) {
    const norm = (p) => (/^\d{4}-\d{2}(-\d{2})?$/.test(p) ? p : /^W\d{1,2}$/i.test(p) ? `W${p.slice(1).padStart(2, '0')}` : /^\d{8}$/.test(p) ? `${p.slice(0, 4)}-${p.slice(4, 6)}-${p.slice(6)}` : null);
    const x = norm(a);
    const y = norm(b);
    if (x === null || y === null || (x.startsWith('W') !== y.startsWith('W')))
        return null;
    return x < y ? -1 : x > y ? 1 : 0;
}
/** Whether a snapshot period reaches a date: 2026-10-13 ≥ 2026-10-12, 2026-10 ≥ 2026-10-12 (same month); null when the period is not a date. */
export function periodReaches(period, date) {
    if (!period)
        return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(period))
        return period >= date;
    if (/^\d{4}-\d{2}$/.test(period))
        return period >= date.slice(0, 7);
    return null;
}
/** Names of the tables a text refers to (`Sales::B2`, `'Table 1'::A1`, `Sales[Amount]`, or the bare name as a word). */
function tablesMentioned(text, metas) {
    const out = new Set();
    if (!text)
        return [];
    for (const t of metas) {
        const n = t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`(?:'${n}'|\\b${n})\\s*(?:::|\\[|!)`, 'i').test(text) || new RegExp(`(^|[^\\w])${n}([^\\w]|$)`, 'i').test(text))
            out.add(t.id);
    }
    return [...out];
}
/** Tables referenced by formulas only (a strict form for watches and derived tables). */
export function tablesReferenced(formula, metas) {
    const out = new Set();
    for (const t of metas) {
        const n = t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`(?:'${n}'|\\b${n})\\s*(?:::|\\[|!)`, 'i').test(formula))
            out.add(t.id);
    }
    return [...out];
}
export function graphOf(doc) {
    const s = loadState(doc);
    const nodes = [];
    const edges = [];
    const seen = new Set();
    const edge = (from, to, type, via) => {
        const k = `${from}>${to}>${type}`;
        if (seen.has(k))
            return;
        seen.add(k);
        edges.push({ from, to, type, via });
    };
    if (!engineAvailable() || !readFile(doc))
        return { nodes, edges };
    const sources = sourceStatus(doc);
    const conns = new Map(listConnections().map((c) => [c.id, c.name]));
    const { book } = openDocument(doc);
    let metas = [];
    try {
        metas = tableMetas(book);
        for (const t of metas) {
            const src = sources.find((x) => x.name === t.name);
            nodes.push({ id: `table:${t.id}`, type: 'table', label: t.name, table: t.id, supply: src?.supply, lastChange: src?.lastChange, rows: t.rows });
        }
        for (const t of metas) {
            const cells = JSON.parse(book.cells(t.id));
            const refs = new Set();
            for (const c of cells) {
                if (c.k === 'sql' && c.conn) {
                    const id = `source:connection:${c.conn}`;
                    if (!nodes.some((n) => n.id === id))
                        nodes.push({ id, type: 'source', label: conns.get(c.conn) ?? c.conn, supply: 'live' });
                    edge(`table:${t.id}`, id, 'fed_by', 'sql');
                }
                if (c.i && (c.i.startsWith('=') || c.k === 'python' || c.k === 'javascript'))
                    for (const id of tablesReferenced(c.i, metas))
                        if (id !== t.id)
                            refs.add(id);
            }
            for (const id of refs)
                edge(`table:${t.id}`, `table:${id}`, 'derived_from', 'formula');
            const pivot = t.pivot;
            if (pivot && typeof pivot.source === 'number')
                edge(`table:${t.id}`, `table:${pivot.source}`, 'derived_from', 'pivot');
        }
    }
    finally {
        book.free();
    }
    // context records: sources feed tables, the rest are about tables (by link or by mention)
    for (const r of s.records) {
        if (r.status === 'retired')
            continue;
        const id = r.kind === 'source' ? `source:${r.id}` : `record:${r.id}`;
        nodes.push({ id, type: r.kind, label: r.text.slice(0, 120), status: r.status, period: r.period, lastChange: r.arrivedAt });
        const linked = new Set((r.links ?? []).map((l) => l.table).filter((t) => typeof t === 'number'));
        const mentioned = tablesMentioned(r.text, metas);
        for (const t of linked)
            edge(r.kind === 'source' ? `table:${t}` : id, r.kind === 'source' ? id : `table:${t}`, r.kind === 'source' ? 'fed_by' : r.kind === 'exclusion' ? 'excludes' : 'about', 'link');
        for (const t of mentioned)
            if (!linked.has(t))
                edge(r.kind === 'source' ? `table:${t}` : id, r.kind === 'source' ? id : `table:${t}`, r.kind === 'source' ? 'fed_by' : r.kind === 'exclusion' ? 'excludes' : 'about', 'mention');
        if (r.kind === 'source' && r.supersededBy)
            edge(`source:${r.supersededBy}`, id, 'supersedes', 'source');
        // a decision depends on the watches that stand for its conditions
        for (const c of r.conditions ?? [])
            if (c.watch && s.watches.some((w) => w.id === c.watch))
                edge(id, `watch:${c.watch}`, 'depends_on', 'condition');
    }
    // watches read tables; stated objectives constrain every approved watch of the case; issues hang off watches
    const objectives = s.records.filter((r) => r.kind === 'objective' && (r.status === 'stated' || r.status === 'confirmed'));
    for (const w of s.watches) {
        const id = `watch:${w.id}`;
        nodes.push({ id, type: 'watch', label: w.def.purpose, health: w.health, status: w.authority, lastChange: w.lastChecked });
        const read = new Set(tablesReferenced(w.def.formula, metas));
        const ctx = w.def.table ? metas.find((m) => m.name.toLowerCase() === w.def.table.toLowerCase()) : undefined;
        if (ctx && !tablesReferenced(w.def.formula, metas).length)
            read.add(ctx.id);
        for (const t of read)
            edge(id, `table:${t}`, 'watches', 'formula');
        if (w.authority === 'approved')
            for (const o of objectives)
                edge(`record:${o.id}`, id, 'constrains', 'case');
        if (w.issue?.status === 'open') {
            nodes.push({ id: `issue:${w.issue.id}`, type: 'issue', label: w.issue.summary, status: w.issue.status, lastChange: w.issue.updatedAt });
            edge(id, `issue:${w.issue.id}`, 'raises', 'check');
        }
    }
    return { nodes, edges };
}
/** Nodes to reassess when the given nodes change: everything that reads them, transitively, plus what is about them. */
export function affectedBy(g, changed) {
    const reads = new Map(); // target -> nodes that depend on it
    for (const e of g.edges) {
        if (e.type === 'derived_from' || e.type === 'watches' || e.type === 'about' || e.type === 'excludes' || e.type === 'raises' || e.type === 'depends_on') {
            // derived_from / watches / about / excludes / depends_on: from depends on to; raises: issue depends on watch
            const dep = e.type === 'raises' ? e.to : e.from;
            const on = e.type === 'raises' ? e.from : e.to;
            if (!reads.has(on))
                reads.set(on, new Set());
            reads.get(on).add(dep);
        }
    }
    const out = new Set();
    const stack = [...changed];
    while (stack.length) {
        const n = stack.pop();
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

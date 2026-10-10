// The spreadsheet engine on the server: the same Rust core as the browser, compiled for Node.
// Used by the MCP tools (read tables, evaluate formulas, run checks) and to validate proposed
// edits before anyone sees them. Documents are loaded fresh per call; nothing here mutates the
// stored document.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from './storage.js';
import { currentSeq, replayBundle } from './history.js';
/** Message of anything thrown: the wasm engine throws plain strings, Node throws Errors. */
export function errorMessage(e) {
    if (e instanceof Error)
        return e.message;
    if (typeof e === 'string')
        return e;
    try {
        return JSON.stringify(e);
    }
    catch {
        return String(e);
    }
}
let core = null;
let loadError = null;
const here = dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [join(here, '../engine/gridwright_core.js'), join(here, '../../engine/gridwright_core.js'), process.env.GRIDWRIGHT_ENGINE ?? ''];
export function engine() {
    if (core)
        return core;
    if (loadError)
        throw new Error(loadError);
    const require = createRequire(import.meta.url);
    for (const p of CANDIDATES) {
        if (!p || !existsSync(p))
            continue;
        try {
            core = require(p);
            return core;
        }
        catch (e) {
            loadError = `engine at ${p} failed to load: ${errorMessage(e)}`;
        }
    }
    loadError = loadError ?? 'headless engine not built (run `wasm-pack build --target nodejs` in core/, see scripts/build.sh)';
    throw new Error(loadError);
}
export function engineAvailable() {
    try {
        engine();
        return true;
    }
    catch {
        return false;
    }
}
export const nowSerial = () => Date.now() / 86400000 + 25569;
/**
 * Load a document into a throw-away engine instance, as the editors currently see it: the latest
 * checkpoint (save, undo/redo) plus every operation logged since. Callers must `free()` the book.
 * `json` is the replayed state and `seq` the log position it corresponds to.
 */
export function openDocument(fileId) {
    const f = readFile(fileId);
    if (!f)
        throw new Error('document not found');
    const seq = currentSeq(fileId);
    const bundle = replayBundle(fileId, seq);
    // a checkpoint newer than the saved file wins; otherwise start from the saved document
    const base = bundle?.json ?? f.json;
    const book = engine().Book.from_json(base);
    book.set_now(nowSerial());
    for (const e of bundle?.ops ?? []) {
        if (!e.op)
            continue;
        try {
            book.apply(JSON.stringify(e.op));
        }
        catch {
            /* an op the engine refuses was refused for the editors too; keep going */
        }
    }
    const json = bundle?.ops.length ? book.to_json() : base;
    return { book, name: f.name, json, seq };
}
export function colLetters(col) {
    let s = '';
    let c = col;
    for (;;) {
        s = String.fromCharCode(65 + (c % 26)) + s;
        if (c < 26)
            break;
        c = Math.floor(c / 26) - 1;
    }
    return s;
}
export const a1 = (r, c) => `${colLetters(c)}${r + 1}`;
export function lettersToCol(s) {
    let n = 0;
    for (const ch of s.toUpperCase())
        n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}
/** "A1", "A1:B3", "Table 2::A1:B3", "'My table'::A1" → table name (optional) + 0-based rect. */
export function parseA1(ref) {
    let table;
    let body = ref.trim();
    const dc = body.lastIndexOf('::');
    if (dc >= 0) {
        table = body.slice(0, dc).trim().replace(/^'(.*)'$/, '$1');
        body = body.slice(dc + 2).trim();
    }
    const m = body.match(/^\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$/);
    if (!m)
        return null;
    const c0 = lettersToCol(m[1]);
    const r0 = parseInt(m[2], 10) - 1;
    const c1 = m[3] ? lettersToCol(m[3]) : c0;
    const r1 = m[4] ? parseInt(m[4], 10) - 1 : r0;
    return { table, r0: Math.min(r0, r1), c0: Math.min(c0, c1), r1: Math.max(r0, r1), c1: Math.max(c0, c1) };
}
/** Display text of a cell value, applying its number format. */
export function displayOf(cell) {
    if (!cell || cell.v === null || cell.v === undefined)
        return '';
    const v = cell.v;
    if ('n' in v) {
        const fmt = cell.f?.number_format;
        if (fmt) {
            try {
                return engine().Book.format_number(v.n, fmt);
            }
            catch {
                /* fall through */
            }
        }
        return Number.isInteger(v.n) && Math.abs(v.n) < 1e15 ? String(v.n) : String(Math.round(v.n * 1e10) / 1e10);
    }
    if ('s' in v)
        return v.s;
    if ('b' in v)
        return v.b ? 'TRUE' : 'FALSE';
    if ('e' in v)
        return v.e;
    return '';
}
export function tableMetas(book) {
    return JSON.parse(book.tables());
}
/** The workbook as the Python runner sees it (what the browser would send): plain values per table, formulas at their last committed value. */
export function snapshotOf(book, maxCells = 200_000) {
    const tables = [];
    let budget = maxCells;
    for (const t of tableMetas(book)) {
        const values = Array.from({ length: t.rows }, () => new Array(t.cols).fill(''));
        for (const c of JSON.parse(book.cells(t.id))) {
            if (c.r >= t.rows || c.c >= t.cols || !c.v)
                continue;
            values[c.r][c.c] = 'n' in c.v ? c.v.n : 's' in c.v ? c.v.s : 'b' in c.v ? c.v.b : 'e' in c.v ? c.v.e : '';
        }
        budget -= t.rows * t.cols;
        if (budget < 0)
            break;
        tables.push({ id: t.id, name: t.name, rows: t.rows, cols: t.cols, values });
    }
    return { tables, current: { table: tables[0]?.id ?? 0, row: 0, col: 0 } };
}
export function tableByName(book, name) {
    const metas = tableMetas(book);
    const n = name.trim().toLowerCase();
    return metas.find((t) => t.name.toLowerCase() === n) ?? metas.find((t) => String(t.id) === n) ?? null;
}
/** Rows of display text for a table (header first), trimmed to its used area and `maxRows`. */
export function tableRows(book, table, maxRows = 200) {
    const cells = JSON.parse(book.cells(table.id));
    let lastR = -1;
    let lastC = -1;
    const map = new Map();
    for (const c of cells) {
        map.set(c.r * 65536 + c.c, c);
        if (c.r > lastR)
            lastR = c.r;
        if (c.c > lastC)
            lastC = c.c;
    }
    const header = [];
    const hasHeader = table.header_rows > 0;
    for (let c = 0; c <= lastC; c++)
        header.push(hasHeader ? displayOf(map.get(c)) || colLetters(c) : colLetters(c));
    const rows = [];
    const first = hasHeader ? table.header_rows : 0;
    const totalRows = Math.max(0, lastR - first + 1);
    for (let r = first; r <= lastR && rows.length < maxRows; r++) {
        const row = [];
        for (let c = 0; c <= lastC; c++)
            row.push(displayOf(map.get(r * 65536 + c)));
        rows.push(row);
    }
    return { columns: header, rows, totalRows, truncated: totalRows > rows.length };
}
/**
 * Cell-level differences between two engine instances for the given tables (bounded): first the
 * edits themselves (a changed input or formula), then their consequences — every cell whose
 * formula stays the same but whose value moves — so that a reviewer sees what the change does,
 * not only what it says.
 */
export function diffBooks(before, after, tableIds, max = 500) {
    const edits = [];
    const effects = [];
    const beforeMetas = new Map(tableMetas(before).map((t) => [t.id, t]));
    const afterMetas = new Map(tableMetas(after).map((t) => [t.id, t]));
    for (const id of tableIds) {
        const bm = beforeMetas.get(id);
        const am = afterMetas.get(id);
        const name = am?.name ?? bm?.name ?? `table ${id}`;
        if (!bm && am) {
            edits.push({ where: name, before: '', after: `table ${am.rows}×${am.cols}` });
        }
        else if (bm && !am) {
            edits.push({ where: name, before: `table ${bm.rows}×${bm.cols}`, after: '' });
            continue;
        }
        else if (bm && am && (bm.rows !== am.rows || bm.cols !== am.cols || bm.name !== am.name)) {
            edits.push({ where: name, before: `${bm.name} ${bm.rows}×${bm.cols}`, after: `${am.name} ${am.rows}×${am.cols}` });
        }
        const b = new Map((bm ? JSON.parse(before.cells(id)) : []).map((c) => [c.r * 65536 + c.c, c]));
        const a = new Map((am ? JSON.parse(after.cells(id)) : []).map((c) => [c.r * 65536 + c.c, c]));
        const keys = new Set([...b.keys(), ...a.keys()]);
        for (const k of keys) {
            const cb = b.get(k);
            const ca = a.get(k);
            const where = `${name}::${a1(Math.floor(k / 65536), k % 65536)}`;
            const tb = cb ? (cb.i || displayOf(cb)) : '';
            const ta = ca ? (ca.i || displayOf(ca)) : '';
            if (tb !== ta) {
                edits.push({ where, before: tb, after: ta });
            }
            else if (cb && ca && cb.i && displayOf(cb) !== displayOf(ca)) {
                effects.push({ where, before: displayOf(cb), after: displayOf(ca), effect: true });
            }
            if (edits.length + effects.length >= max)
                break;
        }
    }
    return edits.concat(effects).slice(0, max);
}

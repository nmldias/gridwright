// The parsers for spreadsheets, XML and JSON. They run in a worker thread (parseworker.ts) with a
// memory cap and a deadline, never in the server's own thread: a crafted file must not stall the
// server for every client. No imports beyond the parsing libraries, so the worker stays small.
import { XMLParser } from 'fast-xml-parser';
import * as XLSX from 'xlsx';
export const MAX_CELLS = 1_000_000;
export const MAX_ROWS = 200_000;
export const MAX_COLS = 256;
export function parseWorkbook(buf, name) {
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: false, cellFormula: true, sheetStubs: false, dense: false });
    const out = [];
    let cells = 0;
    for (const sheetName of wb.SheetNames) {
        const sheet = wb.Sheets[sheetName];
        if (!sheet || !sheet['!ref'])
            continue;
        const range = XLSX.utils.decode_range(sheet['!ref']);
        cells += (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1);
        if (cells > MAX_CELLS)
            throw new Error(`the workbook has more than ${MAX_CELLS.toLocaleString('en-GB')} cells; split it or import a sheet at a time`);
        const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
        let formulas = 0;
        for (const addr of Object.keys(sheet)) {
            if (addr[0] === '!')
                continue;
            if (sheet[addr].f)
                formulas++;
        }
        const rows = grid.slice(0, MAX_ROWS).map((r) => r.slice(0, MAX_COLS).map((v) => (v === null || v === undefined ? '' : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v))));
        const notes = [];
        if (formulas)
            notes.push(`${formulas} formula cell${formulas === 1 ? '' : 's'} reduced to the values the file carried`);
        out.push({ name: sheetName, rows, formulas, notes });
    }
    if (/\.xlsm$/i.test(name))
        for (const s of out)
            s.notes.push('macros are not executed; values only');
    return out;
}
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const scalar = (v) => v === null || typeof v !== 'object';
/** The largest list of records in a JSON/XML tree: an array of objects whose values are mostly scalars. */
function recordLists(v, path, out, depth = 0) {
    if (depth > 6)
        return;
    if (Array.isArray(v)) {
        const items = v.filter(isObj);
        if (items.length >= 1 && items.length >= v.length * 0.8)
            out.push({ path, items });
        for (const x of v.slice(0, 50))
            if (!scalar(x))
                recordLists(x, path, out, depth + 1);
    }
    else if (isObj(v)) {
        for (const [k, x] of Object.entries(v))
            if (!scalar(x))
                recordLists(x, path ? `${path}.${k}` : k, out, depth + 1);
    }
}
function flatten(o, prefix = '') {
    const out = {};
    for (const [k, v] of Object.entries(o)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (scalar(v))
            out[key.replace(/^@_/, '')] = v === null ? '' : String(v);
        else if (isObj(v) && prefix.split('.').length < 2)
            Object.assign(out, flatten(v, key));
        else
            out[key] = JSON.stringify(v).slice(0, 200);
    }
    return out;
}
function setsFromTree(tree, label) {
    const lists = [];
    recordLists(tree, '', lists);
    if (!lists.length)
        throw new Error(`no list of records found in the ${label} (expected repeated elements or an array of objects)`);
    lists.sort((a, b) => b.items.length - a.items.length);
    const out = [];
    for (const l of lists.slice(0, 3)) {
        const flat = l.items.slice(0, MAX_ROWS).map((it) => flatten(it));
        const headers = [];
        for (const f of flat)
            for (const k of Object.keys(f))
                if (!headers.includes(k))
                    headers.push(k);
        const rows = [headers.slice(0, MAX_COLS), ...flat.map((f) => headers.slice(0, MAX_COLS).map((h) => f[h] ?? ''))];
        out.push({ name: l.path.split('.').pop() || label, rows, formulas: 0, notes: [`records read from ${label} path “${l.path || '(root)'}”`] });
    }
    return out;
}
export function parseXml(text) {
    if (/<!DOCTYPE|<!ENTITY/i.test(text.slice(0, 4000)))
        throw new Error('XML with a DOCTYPE or entity declarations is not accepted');
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, parseAttributeValue: false, trimValues: true, processEntities: false });
    const tree = parser.parse(text);
    return setsFromTree(tree, 'XML');
}
export function parseJson(text) {
    const tree = JSON.parse(text);
    return setsFromTree(tree, 'JSON');
}

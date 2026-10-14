// The profile of a raw sheet: where the header is, and for every column what the file really holds —
// how many cells are numbers, text that reads as a number (and in which format), dates, blanks; the
// most frequent values and shapes; untidy text; codes that carry more than one name; columns that are
// always equal. Computed in SQL over every row (not a sample), inside the dataset worker. The
// proposer turns this into steps; the assistant reads it to explain them.
import { numClass, shapeOf, toDate, toNumber } from './dsengine.js';
const ID_LABEL = /(^|[\s_.-])(c[oó]d(igo)?|code|id|n[ºo°.]|num(ero|ber)?|n[uú]mero|ref(er[eê]ncia)?|nif|nuit|conta|account|sku)([\s_.-]|$)|[a-z](id|num|no|nr)$/i;
const AMOUNT_LABEL = /valor|total|amount|montante|pre[cç]o|price|custo|cost|saldo|balance|imposto|tax|iva|vat|d[eé]bito|cr[eé]dito|pago|paid/i;
export function slug(label, taken) {
    let k = label
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 50);
    if (!k || !/^[a-z]/.test(k))
        k = `c_${k}`.replace(/_+$/, '');
    let out = k;
    for (let i = 2; taken.has(out); i++)
        out = `${k}_${i}`;
    taken.add(out);
    return out;
}
const isTextual = (v) => typeof v === 'string' && numClass(v) === null && toDate(v) === null;
/** The header row: the first row of mostly distinct text labels that the rows after it do not resemble. */
export function detectHeader(rows, width) {
    const candidates = [];
    const score = (r) => {
        const filled = r.filter((v) => v !== null && v !== undefined);
        const text = filled.filter(isTextual);
        const unique = new Set(text.map((v) => String(v).trim().toLowerCase())).size === text.length;
        return { filled: filled.length, text: text.length, unique };
    };
    for (let i = 0; i < rows.length; i++) {
        const s = score(rows[i]);
        if (s.filled >= Math.max(2, Math.ceil(width * 0.5)) && s.text >= s.filled * 0.8 && s.unique)
            candidates.push(i);
    }
    for (const i of candidates) {
        const after = rows.slice(i + 1, i + 6);
        if (!after.length)
            continue;
        const textShare = after.map(score).reduce((a, s) => a + (s.filled ? s.text / s.filled : 1), 0) / after.length;
        if (textShare < 0.9)
            return { row: i, candidates };
    }
    const firstFilled = rows.findIndex((r) => r.some((v) => v !== null));
    return { row: candidates[0] ?? Math.max(0, firstFilled), candidates };
}
/** Profile one raw sheet (raw_<index> in the given schema). */
export function profileSheet(db, sheet, schema = 'main', onProgress) {
    const t0 = Date.now();
    const T = `${schema}.raw_${sheet.index}`;
    const width = sheet.cols;
    const cols = Array.from({ length: width }, (_, i) => `c${i}`);
    const head = db.prepare(`SELECT _r, ${cols.join(', ')} FROM ${T} ORDER BY _r LIMIT 30`).all();
    const headRows = head.map((r) => cols.map((c) => (r[c] ?? null)));
    const det = detectHeader(headRows, width);
    const headerRow = head.length ? Number(head[det.row]._r) : 1;
    const headerCells = headRows[det.row] ?? [];
    const taken = new Set();
    const total = db.prepare(`SELECT count(*) n, max(_r) m FROM ${T} WHERE _r > ?`).get(headerRow);
    const rows = Number(total.n);
    const W = `FROM ${T} WHERE _r > ${Number(headerRow)}`;
    // one native pass for counts and distinct values (all columns in one statement)
    const agg = db.prepare(`SELECT ${cols.map((c, i) => `count(${c}) f${i}, count(DISTINCT ${c}) d${i}, total(typeof(${c}) IN ('integer','real')) n${i}, max(length(${c})) l${i}`).join(', ')} ${W}`).get();
    const stat = () => ({ n: 0, min: Infinity, max: -Infinity, sum: 0, neg: 0, zero: 0 });
    const add = (s, x) => {
        if (x === null || !Number.isFinite(x))
            return;
        s.n++;
        if (x < s.min)
            s.min = x;
        if (x > s.max)
            s.max = x;
        s.sum += x;
        if (x < 0)
            s.neg++;
        else if (x === 0)
            s.zero++;
    };
    const acc = cols.map(() => ({ iso: 0, text: 0, untidy: 0, nt: { pt: 0, en: 0, plain: 0, ambiguous: 0 }, dateText: 0, nonInt: 0, shapes: new Map(), pt: stat(), en: stat(), dmin: null, dmax: null }));
    const totalsRows = [];
    const ISO = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/;
    const UNTIDY = /^\s|\s$|\s\s|[\u00a0\u2007\u202f\u200b-\u200d\ufeff\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\t\r\n]/;
    const TOTAL = /^(total|totais|totals|soma|sum|grand total|total geral|subtotal|sub-total)\s*:?$/i;
    const it = db.prepare(`SELECT _r, ${cols.join(', ')} ${W} ORDER BY _r`);
    it.setReturnArrays(true);
    let seen = 0;
    for (const row of it.iterate()) {
        if (++seen % 50_000 === 0)
            onProgress?.(seen, rows);
        for (let i = 0; i < width; i++) {
            const v = row[i + 1];
            if (v === null || v === undefined)
                continue;
            const a = acc[i];
            let shape;
            if (typeof v === 'number') {
                if (!Number.isInteger(v))
                    a.nonInt++;
                add(a.pt, v);
                add(a.en, v);
                shape = Number.isInteger(v) ? '9' : '9.9';
            }
            else {
                const s = String(v);
                if (ISO.test(s)) {
                    a.iso++;
                    const d = s.slice(0, 10);
                    if (a.dmin === null || d < a.dmin)
                        a.dmin = d;
                    if (a.dmax === null || d > a.dmax)
                        a.dmax = d;
                    shape = '9-9-9';
                }
                else {
                    a.text++;
                    if (UNTIDY.test(s))
                        a.untidy++;
                    const nc = numClass(s);
                    if (nc) {
                        a.nt[nc]++;
                        if (nc !== 'en')
                            add(a.pt, toNumber(s, 'pt'));
                        if (nc !== 'pt')
                            add(a.en, toNumber(s, 'en'));
                    }
                    else {
                        const d = toDate(s, true);
                        if (d) {
                            a.dateText++;
                            if (a.dmin === null || d < a.dmin)
                                a.dmin = d;
                            if (a.dmax === null || d > a.dmax)
                                a.dmax = d;
                        }
                        else if (totalsRows.length < 5 && TOTAL.test(s.trim()))
                            totalsRows.push(Number(row[0]));
                    }
                    shape = shapeOf(s) ?? '';
                }
            }
            const m = a.shapes;
            const had = m.get(shape);
            if (had !== undefined)
                m.set(shape, had + 1);
            else if (m.size < 300)
                m.set(shape, 1);
        }
    }
    const columns = [];
    for (let i = 0; i < width; i++) {
        const c = `c${i}`;
        const rawLabel = headerCells[i];
        const label = rawLabel === null || rawLabel === undefined || String(rawLabel).trim() === '' ? `Column ${i + 1}` : String(rawLabel).replace(/\s+/g, ' ').trim().slice(0, 120);
        const key = slug(label, taken);
        const a = acc[i];
        const filled = Number(agg[`f${i}`]);
        const distinct = Number(agg[`d${i}`]);
        const storage = { number: Number(agg[`n${i}`]), date: a.iso, text: a.text };
        const numText = a.nt;
        const dateText = a.dateText;
        const top = db.prepare(`SELECT ${c} v, count(*) n ${W} AND ${c} IS NOT NULL GROUP BY ${c} ORDER BY n DESC, v LIMIT 12`).all().map((r) => ({ value: r.v, count: Number(r.n) }));
        const shapes = [...a.shapes.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([shape, count]) => ({ shape, count }));
        const formatted = numText.pt + numText.en;
        const numericish = storage.number + formatted + numText.plain + numText.ambiguous;
        const locale = numText.en > numText.pt ? 'en' : 'pt';
        const looksId = ID_LABEL.test(label) && !AMOUNT_LABEL.test(label);
        const lower = new Set(top.map((t) => String(t.value).trim().toLowerCase()));
        const boolish = distinct > 0 && distinct <= 3 && [...lower].every((v) => ['sim', 'não', 'nao', 'yes', 'no', 'true', 'false', 's', 'n', 'y', '0', '1'].includes(v));
        const fewValues = distinct <= 60 && distinct <= Math.max(2, filled * 0.05);
        let inferred;
        if (filled === 0)
            inferred = 'empty';
        else if (storage.date + dateText >= filled * 0.95)
            inferred = 'date';
        else if (boolish)
            inferred = 'boolean';
        else if (numericish >= filled * 0.95) {
            // whole numbers with no thousands or decimal separators that are (nearly) all distinct: a reference, not an amount
            const reference = a.nonInt === 0 && formatted === 0 && distinct >= filled * 0.98 && !AMOUNT_LABEL.test(label);
            inferred = looksId || reference ? 'identifier' : 'number';
        }
        else if (fewValues)
            inferred = 'category';
        else if (looksId || (distinct >= filled * 0.5 && shapes.some((s) => /9/.test(s.shape) && /A/.test(s.shape))))
            inferred = 'identifier';
        else
            inferred = 'text';
        const p = { index: i, key, label, filled, blanks: rows - filled, distinct, storage, numText, dateText, inferred, top, shapes, untidy: a.untidy, constant: filled > 0 && distinct === 1, duplicates: distinct >= filled * 0.9 ? filled - distinct : 0, maxLength: Number(agg[`l${i}`] ?? 0) };
        if (inferred === 'number') {
            p.locale = locale;
            const s = locale === 'en' ? a.en : a.pt;
            if (s.n)
                Object.assign(p, { min: s.min, max: s.max, sum: Math.round(s.sum * 100) / 100, negatives: s.neg, zeros: s.zero });
        }
        else if (inferred === 'date' && a.dmin)
            Object.assign(p, { min: a.dmin, max: a.dmax });
        columns.push(p);
    }
    // codes that carry more than one name, and names under more than one code
    const pairs = [];
    for (const a of columns) {
        // a code column with few distinct values (24 customer codes over 1 800 rows) reads as a category: still a code
        if (!(a.inferred === 'identifier' || a.inferred === 'text' || a.inferred === 'category') || !ID_LABEL.test(a.label) || a.distinct < 2 || a.distinct > a.filled * 0.5)
            continue;
        const words = a.label.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').split(/[^a-z]+/).filter((w) => w.length > 2 && !/^(cod|codigo|code|num|numero|ref)$/.test(w));
        for (const b of columns) {
            if (b === a || !(b.inferred === 'text' || b.inferred === 'identifier' || b.inferred === 'category'))
                continue;
            const bl = b.label.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
            const related = words.some((w) => bl.includes(w)) || b.index === a.index + 1;
            if (!related || b.distinct < a.distinct * 0.5 || b.distinct > a.distinct * 3)
                continue;
            const A = `c${a.index}`;
            const B = `c${b.index}`;
            // a code/name pair means the code determines the name, apart from spelling variants. Two columns that vary
            // independently (a ledger: every account under every cost centre) are not one: count the rows whose name,
            // normalised, is not the most common one for its code; over a quarter of the rows, skip the pair.
            const fit = db.prepare(`SELECT sum(n) total, sum(n) - sum(top) other FROM (SELECT ${A}, sum(n) n, max(n) top FROM (SELECT ${A}, gw_namekey(${B}) k, count(*) n ${W} AND ${A} IS NOT NULL AND ${B} IS NOT NULL GROUP BY ${A}, k) GROUP BY ${A})`).get();
            if (!fit.total || (fit.other ?? 0) > fit.total * 0.25)
                continue;
            const many = db.prepare(`SELECT ${A} code, json_group_array(name) names, json_group_array(n) counts FROM (SELECT ${A}, ${B} name, count(*) n ${W} AND ${A} IS NOT NULL AND ${B} IS NOT NULL GROUP BY ${A}, ${B} ORDER BY n DESC) GROUP BY ${A} HAVING count(*) > 1 ORDER BY sum(n) DESC`).all();
            const groups = db.prepare(`SELECT k, json_group_array(DISTINCT code) codes, min(name) name FROM (SELECT gw_namekey(${B}) k, ${A} code, ${B} name ${W} AND ${A} IS NOT NULL AND ${B} IS NOT NULL GROUP BY ${A}, ${B}) GROUP BY k HAVING count(DISTINCT code) > 1 ORDER BY count(DISTINCT code) DESC`).all();
            if (!many.length && !groups.length)
                continue;
            pairs.push({
                code: a.key,
                name: b.key,
                codesWithManyNames: many.length,
                namesWithManyCodes: groups.length,
                examples: many.slice(0, 8).map((m) => ({ code: String(m.code), names: JSON.parse(m.names), counts: JSON.parse(m.counts) })),
                groups: groups.slice(0, 12).map((g) => ({ name: g.name, codes: JSON.parse(g.codes).map(String) })),
            });
        }
    }
    // columns that are always (or almost always) equal: a due date that is the issue date
    const equal = [];
    for (let x = 0; x < columns.length; x++)
        for (let y = x + 1; y < columns.length; y++) {
            const a = columns[x];
            const b = columns[y];
            if (a.inferred !== b.inferred || !['date', 'number'].includes(a.inferred) || !a.filled)
                continue;
            const r = db.prepare(`SELECT total(c${a.index} IS c${b.index}) e, count(*) n ${W}`).get();
            if (Number(r.e) >= Number(r.n) * 0.99)
                equal.push({ a: a.key, b: b.key, equal: Number(r.e), of: Number(r.n) });
        }
    const gaps = total.m === null ? 0 : Number(total.m) - headerRow - rows;
    return { index: sheet.index, name: sheet.name, headerRow, headerCandidates: det.candidates.map((i) => Number(head[i]._r)), rows, gaps, totalsRows, columns, pairs, equal, ms: Date.now() - t0 };
}

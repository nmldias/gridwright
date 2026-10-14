// The dataset engine: what runs inside the dataset worker (datasetworker.ts). It reads a file into
// a raw table exactly as the file stored it (dsingest), profiles every column (dsprofile), and runs a
// recipe's steps one by one (dsrun), each compiled to SQL the engine writes itself. This module holds
// the value rules both share: numbers in either locale, dates, tidy text, name keys — registered as
// SQL functions so that a step over 271,000 rows is one UPDATE, not a loop in JavaScript.
// ------------------------------------------------------------------ values
const SPACES = /[\s\u00a0\u2007\u202f\u200b\u200c\u200d\ufeff]+/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const CURRENCY = ['AOA', 'Kz', 'KZ', 'kz', 'USD', 'EUR', 'US$', '€', '$', '£'];
/** Text tidied: invisible and control characters removed, runs of spaces collapsed, ends trimmed; '' → null. */
export function clean(v) {
    if (typeof v !== 'string')
        return v;
    const s = v.replace(CONTROL, '').replace(SPACES, ' ').trim();
    return s === '' ? null : s;
}
function numberBody(raw) {
    let s = raw.replace(SPACES, '');
    if (!s || !/\d/.test(s))
        return null;
    let neg = false;
    let pct = false;
    if (s.endsWith('%')) {
        pct = true;
        s = s.slice(0, -1);
    }
    for (const c of CURRENCY) {
        if (s.startsWith(c))
            s = s.slice(c.length);
        if (s.endsWith(c))
            s = s.slice(0, -c.length);
    }
    if (/^\(.*\)$/.test(s)) {
        neg = true;
        s = s.slice(1, -1);
    }
    // an accounting export's trailing minus ("1.234,00-")
    if (/^[\d.,]+-$/.test(s)) {
        neg = true;
        s = s.slice(0, -1);
    }
    if (s.startsWith('-')) {
        neg = !neg;
        s = s.slice(1);
    }
    else if (s.startsWith('+'))
        s = s.slice(1);
    if (!/^[\d.,]+$/.test(s) || !/^\d|^[.,]\d/.test(s))
        return null;
    return { body: s, neg, pct };
}
/** How a number written as text is formatted: Portuguese (1.234,56), English (1,234.56), plain digits, or ambiguous (1.500). */
export function numClass(v) {
    if (typeof v !== 'string')
        return null;
    const b = numberBody(v);
    if (!b)
        return null;
    const s = b.body;
    const dot = s.includes('.');
    const comma = s.includes(',');
    if (!dot && !comma)
        return 'plain';
    if (dot && comma)
        return s.lastIndexOf(',') > s.lastIndexOf('.') ? 'pt' : 'en';
    const sep = comma ? ',' : '.';
    const parts = s.split(sep);
    if (parts.length > 2)
        return parts.slice(1).every((p) => p.length === 3) ? (comma ? 'en' : 'pt') : null;
    // one separator: three digits after it could be thousands or decimals
    if (parts[1].length === 3 && parts[0].length >= 1 && parts[0].length <= 3 && parts[0] !== '0')
        return 'ambiguous';
    return comma ? 'pt' : 'en';
}
/** A number from a cell under a declared format; null when the text is not a number in that format. */
export function toNumber(v, locale = 'pt') {
    if (typeof v === 'number')
        return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string')
        return null;
    const b = numberBody(v);
    if (!b)
        return null;
    const [thou, dec] = locale === 'pt' ? ['.', ','] : [',', '.'];
    let s = b.body;
    const lastDec = s.lastIndexOf(dec);
    let intPart = lastDec >= 0 ? s.slice(0, lastDec) : s;
    const frac = lastDec >= 0 ? s.slice(lastDec + 1) : '';
    if (frac.includes(thou) || frac.includes(dec))
        return null;
    if (intPart.includes(thou)) {
        const groups = intPart.split(thou);
        if (!groups[0] || groups[0].length > 3 || !groups.slice(1).every((g) => g.length === 3))
            return null;
        intPart = groups.join('');
    }
    if (intPart.includes(dec))
        return null;
    s = `${intPart || '0'}${frac ? `.${frac}` : ''}`;
    if (!/^\d+(\.\d+)?$/.test(s))
        return null;
    let n = Number(s);
    if (!Number.isFinite(n))
        return null;
    if (b.pct)
        n /= 100;
    return b.neg ? -n : n;
}
const pad = (n) => String(n).padStart(2, '0');
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const isoOf = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m) && y >= 1900 && y <= 2200 ? `${y}-${pad(m)}-${pad(d)}` : null);
/** An ISO date (yyyy-mm-dd) from a cell: an ISO text, dd/mm/yyyy (or mm/dd when dayFirst is false), a spreadsheet serial. */
export function toDate(v, dayFirst = true) {
    if (typeof v === 'number') {
        if (v > 20000 && v < 80000) {
            const d = new Date(Math.round((v - 25569) * 86_400_000));
            return isoOf(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
        }
        return null;
    }
    if (typeof v !== 'string')
        return null;
    const s = v.trim();
    let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?$/.exec(s);
    if (m)
        return isoOf(+m[1], +m[2], +m[3]);
    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(s);
    if (m) {
        // two-digit years pivot as in Excel: 00-29 are 2000-2029, 30-99 are 1930-1999
        const y = m[3].length === 2 ? Number(m[3]) + (Number(m[3]) < 30 ? 2000 : 1900) : Number(m[3]);
        return dayFirst ? isoOf(y, +m[2], +m[1]) : isoOf(y, +m[1], +m[2]);
    }
    if (/^\d{8}$/.test(s))
        return isoOf(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8));
    return null;
}
/** Text a number would otherwise become: 2577 → "2577" (no ".0"), kept exact. */
export function toIdent(v) {
    if (typeof v === 'number')
        return Number.isInteger(v) ? String(v) : String(v);
    return v;
}
const LEGAL = new Set(['SA', 'S', 'A', 'LDA', 'LIMITADA', 'SARL', 'LTD', 'LTDA', 'INC', 'SU', 'EP', 'E', 'DE', 'DA', 'DO', 'DOS', 'DAS', 'THE', 'OF']);
/** A key for names that mean the same party: accents, punctuation, case and legal suffixes (S.A., Lda) removed. */
export function nameKey(v) {
    if (typeof v !== 'string')
        return v === null || v === undefined ? null : String(v);
    const s = v.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
    const words = s.split(' ').filter((w) => w && !LEGAL.has(w));
    return words.length ? words.join(' ') : s || null;
}
/** The shape of a value: letters → A, digits → 9, runs collapsed ("FT FT3326S23916N/265195" → "A A9A9A/9"). */
export function shapeOf(v) {
    if (v === null || v === undefined)
        return null;
    if (typeof v === 'number')
        return Number.isInteger(v) ? '9' : '9.9';
    return String(v).replace(/\p{L}+/gu, 'A').replace(/\d+/g, '9').slice(0, 40);
}
const TOTAL_LABEL = /^(total|totais|totals|soma|sum|grand total|total geral|subtotal|sub-total)\s*:?$/i;
function daysBetween(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string')
        return null;
    const x = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
    const y = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
    return Number.isFinite(x) && Number.isFinite(y) ? Math.round((y - x) / 86_400_000) : null;
}
const regexCache = new Map();
function compiled(pattern, flags = 'u') {
    const key = `${flags}/${String(pattern)}`;
    if (regexCache.has(key))
        return regexCache.get(key);
    let re = null;
    try {
        re = new RegExp(String(pattern).slice(0, 200), flags);
    }
    catch {
        re = null;
    }
    if (regexCache.size > 200)
        regexCache.clear();
    regexCache.set(key, re);
    return re;
}
const classifyCache = new Map();
/** Register the engine's SQL functions on a connection. */
export function registerFunctions(db) {
    const det = { deterministic: true };
    db.function('gw_clean', det, (v) => clean(v));
    db.function('gw_num', det, (v, locale) => toNumber(v, locale === 'en' ? 'en' : 'pt'));
    db.function('gw_numclass', det, (v) => numClass(v));
    db.function('gw_date', det, (v, dayFirst) => toDate(v, dayFirst !== 0));
    db.function('gw_isdate', det, (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(v) ? 1 : 0));
    db.function('gw_ident', det, (v) => toIdent(v));
    db.function('gw_namekey', det, (v) => nameKey(v));
    db.function('gw_shape', det, (v) => shapeOf(v));
    db.function('gw_istotal', det, (v) => (typeof v === 'string' && TOTAL_LABEL.test(v.trim()) ? 1 : 0));
    db.function('gw_month', det, (v) => (typeof v === 'string' && /^\d{4}-\d{2}/.test(v) ? v.slice(0, 7) : null));
    db.function('gw_year', det, (v) => (typeof v === 'string' && /^\d{4}/.test(v) ? Number(v.slice(0, 4)) : null));
    db.function('gw_quarter', det, (v) => (typeof v === 'string' && /^\d{4}-\d{2}/.test(v) ? `${v.slice(0, 4)}-Q${Math.ceil(Number(v.slice(5, 7)) / 3)}` : null));
    db.function('gw_weekday', det, (v) => {
        if (typeof v !== 'string')
            return null;
        const t = Date.parse(`${v.slice(0, 10)}T00:00:00Z`);
        return (Number.isFinite(t) ? ['7 Sun', '1 Mon', '2 Tue', '3 Wed', '4 Thu', '5 Fri', '6 Sat'][new Date(t).getUTCDay()] : null);
    });
    db.function('gw_days', det, (a, b) => daysBetween(a, b));
    db.function('gw_match', det, (v, pattern) => {
        if (v === null || v === undefined)
            return null;
        const re = compiled(pattern);
        if (!re)
            return null;
        return (re.test(String(v).slice(0, 1000)) ? 1 : 0);
    });
    db.function('gw_extract', det, (v, pattern) => {
        if (v === null || v === undefined)
            return null;
        const re = compiled(pattern);
        const m = re ? re.exec(String(v).slice(0, 1000)) : null;
        return (m ? (m[1] ?? m[0]) : null);
    });
    db.function('gw_classify', det, (v, rules, otherwise) => {
        if (v === null || v === undefined)
            return null;
        const key = String(rules);
        let r = classifyCache.get(key);
        if (!r) {
            r = JSON.parse(key).map((x) => ({ value: x.value, contains: x.contains.map((c) => nameKey(c) ?? c.toUpperCase()) }));
            if (classifyCache.size > 50)
                classifyCache.clear();
            classifyCache.set(key, r);
        }
        const k = ` ${nameKey(v) ?? ''} `;
        for (const rule of r)
            if (rule.contains.some((c) => k.includes(` ${c} `) || k.includes(` ${c}`)))
                return rule.value;
        return String(otherwise);
    });
}
/** A writer for one raw table: columns grow as wider rows arrive; inserts go in batches inside transactions. */
export class RawWriter {
    db;
    table;
    limits;
    progress;
    width = 0;
    stmt = null;
    rows = 0;
    inTx = false;
    constructor(db, table, limits, progress) {
        this.db = db;
        this.table = table;
        this.limits = limits;
        this.progress = progress;
        db.exec(`DROP TABLE IF EXISTS ${table}; CREATE TABLE ${table} (_r INTEGER PRIMARY KEY)`);
    }
    widen(n) {
        if (n <= this.width)
            return;
        if (n > this.limits.maxCols)
            n = this.limits.maxCols;
        for (let c = this.width; c < n; c++)
            this.db.exec(`ALTER TABLE ${this.table} ADD COLUMN c${c}`);
        this.width = n;
        const cols = Array.from({ length: n }, (_, i) => `c${i}`).join(', ');
        this.stmt = this.db.prepare(`INSERT INTO ${this.table} (_r, ${cols}) VALUES (?${', ?'.repeat(n)})`);
    }
    presize(n) {
        this.widen(Math.min(n, this.limits.maxCols));
    }
    add(r, cells) {
        if (this.rows >= this.limits.maxRows)
            throw new Error(`more than ${this.limits.maxRows.toLocaleString('en-GB')} rows in one sheet (GRIDWRIGHT_DATASET_MAX_ROWS)`);
        if (!this.inTx) {
            this.db.exec('BEGIN');
            this.inTx = true;
        }
        this.widen(Math.min(cells.length, this.limits.maxCols));
        const vals = new Array(this.width);
        for (let i = 0; i < this.width; i++)
            vals[i] = cells[i] ?? null;
        this.stmt.run(r, ...vals);
        this.rows++;
        if (this.rows % 20_000 === 0) {
            this.db.exec('COMMIT');
            this.inTx = false;
            this.progress?.(this.rows);
        }
    }
    finish() {
        if (this.inTx)
            this.db.exec('COMMIT');
        this.inTx = false;
        if (!this.width)
            this.widen(1);
        return { rows: this.rows, cols: this.width };
    }
}
/** Delimited text (CSV, TSV, semicolon exports) streamed into a raw table: quotes, doubled quotes and line breaks inside quotes. */
export function ingestDelimited(text, w, delimiter) {
    const head = text.slice(0, 64_000);
    const d = delimiter ?? detectDelimiter(head);
    let row = [];
    let field = '';
    let quoted = false;
    let r = 0;
    const push = () => {
        row.push(field);
        field = '';
    };
    const endRow = () => {
        push();
        r++;
        if (row.some((c) => c !== ''))
            w.add(r, row.map((c) => (c === '' ? null : c)));
        row = [];
    };
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    const n = text.length;
    const dc = d.charCodeAt(0);
    while (i < n) {
        const ch = text.charCodeAt(i);
        if (quoted) {
            if (ch === 34) {
                if (text.charCodeAt(i + 1) === 34) {
                    field += '"';
                    i += 2;
                    continue;
                }
                quoted = false;
                i++;
                continue;
            }
            const next = text.indexOf('"', i);
            const end = next < 0 ? n : next;
            field += text.slice(i, end);
            i = end;
            continue;
        }
        if (ch === 34 && field === '') {
            quoted = true;
            i++;
        }
        else if (ch === dc) {
            push();
            i++;
        }
        else if (ch === 10 || ch === 13) {
            endRow();
            i += ch === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
        }
        else {
            // the run of ordinary characters up to the next delimiter, quote or line break
            let j = i + 1;
            while (j < n) {
                const c = text.charCodeAt(j);
                if (c === dc || c === 10 || c === 13 || c === 34)
                    break;
                j++;
            }
            field += text.slice(i, j);
            i = j;
        }
    }
    if (field !== '' || row.length)
        endRow();
    return { delimiter: d };
}
function detectDelimiter(head) {
    const lines = head.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
    let best = ',';
    let bestScore = -1;
    for (const d of [',', ';', '\t', '|']) {
        const counts = lines.map((l) => l.split(d).length - 1);
        if (!counts.length || counts[0] === 0)
            continue;
        const same = counts.filter((c) => c === counts[0]).length;
        const score = same * 100 + counts[0];
        if (score > bestScore) {
            bestScore = score;
            best = d;
        }
    }
    return best;
}
/** Text from bytes: UTF-8, or Windows-1252 when the bytes are not valid UTF-8 (older Portuguese exports). */
export function decodeText(buf) {
    try {
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
    }
    catch {
        return { text: new TextDecoder('windows-1252').decode(buf), encoding: 'windows-1252' };
    }
}

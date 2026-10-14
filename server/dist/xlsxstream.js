// A streaming reader for .xlsx/.xlsm workbooks, for files far beyond what a grid can hold (hundreds
// of thousands of rows). The zip's central directory is read from the buffer; each XML part is
// inflated as a stream and scanned row by row, so memory follows one row and the shared strings,
// never the whole sheet. Cell values are returned as the file stored them: numbers as numbers, text
// as text, a number under a date style as an ISO date, a formula as the value it last computed.
// Nothing is executed. Limits: the inflated bytes are counted as they are produced (a zip bomb stops
// at the limit, whatever the directory declares), and the caller sets a row and column ceiling.
import { StringDecoder } from 'node:string_decoder';
import { createInflateRaw } from 'node:zlib';
export class StreamLimit extends Error {
}
/** The entries of a zip archive from its central directory (no ZIP64, no encryption). */
export function zipEntries(buf) {
    const out = new Map();
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0)
        throw new Error('not a zip archive (no central directory): is this really an .xlsx file?');
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    if (p === 0xffffffff)
        throw new Error('ZIP64 workbooks are not supported');
    for (let n = 0; n < count; n++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50)
            throw new Error('the zip central directory is damaged');
        const flags = buf.readUInt16LE(p + 8);
        const method = buf.readUInt16LE(p + 10);
        const csize = buf.readUInt32LE(p + 20);
        const usize = buf.readUInt32LE(p + 24);
        const nlen = buf.readUInt16LE(p + 28);
        const xlen = buf.readUInt16LE(p + 30);
        const clen = buf.readUInt16LE(p + 32);
        const offset = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nlen);
        if (flags & 1)
            throw new Error('encrypted workbooks are not supported: save it without a password');
        out.set(name.replace(/^\/+/, ''), { name, method, csize, usize, offset });
        p += 46 + nlen + xlen + clen;
    }
    return out;
}
function entryData(buf, e) {
    const p = e.offset;
    if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50)
        throw new Error(`the zip entry ${e.name} is damaged`);
    const nlen = buf.readUInt16LE(p + 26);
    const xlen = buf.readUInt16LE(p + 28);
    const start = p + 30 + nlen + xlen;
    if (start + e.csize > buf.length)
        throw new Error(`the zip entry ${e.name} is truncated`);
    return buf.subarray(start, start + e.csize);
}
/** Inflate one entry as a stream of text chunks; the inflated bytes count against a shared budget. */
export async function* entryText(buf, e, budget) {
    const data = entryData(buf, e);
    const dec = new StringDecoder('utf8');
    if (e.method === 0) {
        budget.left -= data.length;
        if (budget.left < 0)
            throw new StreamLimit('the workbook inflates beyond the import limit');
        for (let i = 0; i < data.length; i += 1 << 20)
            yield dec.write(data.subarray(i, i + (1 << 20)));
        yield dec.end();
        return;
    }
    if (e.method !== 8)
        throw new Error(`unsupported zip compression (${e.method}) in ${e.name}`);
    const inflate = createInflateRaw({ chunkSize: 1 << 20 });
    const feed = async () => {
        for (let i = 0; i < data.length; i += 1 << 20) {
            if (!inflate.write(data.subarray(i, i + (1 << 20))))
                await new Promise((r) => inflate.once('drain', r));
        }
        inflate.end();
    };
    const fed = feed().catch((err) => inflate.destroy(err));
    try {
        for await (const chunk of inflate) {
            budget.left -= chunk.length;
            if (budget.left < 0) {
                inflate.destroy();
                throw new StreamLimit('the workbook inflates beyond the import limit');
            }
            yield dec.write(chunk);
        }
        yield dec.end();
    }
    finally {
        await fed;
    }
}
async function wholeText(buf, e, budget, max = 32 << 20) {
    if (!e)
        return '';
    let s = '';
    for await (const t of entryText(buf, e, budget)) {
        s += t;
        if (s.length > max)
            throw new StreamLimit(`${e.name} is larger than ${max >> 20} MB`);
    }
    return s;
}
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeXml(s) {
    if (!s.includes('&'))
        return s;
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, g) => {
        if (g[0] === '#') {
            const cp = g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
            return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
        }
        return ENT[g] ?? m;
    });
}
/** The text of a <si> or <is> run: every <t>, phonetic runs (<rPh>) excluded; _x000D_ escapes decoded. */
function runText(inner) {
    const body = inner.includes('<rPh') ? inner.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '') : inner;
    let s = '';
    const re = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
    let m;
    while ((m = re.exec(body)))
        s += m[1] ?? '';
    s = decodeXml(s);
    return s.includes('_x') ? s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16))) : s;
}
const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
/** Which cell styles (xf indexes) show a number as a date. */
export function dateStyles(stylesXml) {
    const custom = new Map();
    for (const m of stylesXml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g))
        custom.set(Number(m[1]), decodeXml(m[2]));
    const isDateFmt = (id) => {
        if (BUILTIN_DATE.has(id))
            return true;
        const code = custom.get(id);
        if (!code)
            return false;
        const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
        return /[dmyhs]/i.test(bare) && !/^[#0.,%\sE+-]*$/.test(bare);
    };
    const out = new Set();
    const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '';
    let i = 0;
    for (const m of xfs.matchAll(/<xf\b([^>]*?)(\/>|>)/g)) {
        const id = Number(/numFmtId="(\d+)"/.exec(m[1])?.[1] ?? 0);
        if (isDateFmt(id))
            out.add(i);
        i++;
    }
    return out;
}
const pad = (n) => String(n).padStart(2, '0');
/** An Excel serial (1900 or 1904 system) as an ISO date, or date and time when it has a time part. */
export function serialToIso(serial, date1904 = false) {
    if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465)
        return null;
    const ms = Math.round((serial + (date1904 ? 1462 : 0) - 25569) * 86_400_000);
    const d = new Date(ms);
    if (Number.isNaN(d.getTime()))
        return null;
    const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const secs = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
    return secs ? `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` : day;
}
export function colIndex(ref) {
    let n = 0;
    for (let i = 0; i < ref.length; i++) {
        const c = ref.charCodeAt(i);
        if (c < 65 || c > 90)
            break;
        n = n * 26 + (c - 64);
    }
    return n - 1;
}
/** Open a workbook for streaming: the directory, the sheet list, the shared strings and the date styles. */
export async function openWorkbook(buf, opts) {
    const entries = zipEntries(buf);
    const budget = { left: opts.maxInflated };
    const wbXml = await wholeText(buf, entries.get('xl/workbook.xml'), budget);
    if (!wbXml)
        throw new Error('not an Excel workbook (xl/workbook.xml is missing)');
    const relsXml = await wholeText(buf, entries.get('xl/_rels/workbook.xml.rels'), budget);
    const rels = new Map();
    for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
        const id = /\bId="([^"]+)"/.exec(m[1])?.[1];
        const target = /\bTarget="([^"]+)"/.exec(m[1])?.[1];
        if (id && target)
            rels.set(id, target);
    }
    const date1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(wbXml);
    const sheets = [];
    for (const m of wbXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
        const name = decodeXml(/\bname="([^"]*)"/.exec(m[1])?.[1] ?? `Sheet${sheets.length + 1}`);
        const rid = /\br:id="([^"]+)"/.exec(m[1])?.[1] ?? /\bid="([^"]+)"/.exec(m[1])?.[1];
        let target = rid ? rels.get(rid) : undefined;
        if (!target)
            continue;
        target = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
        target = target.replace(/\/\.\//g, '/');
        if (!entries.has(target))
            continue;
        sheets.push({ name, path: target });
    }
    if (!sheets.length)
        throw new Error('the workbook has no worksheets');
    const styles = dateStyles(await wholeText(buf, entries.get('xl/styles.xml'), budget));
    // shared strings, streamed <si> by <si>
    const sst = [];
    const sstEntry = entries.get('xl/sharedStrings.xml');
    if (sstEntry) {
        let carry = '';
        for await (const chunk of entryText(buf, sstEntry, budget)) {
            carry += chunk;
            let last = 0;
            const re = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
            let m;
            while ((m = re.exec(carry))) {
                sst.push(m[1] === undefined ? '' : runText(m[1]));
                last = re.lastIndex;
            }
            carry = carry.slice(last);
            if (carry.length > 8 << 20)
                throw new StreamLimit('a shared string is larger than 8 MB');
        }
    }
    return {
        sheets,
        date1904,
        async rows(sheetIndex, onRow) {
            const info = sheets[sheetIndex];
            if (!info)
                throw new Error('no such sheet');
            const e = entries.get(info.path);
            let carry = '';
            let rowNo = 0;
            let rows = 0;
            let formulas = 0;
            let cols = 0;
            let stop = false;
            const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
            const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
            const handleRow = (attrs, inner) => {
                const rAttr = /\br="(\d+)"/.exec(attrs)?.[1];
                rowNo = rAttr ? Number(rAttr) : rowNo + 1;
                if (!inner)
                    return;
                const cells = [];
                let next = 0;
                cellRe.lastIndex = 0;
                let m;
                while ((m = cellRe.exec(inner))) {
                    const a = m[1];
                    const ref = /\br="([A-Z]+)\d*"/.exec(a)?.[1];
                    const ci = ref ? colIndex(ref) : next;
                    next = ci + 1;
                    if (ci >= opts.maxCols)
                        continue;
                    const body = m[2];
                    if (body === undefined)
                        continue;
                    const t = /\bt="(\w+)"/.exec(a)?.[1] ?? 'n';
                    if (body.includes('<f'))
                        formulas++;
                    let v = null;
                    if (t === 'inlineStr') {
                        const is = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body)?.[1];
                        v = is === undefined ? null : runText(is);
                    }
                    else {
                        const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
                        if (raw === undefined)
                            v = null;
                        else if (t === 's')
                            v = sst[Number(raw)] ?? null;
                        else if (t === 'str' || t === 'e')
                            v = decodeXml(raw);
                        else if (t === 'b')
                            v = raw === '1' ? 'TRUE' : 'FALSE';
                        else if (t === 'd')
                            v = decodeXml(raw).replace('T', ' ').replace(/ 00:00:00(\.0+)?Z?$/, '').replace(/Z$/, '');
                        else {
                            const n = Number(raw);
                            if (!Number.isFinite(n))
                                v = decodeXml(raw);
                            else {
                                const s = /\bs="(\d+)"/.exec(a)?.[1];
                                v = s !== undefined && styles.has(Number(s)) ? (serialToIso(n, date1904) ?? n) : n;
                            }
                        }
                    }
                    if (v === '')
                        v = null;
                    if (v !== null) {
                        while (cells.length < ci)
                            cells.push(null);
                        cells[ci] = v;
                    }
                }
                if (!cells.length)
                    return;
                cols = Math.max(cols, cells.length);
                rows++;
                if (onRow(rowNo, cells) === false)
                    stop = true;
            };
            for await (const chunk of entryText(buf, e, budget)) {
                carry += chunk;
                if (!info.dimension) {
                    const d = /<dimension\b[^>]*ref="([^"]+)"/.exec(carry);
                    if (d)
                        info.dimension = d[1];
                }
                let last = 0;
                rowRe.lastIndex = 0;
                let m;
                while ((m = rowRe.exec(carry))) {
                    // a row whose end is not in this chunk yet: wait for the next one
                    if (m[2] === undefined && !m[0].endsWith('/>'))
                        break;
                    handleRow(m[1], m[2]);
                    last = rowRe.lastIndex;
                    if (stop)
                        break;
                }
                carry = carry.slice(last);
                if (stop)
                    break;
                if (carry.length > 16 << 20)
                    throw new StreamLimit('a single row is larger than 16 MB');
            }
            return { rows, formulas, cols };
        },
    };
}

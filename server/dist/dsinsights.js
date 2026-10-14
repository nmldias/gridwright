const r2 = (v) => Math.round(v * 100) / 100;
/** a customer name without punctuation, accents, legal suffixes and small words: equal keys, same customer */
const LEGAL = new Set(['SA', 'S', 'A', 'LDA', 'LTDA', 'LTD', 'LIMITADA', 'SARL', 'SU', 'INC', 'LLC', 'PLC', 'GMBH', 'SL', 'SAS', 'DE', 'DA', 'DO', 'DOS', 'DAS', 'E', 'THE', 'OF', 'AND', 'CIA', 'COMPANHIA']);
export const nameKey = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter((w) => w && !LEGAL.has(w)).join(' ');
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const big = (v, unit) => {
    const a = Math.abs(v);
    const s = a >= 1e9 ? `${(v / 1e9).toFixed(2)} bn` : a >= 1e6 ? `${(v / 1e6).toFixed(1)} M` : a >= 1e3 ? `${(v / 1e3).toFixed(1)} k` : v.toFixed(0);
    return unit ? `${s} ${unit}` : s;
};
const q = (k) => `"${k.replace(/"/g, '')}"`;
/** least-squares slope of y over 0..n-1, relative to the mean (per step) */
function slope(y) {
    const n = y.length;
    if (n < 3)
        return 0;
    const mx = (n - 1) / 2;
    const my = y.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
        num += (i - mx) * (y[i] - my);
        den += (i - mx) ** 2;
    }
    return my ? num / den / my : 0;
}
export function insightsOf(runPath, roles, unit, open) {
    const t0 = Date.now();
    const db = open(runPath);
    const items = [];
    try {
        const cols = new Set(db.prepare(`SELECT name FROM pragma_table_info('work')`).all().map((r) => r.name));
        const has = (k) => !!k && cols.has(k);
        const A = has(roles.amount) ? roles.amount : undefined;
        const D = has(roles.date) ? roles.date : undefined;
        const M = has(roles.month) ? roles.month : undefined;
        if (!A || !D)
            return { asOf: null, from: null, months: [], items: [], ms: Date.now() - t0 };
        const month = M ? q(M) : `substr(${q(D)}, 1, 7)`;
        const isOpen = has(roles.status) && roles.openValue ? `${q(roles.status)} = ?` : null;
        const openArgs = isOpen ? [roles.openValue] : [];
        const C = has(roles.customerCode) ? roles.customerCode : has(roles.customer) ? roles.customer : undefined;
        const NAME = has(roles.customer) ? roles.customer : C;
        const span = db.prepare(`SELECT min(${q(D)}) a, max(${q(D)}) b FROM work WHERE ${q(D)} IS NOT NULL`).get();
        const asOf = span.b;
        const monthsSql = `SELECT ${month} m, count(*) docs, total(CASE WHEN ${q(A)} > 0 THEN ${q(A)} END) inv, -total(CASE WHEN ${q(A)} < 0 THEN ${q(A)} END) cred, total(${q(A)}) net${isOpen ? `, total(CASE WHEN ${isOpen} THEN ${q(A)} END) open` : ''}${C ? `, count(DISTINCT ${q(C)}) cust` : ''} FROM work WHERE ${q(D)} IS NOT NULL GROUP BY 1 ORDER BY 1`;
        const months = db.prepare(monthsSql).all(...openArgs).map((r) => ({ month: String(r.m), docs: Number(r.docs), invoiced: r2(Number(r.inv)), credited: r2(Number(r.cred)), net: r2(Number(r.net)), open: r.open === undefined ? undefined : r2(Number(r.open)), customers: r.cust === undefined ? undefined : Number(r.cust) }));
        // a month that is not over yet would read as a fall: the last month is partial when the data stops before its end
        const lastDay = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
        const partial = months.length && asOf && asOf < lastDay(months[months.length - 1].month) ? months[months.length - 1].month : null;
        const full = partial ? months.slice(0, -1) : months;
        // 1. the trend of the net amount
        if (full.length >= 3) {
            const net = full.map((m) => m.net);
            const s = slope(net);
            const avg = net.reduce((a, b) => a + b, 0) / net.length;
            const best = full.reduce((a, b) => (b.net > a.net ? b : a));
            const worst = full.reduce((a, b) => (b.net < a.net ? b : a));
            const last = full[full.length - 1];
            const prev = full[full.length - 2];
            const mom = prev.net ? last.net / prev.net - 1 : 0;
            items.push({
                id: 'net_trend', kind: 'trend', level: s > 0.005 ? 'good' : s < -0.005 ? 'warning' : 'info',
                title: s > 0.005 ? 'Net amount is growing' : s < -0.005 ? 'Net amount is falling' : 'Net amount is flat',
                text: `Over ${full.length} months the net amount ${s > 0.005 ? 'grows' : s < -0.005 ? 'falls' : 'moves'} ${pct(Math.abs(s))} a month on average (least squares), from ${big(full[0].net, unit)} in ${full[0].month} to ${big(last.net, unit)} in ${last.month} (${mom >= 0 ? '+' : ''}${pct(mom)} on ${prev.month}). Best month ${best.month} (${big(best.net, unit)}), weakest ${worst.month} (${big(worst.net, unit)}); average ${big(avg, unit)}.${partial ? ` ${partial} is left out: the data stops on ${asOf}.` : ''}`,
                figures: [{ label: 'Monthly trend', value: pct(s) }, { label: 'Average month', value: r2(avg), unit }, { label: `${last.month} vs ${prev.month}`, value: pct(mom) }],
                series: [{ label: 'Net amount', unit, x: months.map((m) => m.month), y: months.map((m) => m.net) }, { label: 'Invoiced', unit, x: months.map((m) => m.month), y: months.map((m) => m.invoiced) }],
                sql: monthsSql,
            });
            // documents and the average document
            const tick = full.map((m) => (m.docs ? m.invoiced / m.docs : 0));
            const ts = slope(tick);
            items.push({
                id: 'ticket', kind: 'trend', level: 'info', title: 'Volume and average document',
                text: `${Math.round(full.reduce((a, m) => a + m.docs, 0) / full.length).toLocaleString('en-GB')} documents a month on average; the average invoiced document is ${big(tick[tick.length - 1], unit)} in ${last.month} (${ts >= 0 ? 'rising' : 'falling'} ${pct(Math.abs(ts))} a month). Changes in the net amount come ${Math.abs(ts) > Math.abs(slope(full.map((m) => m.docs))) ? 'more from the value of each document than from the number of documents' : 'more from the number of documents than from their value'}.`,
                figures: [{ label: 'Average document', value: r2(tick[tick.length - 1]), unit }, { label: 'Documents trend', value: pct(slope(full.map((m) => m.docs))) }],
                series: [{ label: 'Documents', x: months.map((m) => m.month), y: months.map((m) => m.docs) }],
            });
            // credit notes
            const ratios = full.map((m) => (m.invoiced ? m.credited / m.invoiced : 0));
            const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
            const sd = Math.sqrt(ratios.reduce((a, b) => a + (b - mean) ** 2, 0) / ratios.length);
            const spikes = full.filter((_, i) => ratios[i] > mean + 1.2 * sd && ratios[i] > mean * 1.25);
            if (full.some((m) => m.credited > 0))
                items.push({
                    id: 'credit_ratio', kind: 'trend', level: spikes.length ? 'warning' : 'info',
                    title: spikes.length ? `Credit notes spike in ${spikes.map((m) => m.month).join(', ')}` : 'Credit notes are steady',
                    text: `Credit notes take back ${pct(mean)} of what is invoiced in a typical month${spikes.length ? `, but ${spikes.map((m) => `${m.month} ${pct(m.credited / m.invoiced)} (${big(m.credited, unit)})`).join(' and ')}: worth asking what was corrected or disputed then` : ` (between ${pct(Math.min(...ratios))} and ${pct(Math.max(...ratios))})`}.`,
                    figures: [{ label: 'Average credit ratio', value: pct(mean) }, ...spikes.map((m) => ({ label: `Credit ratio ${m.month}`, value: pct(m.credited / m.invoiced) }))],
                    series: [{ label: 'Credit notes / invoiced', unit: '%', x: full.map((m) => m.month), y: ratios.map((x) => Math.round(x * 10000) / 100) }],
                });
        }
        // 2. mix by customer type
        if (has(roles.customerType) && months.length >= 2) {
            const T = roles.customerType;
            const rows = db.prepare(`SELECT ${month} m, ${q(T)} t, total(${q(A)}) net FROM work WHERE ${q(D)} IS NOT NULL GROUP BY 1, 2 ORDER BY 1`).all();
            const types = [...new Set(rows.map((r) => r.t ?? '(blank)'))];
            const byMonth = new Map();
            for (const r of rows) {
                const e = byMonth.get(r.m) ?? {};
                e[r.t ?? '(blank)'] = r.net;
                byMonth.set(r.m, e);
            }
            const shareOf = (m, t) => {
                const e = byMonth.get(m) ?? {};
                const tot = Object.values(e).reduce((a, b) => a + b, 0);
                return tot ? (e[t] ?? 0) / tot : 0;
            };
            const firstM = full[0]?.month ?? months[0].month;
            const lastM = full[full.length - 1]?.month ?? months[months.length - 1].month;
            const moves = types.map((t) => ({ t, a: shareOf(firstM, t), b: shareOf(lastM, t) })).sort((x, y) => Math.abs(y.b - y.a) - Math.abs(x.b - x.a));
            const total = types.map((t) => ({ t, v: rows.filter((r) => (r.t ?? '(blank)') === t).reduce((a, r) => a + r.net, 0) })).sort((a, b) => b.v - a.v);
            const sum = total.reduce((a, b) => a + b.v, 0);
            items.push({
                id: 'mix', kind: 'mix', level: Math.abs(moves[0].b - moves[0].a) > 0.05 ? 'warning' : 'info', title: 'Who pays: the mix by customer type',
                text: `${total.map((x) => `${x.t} ${pct(sum ? x.v / sum : 0)}`).join(', ')} of the net amount. ${moves[0].t} moved from ${pct(moves[0].a)} in ${firstM} to ${pct(moves[0].b)} in ${lastM}.`,
                figures: total.map((x) => ({ label: x.t, value: r2(x.v), unit })),
                series: types.map((t) => ({ label: t, unit: '%', x: months.map((m) => m.month), y: months.map((m) => Math.round(shareOf(m.month, t) * 1000) / 10) })),
            });
        }
        // 3. concentration
        if (NAME) {
            const raw = db.prepare(`SELECT ${q(NAME)} c, total(${q(A)}) v, count(*) n FROM work WHERE ${q(NAME)} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`).all();
            // the same customer written two ways ("ALFA-SEGUROS DE TESTE, S.A." / "ALFA, SEGUROS DE TESTE, S.A.")
            // counts as one: punctuation, accents, legal suffixes and small words aside, the names are equal
            const byKey = new Map();
            for (const r of raw) {
                const k = nameKey(String(r.c));
                const g = byKey.get(k.length >= 6 ? k : `\u0000${r.c}`);
                if (g) {
                    g.v += r.v;
                    g.n += r.n;
                    g.names.push(r);
                }
                else
                    byKey.set(k.length >= 6 ? k : `\u0000${r.c}`, { c: String(r.c), v: r.v, n: r.n, names: [r] });
            }
            const rows = [...byKey.values()].sort((a, b) => b.v - a.v);
            const variants = rows.filter((g) => g.names.length > 1);
            if (variants.length) {
                const map = variants.slice(0, 50).flatMap((g) => g.names.slice(1).map((x) => ({ from: String(x.c), to: g.c })));
                const shown = variants.slice(0, 4).map((g) => `${g.names.map((x) => `“${x.c}”`).join(' / ')} (${big(g.v, unit)})`).join('; ');
                items.push({
                    id: 'name_variants', kind: 'customers', level: 'warning',
                    title: `${variants.length} customer${variants.length === 1 ? ' is' : 's are'} written in more than one way`,
                    text: `Names that differ only in punctuation, accents or legal suffix: ${shown}${variants.length > 4 ? `; and ${variants.length - 4} more` : ''}. They are counted as one customer in the concentration below; add the suggested step to unify them in every table.`,
                    figures: [{ label: 'Customers with variants', value: variants.length }, { label: 'Spellings to unify', value: map.length }],
                    step: { id: 'unify_names', type: 'map_values', column: NAME, map, why: `the same customer is written in more than one way (${variants.length} customers): unify the spelling to the one carrying the largest amount` },
                });
            }
            const tot = rows.reduce((a, r) => a + Math.max(0, r.v), 0);
            if (tot > 0 && rows.length > 1) {
                const sh = rows.map((r) => Math.max(0, r.v) / tot);
                const top5 = sh.slice(0, 5).reduce((a, b) => a + b, 0);
                const hhi = Math.round(sh.reduce((a, b) => a + b * b, 0) * 10000);
                const n80 = (() => {
                    let acc = 0;
                    for (let i = 0; i < sh.length; i++)
                        if ((acc += sh[i]) >= 0.8)
                            return i + 1;
                    return sh.length;
                })();
                items.push({
                    id: 'concentration', kind: 'concentration', level: sh[0] > 0.25 || hhi > 1500 ? 'warning' : 'info',
                    title: sh[0] > 0.25 ? `${rows[0].c} carries ${pct(sh[0])} of the net amount` : 'Concentration of customers',
                    text: `${rows.length.toLocaleString('en-GB')} customers; the largest is ${rows[0].c} (${pct(sh[0])}), the top 5 hold ${pct(top5)}, and ${n80} customers make 80% of the net amount. Herfindahl index ${hhi.toLocaleString('en-GB')} (${hhi > 2500 ? 'highly concentrated' : hhi > 1500 ? 'moderately concentrated' : 'not concentrated'}).`,
                    figures: [{ label: 'Largest customer', value: pct(sh[0]) }, { label: 'Top 5', value: pct(top5) }, { label: 'Customers for 80%', value: n80 }, { label: 'HHI', value: hhi }],
                });
            }
        }
        // 4. customers arriving and going quiet
        const arrivals = (newer) => {
            const n = newer.reduce((a, r) => a + r.n, 0);
            const by = newer.filter((r) => r.n > 0);
            return n ? `after that ${n.toLocaleString('en-GB')} new ${n === 1 ? 'one arrives' : 'ones arrive'} (${by.map((r) => `${r.m}: ${r.n}`).join(', ')})` : 'no new customer arrives after that';
        };
        if (C && asOf && months.length >= 3) {
            const firsts = db.prepare(`SELECT m, count(*) n FROM (SELECT ${q(C)} c, min(${month}) m FROM work WHERE ${q(C)} IS NOT NULL GROUP BY 1) GROUP BY 1 ORDER BY 1`).all();
            const quiet = db.prepare(`SELECT ${q(C)} c, ${NAME && NAME !== C ? `max(${q(NAME)})` : `${q(C)}`} name, max(${q(D)}) last, total(${q(A)}) v, count(*) n FROM work WHERE ${q(C)} IS NOT NULL GROUP BY 1 HAVING julianday(?) - julianday(max(${q(D)})) > 60 AND count(*) >= 20 ORDER BY v DESC LIMIT 10`).all(asOf);
            const newer = firsts.slice(1);
            items.push({
                id: 'customers', kind: 'customers', level: quiet.length ? 'warning' : 'info', title: quiet.length ? `${quiet.length} regular customers went quiet` : 'Customers arriving',
                text: `${firsts[0]?.n ?? 0} customers appear in ${firsts[0]?.m}; ${arrivals(newer)}.${quiet.length ? ` Customers with at least 20 documents and none in the last 60 days: ${quiet.slice(0, 5).map((x) => `${x.name} (last ${x.last}, ${big(x.v, unit)})`).join('; ')}.` : ''}`,
                figures: [{ label: 'New customers after the first month', value: newer.reduce((a, r) => a + r.n, 0) }, { label: 'Gone quiet (60+ days)', value: quiet.length }],
                series: [{ label: 'New customers', x: firsts.map((r) => r.m), y: firsts.map((r) => r.n) }],
            });
        }
        // 5. open receivables
        if (isOpen && asOf) {
            const o = db.prepare(`SELECT total(${q(A)}) v, count(*) n, total(CASE WHEN julianday(?) - julianday(${q(D)}) > 90 THEN ${q(A)} END) old90, total(CASE WHEN julianday(?) - julianday(${q(D)}) > 180 THEN ${q(A)} END) old180 FROM work WHERE ${isOpen}`).get(asOf, asOf, ...openArgs);
            const tot = db.prepare(`SELECT total(${q(A)}) v FROM work`).get();
            const share = tot.v ? o.v / tot.v : 0;
            const oldest = full.length ? full[0] : null;
            items.push({
                id: 'open', kind: 'receivables', level: share > 0.5 ? 'warning' : 'info',
                title: share > 0.5 ? `${pct(share)} of the net amount is still open` : 'Open documents',
                text: `${o.n.toLocaleString('en-GB')} documents (${big(o.v, unit)}) are still “${roles.openValue}” at ${asOf}: ${pct(share)} of the net amount. ${big(o.old90, unit)} is older than 90 days and ${big(o.old180, unit)} older than 180.${oldest?.open !== undefined && oldest.net ? ` Even ${oldest.month} is ${pct(oldest.open / oldest.net)} open${oldest.open / oldest.net > 0.5 ? ' — either collections lag far behind or the status is not updated when payments arrive; a receipts file would tell which' : ''}.` : ''}`,
                figures: [{ label: 'Open', value: r2(o.v), unit }, { label: 'Open share', value: pct(share) }, { label: 'Older than 90 days', value: r2(o.old90), unit }, { label: 'Older than 180 days', value: r2(o.old180), unit }],
                series: months.some((m) => m.open !== undefined) ? [{ label: 'Still open (share of the month)', unit: '%', x: months.map((m) => m.month), y: months.map((m) => (m.net ? Math.round(((m.open ?? 0) / m.net) * 1000) / 10 : 0)) }] : undefined,
            });
        }
        // 6. unusually large documents
        const n = db.prepare(`SELECT count(*) n FROM work WHERE ${q(A)} > 0`).get().n;
        if (n >= 200) {
            const at = (p) => db.prepare(`SELECT ${q(A)} v FROM work WHERE ${q(A)} > 0 ORDER BY 1 LIMIT 1 OFFSET ?`).get(Math.min(n - 1, Math.floor(n * p))).v;
            const med = at(0.5);
            const p999 = at(0.999);
            const top = db.prepare(`SELECT _row r, ${q(A)} v${NAME ? `, ${q(NAME)} c` : ''}, ${q(D)} d FROM work ORDER BY ${q(A)} DESC LIMIT 5`).all();
            const over = db.prepare(`SELECT count(*) n, total(${q(A)}) v FROM work WHERE ${q(A)} > ?`).get(p999 * 3);
            items.push({
                id: 'large', kind: 'anomaly', level: over.n ? 'warning' : 'info', title: over.n ? `${over.n} documents far above the usual size` : 'Document sizes',
                text: `The median document is ${big(med, unit)}; 99.9% are below ${big(p999, unit)}. ${over.n ? `${over.n} documents exceed three times that (${big(over.v, unit)} together). ` : ''}Largest: ${top.map((t) => `${big(t.v, unit)}${t.c ? ` ${t.c}` : ''} on ${t.d} (row ${t.r})`).join('; ')}.`,
                figures: [{ label: 'Median document', value: r2(med), unit }, { label: '99.9th percentile', value: r2(p999), unit }, { label: 'Far above usual', value: over.n }],
            });
        }
        return { asOf, from: span.a, months, items, ms: Date.now() - t0 };
    }
    finally {
        db.close();
    }
}

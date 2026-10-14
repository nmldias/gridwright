// AI cost control per client (accounts mode): a request rate per client and per person, a monthly
// token budget per client (a platform default, overridable per client), and a usage record that
// client administrators and the platform can see. Every model call the server makes for someone —
// the assistant, the companion, investigations, agent cells through the pass-through — is admitted
// here first and recorded after. Without accounts nothing is limited (the single-team server).
//
// Usage is what the model endpoint reports (`usage` in the answer); endpoints that report nothing
// are estimated at ~4 characters a token and marked as estimated.
import { identityOf } from './identity.js';
import { requirePlatformAdmin, requireRole } from './routes/common.js';
import { ACCOUNTS, audit, getTenant, listTenants, platformDb } from './tenancy.js';
const num = (v, d) => {
    const n = Number(v);
    return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
};
/** requests a minute, all of a client's people together / one person */
export const RPM_CLIENT = num(process.env.GRIDWRIGHT_AI_RPM_CLIENT, 60);
export const RPM_PERSON = num(process.env.GRIDWRIGHT_AI_RPM_PERSON, 20);
/** tokens a month for a client without its own budget (unset: unlimited) */
const DEFAULT_BUDGET = process.env.GRIDWRIGHT_AI_MONTHLY_TOKENS ? num(process.env.GRIDWRIGHT_AI_MONTHLY_TOKENS, 0) : null;
const month = (d = new Date()) => d.toISOString().slice(0, 7);
const monthName = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const usageOf = (r, m) => {
    const p = Number(r?.prompt_tokens ?? 0);
    const c = Number(r?.completion_tokens ?? 0);
    return { month: m, requests: Number(r?.requests ?? 0), promptTokens: p, completionTokens: c, totalTokens: p + c, estimated: Number(r?.estimated ?? 0) > 0 };
};
export function usage(tenant, m = month()) {
    return usageOf(platformDb().prepare('SELECT * FROM ai_usage WHERE tenant = ? AND month = ?').get(tenant, m), m);
}
function history(tenant, n = 6) {
    const rows = platformDb().prepare('SELECT * FROM ai_usage WHERE tenant = ? ORDER BY month DESC LIMIT ?').all(tenant, n);
    return rows.map((r) => usageOf(r, String(r.month)));
}
/** The client's monthly budget: its own, else the platform default (null = unlimited, 0 = AI off). */
export function budgetOf(tenant) {
    const r = platformDb().prepare('SELECT monthly_tokens FROM ai_budgets WHERE tenant = ?').get(tenant);
    if (r)
        return { tokens: r.monthly_tokens === null ? null : Number(r.monthly_tokens), own: true };
    return { tokens: DEFAULT_BUDGET, own: false };
}
export function setBudget(tenant, tokens, actor) {
    if (tokens === 'default')
        platformDb().prepare('DELETE FROM ai_budgets WHERE tenant = ?').run(tenant);
    else
        platformDb().prepare('INSERT INTO ai_budgets (tenant, monthly_tokens) VALUES (?, ?) ON CONFLICT(tenant) DO UPDATE SET monthly_tokens = excluded.monthly_tokens').run(tenant, tokens);
    audit(actor, 'client.ai-budget', { tenant, detail: tokens === 'default' ? 'platform default' : tokens === null ? 'unlimited' : `${tokens} tokens a month` });
}
// ------------------------------------------------------------------ admission
const windows = new Map();
function full(key, limit, t) {
    if (!limit)
        return 0;
    const w = (windows.get(key) ?? []).filter((x) => t - x < 60_000);
    windows.set(key, w);
    return w.length >= limit ? Math.max(1, Math.ceil((w[0] + 60_000 - t) / 1000)) : 0;
}
/**
 * May this person in this client make another model call now? `rate: false` checks only the budget
 * (the later rounds of one assistant answer are one request for the rate).
 */
export function admit(tenant, login, opts = {}) {
    if (!ACCOUNTS || !tenant)
        return { ok: true };
    const b = budgetOf(tenant);
    if (b.tokens !== null) {
        const u = usage(tenant);
        if (b.tokens === 0)
            return { ok: false, status: 429, error: 'AI is turned off for this client (its monthly budget is 0) — a platform administrator can change that' };
        if (u.totalTokens >= b.tokens)
            return { ok: false, status: 429, error: `this client has used its AI budget for ${monthName(u.month)} (${u.totalTokens.toLocaleString('en')} of ${b.tokens.toLocaleString('en')} tokens) — a platform administrator can raise it` };
    }
    if (opts.rate === false)
        return { ok: true };
    const t = Date.now();
    const waitClient = full(`c:${tenant}`, RPM_CLIENT, t);
    if (waitClient)
        return { ok: false, status: 429, error: `this client is making more than ${RPM_CLIENT} AI requests a minute — try again in ${waitClient} s`, retryAfter: waitClient };
    const waitPerson = login ? full(`p:${tenant}:${login}`, RPM_PERSON, t) : 0;
    if (waitPerson)
        return { ok: false, status: 429, error: `more than ${RPM_PERSON} AI requests a minute — try again in ${waitPerson} s`, retryAfter: waitPerson };
    windows.get(`c:${tenant}`).push(t);
    if (login)
        windows.get(`p:${tenant}:${login}`).push(t);
    if (windows.size > 20_000)
        for (const [k, w] of windows)
            if (!w.length || t - w[w.length - 1] > 60_000)
                windows.delete(k);
    return { ok: true };
}
/** Refuse with the admission's answer (true when refused). */
export function refused(res, a, openAiShape = false) {
    if (a.ok)
        return false;
    if (a.retryAfter)
        res.setHeader('retry-after', String(a.retryAfter));
    res.status(a.status).json(openAiShape ? { error: { message: a.error, type: 'gridwright_quota' } } : { error: a.error });
    return true;
}
/** Record one model call: the endpoint's own count when it gave one, else an estimate from characters. */
export function record(tenant, reported, estimate) {
    if (!ACCOUNTS || !tenant)
        return;
    const ok = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    const real = !!reported && ok(reported.prompt_tokens) && ok(reported.completion_tokens);
    const p = real ? Math.round(reported.prompt_tokens) : Math.ceil(estimate.inChars / 4);
    const c = real ? Math.round(reported.completion_tokens) : Math.ceil(estimate.outChars / 4);
    try {
        platformDb()
            .prepare(`INSERT INTO ai_usage (tenant, month, requests, prompt_tokens, completion_tokens, estimated) VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT(tenant, month) DO UPDATE SET requests = requests + 1, prompt_tokens = prompt_tokens + excluded.prompt_tokens,
           completion_tokens = completion_tokens + excluded.completion_tokens, estimated = estimated + excluded.estimated`)
            .run(tenant, month(), p, c, real ? 0 : 1);
    }
    catch (e) {
        console.error('AI usage not recorded:', e);
    }
}
/** Find the `usage` object in an OpenAI-style answer, streamed (SSE lines) or not. */
export class UsageSniffer {
    usage = null;
    chars = 0;
    buf = '';
    whole = '';
    push(chunk) {
        this.chars += chunk.length;
        if (this.whole.length < 4_000_000)
            this.whole += chunk;
        this.buf += chunk;
        const lines = this.buf.split('\n');
        this.buf = lines.pop() ?? '';
        for (const l of lines)
            this.line(l);
    }
    line(raw) {
        const l = raw.trim();
        if (!l.includes('"usage"'))
            return;
        try {
            const o = JSON.parse(l.startsWith('data:') ? l.slice(5).trim() : l);
            if (o?.usage && typeof o.usage === 'object')
                this.usage = o.usage;
        }
        catch {
            /* not a whole object on one line */
        }
    }
    end() {
        if (this.buf)
            this.line(this.buf);
        if (!this.usage && this.whole.trimStart().startsWith('{')) {
            try {
                const o = JSON.parse(this.whole);
                if (o?.usage && typeof o.usage === 'object')
                    this.usage = o.usage;
            }
            catch {
                /* not JSON */
            }
        }
        this.whole = '';
    }
}
// ------------------------------------------------------------------ routes
export function registerAiQuotaRoutes(app) {
    if (!ACCOUNTS)
        return;
    const view = (tenant) => ({ month: month(), budget: budgetOf(tenant), usage: usage(tenant), history: history(tenant), limits: { perMinuteClient: RPM_CLIENT, perMinutePerson: RPM_PERSON } });
    // a client's administrators see what their client used
    app.get('/api/tenant/ai-usage', requireRole('admin'), (req, res) => {
        const t = identityOf(req).tenant;
        if (!t)
            return res.status(404).json({ error: 'no client' });
        res.json(view(t));
    });
    // the platform sees every client and sets their budgets
    app.get('/api/platform/ai-usage', requirePlatformAdmin, (_req, res) => {
        res.json({ month: month(), defaultBudget: DEFAULT_BUDGET, limits: { perMinuteClient: RPM_CLIENT, perMinutePerson: RPM_PERSON }, clients: listTenants().map((t) => ({ id: t.id, slug: t.slug, name: t.name, budget: budgetOf(t.id), usage: usage(t.id) })) });
    });
    app.put('/api/platform/tenants/:id/ai-budget', requirePlatformAdmin, (req, res) => {
        const t = getTenant(req.params.id);
        if (!t)
            return res.status(404).json({ error: 'no such client' });
        const v = req.body?.monthlyTokens;
        let tokens;
        if (v === 'default' || v === undefined)
            tokens = 'default';
        else if (v === null || v === 'unlimited')
            tokens = null;
        else if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e13)
            tokens = Math.floor(v);
        else
            return res.status(400).json({ error: 'monthlyTokens is a number of tokens, null (unlimited) or "default"' });
        setBudget(t.id, tokens, identityOf(req).login);
        res.json(view(t.id));
    });
}

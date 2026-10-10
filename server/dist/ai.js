// Streaming proxy to an OpenAI-compatible chat completions endpoint, with an optional
// tool-calling loop: the model may call the read-only server tools (SQL, schema, history);
// every call and its result is streamed to the client as `tool` / `tool_result` events so
// the user sees exactly what the assistant looked at.
import { clientNetError, fetchFor } from './netguard.js';
import { identityOf } from './identity.js';
import { aiKeyOf, readAiConfig } from './storage.js';
import { admit, record, refused } from './aiquota.js';
import { ACCOUNTS } from './tenancy.js';
import { runTool, TOOL_DEFS } from './tools.js';
const MAX_ROUNDS = 6;
// Ask for the token count in the stream (OpenAI's stream_options); an endpoint that rejects the
// option is remembered and asked without it from then on.
const noStreamOptions = new Set();
async function postChat(go, baseUrl, headers, body, signal) {
    const withUsage = !noStreamOptions.has(baseUrl);
    const send = (b) => go(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(b), signal });
    const r = await send(withUsage ? { ...body, stream_options: { include_usage: true } } : body);
    if (withUsage && (r.status === 400 || r.status === 422)) {
        const text = await r.clone().text().catch(() => '');
        if (/stream_options|include_usage/i.test(text)) {
            noStreamOptions.add(baseUrl);
            return send(body);
        }
    }
    return r;
}
const charsOf = (messages) => JSON.stringify(messages ?? '').length;
export async function chat(req, res) {
    // the settings of the caller's client (accounts mode), else the server's
    const cfg = readAiConfig(ACCOUNTS ? identityOf(req).tenant : undefined);
    const baseUrl = (cfg.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl || !cfg.model) {
        res.status(400).json({ error: 'AI endpoint not configured — open the assistant settings (⚙) and set the base URL and model.' });
        return;
    }
    const messages = Array.isArray(req.body?.messages) ? [...req.body.messages] : null;
    if (!messages) {
        res.status(400).json({ error: 'messages required' });
        return;
    }
    const identity = identityOf(req);
    // the client's AI rate and monthly budget (accounts mode)
    if (refused(res, admit(identity.tenant, identity.login)))
        return;
    // viewers may chat, but the tools reach databases and the audit log: editors only
    let useTools = !!req.body?.tools && identity.role !== 'viewer';
    const fileId = typeof req.body?.file === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(req.body.file) ? req.body.file : undefined;
    const apiKey = aiKeyOf(cfg);
    const headers = { 'content-type': 'application/json' };
    if (apiKey)
        headers.authorization = `Bearer ${apiKey}`;
    if (/anthropic\.com/.test(baseUrl)) {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
    }
    const controller = new AbortController();
    res.on('close', () => {
        if (!res.writableEnded)
            controller.abort();
    });
    let started = false;
    const send = (obj) => {
        if (!started) {
            res.setHeader('content-type', 'text/event-stream');
            res.setHeader('cache-control', 'no-cache');
            res.setHeader('x-accel-buffering', 'no');
            res.flushHeaders();
            started = true;
        }
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    // an endpoint a client typed in goes through the egress guard (no private networks, no redirects)
    const go = fetchFor(!!cfg.clientEndpoint);
    const unreachable = (e) => (cfg.clientEndpoint ? clientNetError(e, 'the model endpoint') : `cannot reach ${baseUrl}: ${e.message}`);
    const request = async (withTools) => postChat(go, baseUrl, headers, { model: cfg.model, messages, stream: true, temperature: 0.2, max_tokens: 4096, ...(withTools ? { tools: TOOL_DEFS, tool_choice: 'auto' } : {}) }, controller.signal);
    for (let round = 0; round <= MAX_ROUNDS; round++) {
        // each further tool round is another model call: still within the month's budget?
        if (round > 0) {
            const more = admit(identity.tenant, identity.login, { rate: false });
            if (!more.ok) {
                send({ error: more.error });
                break;
            }
        }
        let upstream;
        try {
            upstream = await request(useTools);
        }
        catch (e) {
            if (!started) {
                res.status(502).json({ error: unreachable(e) });
                return;
            }
            send({ error: unreachable(e) });
            break;
        }
        if (!upstream.ok || !upstream.body) {
            const text = await upstream.text().catch(() => '');
            // servers without function calling: retry the same round without tools
            if (useTools && round === 0 && /tool|function/i.test(text)) {
                useTools = false;
                send({ notice: 'this model endpoint does not support tools; answering without them' });
                round--;
                continue;
            }
            if (!started) {
                res.status(502).json({ error: `model endpoint returned ${upstream.status}: ${text.slice(0, 500)}` });
                return;
            }
            send({ error: `model endpoint returned ${upstream.status}: ${text.slice(0, 500)}` });
            break;
        }
        let r;
        const inChars = charsOf(messages);
        try {
            r = await readRound(upstream.body, send);
        }
        catch (e) {
            record(identity.tenant, null, { inChars, outChars: 0 });
            if (!controller.signal.aborted)
                send({ error: e.message });
            break;
        }
        record(identity.tenant, r.usage, { inChars, outChars: r.text.length + r.toolCalls.reduce((n, c) => n + c.name.length + c.args.length, 0) });
        if (!r.toolCalls.length || round === MAX_ROUNDS)
            break;
        // tool round: run every call, feed the results back, and ask again
        messages.push({
            role: 'assistant',
            content: r.text || null,
            tool_calls: r.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })),
        });
        for (const call of r.toolCalls) {
            let args = {};
            try {
                args = call.args ? JSON.parse(call.args) : {};
            }
            catch {
                /* keep {} */
            }
            send({ tool: { id: call.id, name: call.name, args } });
            let content;
            try {
                const { result, summary } = await runTool(call.name, args, { fileId, who: identity });
                content = JSON.stringify(result);
                if (content.length > 60_000)
                    content = content.slice(0, 60_000) + '…(truncated)';
                send({ tool_result: { id: call.id, name: call.name, ok: true, summary, result } });
            }
            catch (e) {
                content = JSON.stringify({ error: e.message });
                send({ tool_result: { id: call.id, name: call.name, ok: false, summary: e.message } });
            }
            messages.push({ role: 'tool', tool_call_id: call.id, content });
        }
    }
    if (!started)
        send({ text: '' });
    res.write('data: [DONE]\n\n');
    res.end();
}
/** One non-interactive completion (the companion's interpretation of an issue): text and model id, or an error. */
export async function completeOnce(messages, maxTokens = 1200, tenant, login) {
    const cfg = readAiConfig(ACCOUNTS ? tenant : undefined);
    const a = admit(tenant, login);
    if (!a.ok)
        throw new Error(a.error);
    const baseUrl = (cfg.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl || !cfg.model)
        throw new Error('AI endpoint not configured — open the assistant settings (⚙) and set the base URL and model');
    const apiKey = aiKeyOf(cfg);
    const headers = { 'content-type': 'application/json' };
    if (apiKey)
        headers.authorization = `Bearer ${apiKey}`;
    if (/anthropic\.com/.test(baseUrl)) {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
        const upstream = await postChat(fetchFor(!!cfg.clientEndpoint), baseUrl, headers, { model: cfg.model, messages, stream: true, temperature: 0.2, max_tokens: maxTokens }, controller.signal);
        if (!upstream.ok || !upstream.body)
            throw new Error(`model endpoint returned ${upstream.status}: ${(await upstream.text().catch(() => '')).slice(0, 300)}`);
        let err = '';
        const r = await readRound(upstream.body, (o) => {
            const e = o.error;
            if (e)
                err = e;
        });
        record(tenant, r.usage, { inChars: charsOf(messages), outChars: r.text.length });
        if (!r.text && err)
            throw new Error(err);
        return { text: r.text.trim(), model: cfg.model };
    }
    finally {
        clearTimeout(timer);
    }
}
/** Consume one streamed completion: forward text deltas, collect tool calls. */
async function readRound(body, send) {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const out = { text: '', toolCalls: [], finish: '' };
    const calls = new Map();
    const handle = (obj) => {
        if (obj?.usage && typeof obj.usage === 'object')
            out.usage = obj.usage;
        const choice = obj.choices?.[0];
        if (!choice) {
            if (obj.error)
                send({ error: typeof obj.error === 'string' ? obj.error : obj.error.message ?? 'model error' });
            return;
        }
        const delta = choice.delta ?? choice.message ?? {};
        const text = delta.content ?? choice.text ?? '';
        if (text) {
            out.text += text;
            send({ text });
        }
        for (const tc of delta.tool_calls ?? []) {
            const idx = typeof tc.index === 'number' ? tc.index : calls.size;
            let c = calls.get(idx);
            if (!c) {
                c = { id: tc.id ?? `call_${idx}`, name: '', args: '' };
                calls.set(idx, c);
            }
            if (tc.id)
                c.id = tc.id;
            if (tc.function?.name)
                c.name += tc.function.name;
            if (tc.function?.arguments)
                c.args += tc.function.arguments;
        }
        if (choice.finish_reason)
            out.finish = choice.finish_reason;
        if (obj.error)
            send({ error: typeof obj.error === 'string' ? obj.error : obj.error.message ?? 'model error' });
    };
    for (;;) {
        const { value, done } = await reader.read();
        if (done)
            break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const raw of lines) {
            const line = raw.trim();
            if (!line.startsWith('data:'))
                continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]')
                continue;
            try {
                handle(JSON.parse(data));
            }
            catch {
                /* partial line */
            }
        }
    }
    // non-streaming fallback (some servers ignore stream:true)
    if (buf.trim().startsWith('{')) {
        try {
            handle(JSON.parse(buf));
        }
        catch {
            /* ignore */
        }
    }
    out.toolCalls = Array.from(calls.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, c]) => c)
        .filter((c) => c.name);
    return out;
}

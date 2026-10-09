// Streaming proxy to an OpenAI-compatible chat completions endpoint, with an optional
// tool-calling loop: the model may call the read-only server tools (SQL, schema, history);
// every call and its result is streamed to the client as `tool` / `tool_result` events so
// the user sees exactly what the assistant looked at.

import type { Request, Response } from 'express';
import { identityOf } from './identity.js';
import { decrypt, readAiConfig } from './storage.js';
import { runTool, TOOL_DEFS } from './tools.js';

const MAX_ROUNDS = 6;

interface ToolCall {
  id: string;
  name: string;
  args: string;
}

interface Round {
  text: string;
  toolCalls: ToolCall[];
  finish: string;
}

export async function chat(req: Request, res: Response) {
  const cfg = readAiConfig();
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
  // viewers may chat, but the tools reach databases and the audit log: editors only
  let useTools = !!req.body?.tools && identity.role !== 'viewer';
  const fileId = typeof req.body?.file === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(req.body.file) ? req.body.file : undefined;
  const apiKey = cfg.apiKeyEnc ? decrypt(cfg.apiKeyEnc) : process.env.AI_API_KEY ?? '';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (/anthropic\.com/.test(baseUrl)) {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  }
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  let started = false;
  const send = (obj: unknown) => {
    if (!started) {
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('x-accel-buffering', 'no');
      res.flushHeaders();
      started = true;
    }
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  const request = async (withTools: boolean): Promise<globalThis.Response> =>
    fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        messages,
        stream: true,
        temperature: 0.2,
        max_tokens: 4096,
        ...(withTools ? { tools: TOOL_DEFS, tool_choice: 'auto' } : {}),
      }),
      signal: controller.signal,
    });

  for (let round = 0; round <= MAX_ROUNDS; round++) {
    let upstream: globalThis.Response;
    try {
      upstream = await request(useTools);
    } catch (e) {
      if (!started) res.status(502).json({ error: `cannot reach ${baseUrl}: ${(e as Error).message}` });
      else send({ error: `cannot reach ${baseUrl}: ${(e as Error).message}` });
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
      if (!started) res.status(502).json({ error: `model endpoint returned ${upstream.status}: ${text.slice(0, 500)}` });
      else send({ error: `model endpoint returned ${upstream.status}: ${text.slice(0, 500)}` });
      break;
    }
    let r: Round;
    try {
      r = await readRound(upstream.body, send);
    } catch (e) {
      if (!controller.signal.aborted) send({ error: (e as Error).message });
      break;
    }
    if (!r.toolCalls.length || round === MAX_ROUNDS) break;
    // tool round: run every call, feed the results back, and ask again
    messages.push({
      role: 'assistant',
      content: r.text || null,
      tool_calls: r.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })),
    });
    for (const call of r.toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = call.args ? JSON.parse(call.args) : {};
      } catch {
        /* keep {} */
      }
      send({ tool: { id: call.id, name: call.name, args } });
      let content: string;
      try {
        const { result, summary } = await runTool(call.name, args, { fileId });
        content = JSON.stringify(result);
        if (content.length > 60_000) content = content.slice(0, 60_000) + '…(truncated)';
        send({ tool_result: { id: call.id, name: call.name, ok: true, summary, result } });
      } catch (e) {
        content = JSON.stringify({ error: (e as Error).message });
        send({ tool_result: { id: call.id, name: call.name, ok: false, summary: (e as Error).message } });
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }
  if (!started) send({ text: '' });
  res.write('data: [DONE]\n\n');
  res.end();
}

/** Consume one streamed completion: forward text deltas, collect tool calls. */
async function readRound(body: ReadableStream<Uint8Array>, send: (o: unknown) => void): Promise<Round> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const out: Round = { text: '', toolCalls: [], finish: '' };
  const calls = new Map<number, ToolCall>();
  const handle = (obj: any) => {
    const choice = obj.choices?.[0];
    if (!choice) {
      if (obj.error) send({ error: typeof obj.error === 'string' ? obj.error : obj.error.message ?? 'model error' });
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
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.name += tc.function.name;
      if (tc.function?.arguments) c.args += tc.function.arguments;
    }
    if (choice.finish_reason) out.finish = choice.finish_reason;
    if (obj.error) send({ error: typeof obj.error === 'string' ? obj.error : obj.error.message ?? 'model error' });
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        handle(JSON.parse(data));
      } catch {
        /* partial line */
      }
    }
  }
  // non-streaming fallback (some servers ignore stream:true)
  if (buf.trim().startsWith('{')) {
    try {
      handle(JSON.parse(buf));
    } catch {
      /* ignore */
    }
  }
  out.toolCalls = Array.from(calls.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, c]) => c)
    .filter((c) => c.name);
  return out;
}

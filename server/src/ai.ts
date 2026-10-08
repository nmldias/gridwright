// Streaming proxy to an OpenAI-compatible chat completions endpoint.

import type { Request, Response } from 'express';
import { decrypt, readAiConfig } from './storage.js';

export async function chat(req: Request, res: Response) {
  const cfg = readAiConfig();
  const baseUrl = (cfg.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl || !cfg.model) {
    res.status(400).json({ error: 'AI endpoint not configured — open the assistant settings (⚙) and set the base URL and model.' });
    return;
  }
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : null;
  if (!messages) {
    res.status(400).json({ error: 'messages required' });
    return;
  }
  const apiKey = cfg.apiKeyEnc ? decrypt(cfg.apiKeyEnc) : process.env.AI_API_KEY ?? '';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (/anthropic\.com/.test(baseUrl)) {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  }
  const controller = new AbortController();
  req.on('close', () => controller.abort());
  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: cfg.model, messages, stream: true, temperature: 0.2, max_tokens: 4096 }),
      signal: controller.signal,
    });
  } catch (e) {
    res.status(502).json({ error: `cannot reach ${baseUrl}: ${(e as Error).message}` });
    return;
  }
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    res.status(502).json({ error: `model endpoint returned ${upstream.status}: ${text.slice(0, 500)}` });
    return;
  }
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders();
  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  try {
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
          const obj = JSON.parse(data);
          const delta = obj.choices?.[0]?.delta?.content ?? obj.choices?.[0]?.text ?? '';
          if (delta) send({ text: delta });
          if (obj.error) send({ error: typeof obj.error === 'string' ? obj.error : obj.error.message ?? 'model error' });
        } catch {
          /* partial line */
        }
      }
    }
    // non-streaming fallback (some servers ignore stream:true)
    if (buf.trim().startsWith('{')) {
      try {
        const obj = JSON.parse(buf);
        const text = obj.choices?.[0]?.message?.content ?? '';
        if (text) send({ text });
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    if (!controller.signal.aborted) send({ error: (e as Error).message });
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

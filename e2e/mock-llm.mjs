// Minimal OpenAI-compatible mock: streams a canned reply with a gridwright-actions block.
// With `tools` in the request and a user message mentioning "orders" it plays a tool round:
// list_connections → run_sql (count of orders) → a final answer quoting the count.
// With a system prompt that carries "companion investigation" (the DeepAgents stack) it plays
// the investigation: read_context → run_python → remember (a proposed hypothesis) → findings.
// Non-streaming requests (stream: false, what LangChain's ChatOpenAI sends) get a JSON body.
import { createServer } from 'node:http';
const reply = `Here is a summary table.\n\n\`\`\`gridwright-actions\n[{"action":"add_table","name":"AI summary","values":[["Metric","Value"],["Total units","=SUM('Table 1'::B2:B5)"],["Note","from mock"]]},{"action":"set_cell","table":"Table 1","ref":"F8","input":"=1+1"}]\n\`\`\`\nDone.`;

function streamText(res, text, extra = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunks = text.match(/.{1,20}/gs) ?? [];
  let i = 0;
  const tick = () => {
    if (i < chunks.length) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`);
      setTimeout(tick, 5);
    } else {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], ...extra })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  };
  tick();
}

function streamToolCall(res, id, name, args) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const argText = JSON.stringify(args);
  // arguments arrive in pieces, like real servers send them
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: argText.slice(0, 8) } }] } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argText.slice(8) } }] } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

/** One complete (non-streaming) chat completion, as LangChain's ChatOpenAI expects it. */
function jsonReply(res, model, { text = null, toolCalls = [] } = {}) {
  const message = { role: 'assistant', content: text };
  if (toolCalls.length) message.tool_calls = toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
  const body = { id: `chatcmpl-mock-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message, finish_reason: toolCalls.length ? 'tool_calls' : 'stop', logprobs: null }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** The investigation the DeepAgents stack runs: what the mock answers depends only on how many tool results it has seen. */
function investigationStep(msgs) {
  const toolResults = msgs.filter((m) => m.role === 'tool');
  const names = (m) => (m.tool_calls ?? []).map((c) => c.function?.name);
  const called = msgs.filter((m) => m.role === 'assistant').flatMap(names);
  if (!called.includes('read_context')) return { toolCalls: [{ id: 'inv_1', name: 'read_context', args: {} }] };
  if (!called.includes('run_python')) return { toolCalls: [{ id: 'inv_2', name: 'run_python', args: { code: 'import pandas as pd\ndf = q.table("inventory")\nint((pd.to_numeric(df["Days in stock"], errors="coerce") > 90).sum())', purpose: 'count vehicles over 90 days independently of the watch formula' } }] };
  if (!called.includes('remember')) {
    const last = toolResults[toolResults.length - 1];
    let n = '?';
    try {
      const r = JSON.parse(last.content);
      n = r.output ?? r.error ?? '?';
    } catch {
      /* ignore */
    }
    return { toolCalls: [{ id: 'inv_3', name: 'remember', args: { kind: 'hypothesis', text: `Ageing is concentrated in two models; an independent count gives ${n} vehicles over 90 days`, source: 'investigation: sandboxed pandas count' } }] };
  }
  return { text: 'Findings: the independent pandas count agrees with the watch. Uncertainty: the landed cost of one vehicle is still provisional. Next: confirm the freight allocation before repricing; nothing was changed.' };
}

createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    const msgs = parsed.messages ?? [];
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    const toolResults = msgs.filter((m) => m.role === 'tool');
    const systemText = msgs.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    console.log('mock-llm: model', parsed.model, 'messages', msgs.length, 'tools', Array.isArray(parsed.tools) ? parsed.tools.length : 0, 'tool results', toolResults.length, 'stream', parsed.stream !== false);
    if (Array.isArray(parsed.tools) && /companion investigation/i.test(systemText)) {
      const step = investigationStep(msgs);
      if (parsed.stream === false) return jsonReply(res, parsed.model, step);
      if (step.toolCalls) return streamToolCall(res, step.toolCalls[0].id, step.toolCalls[0].name, step.toolCalls[0].args);
      return streamText(res, step.text);
    }
    if (Array.isArray(parsed.tools) && /orders/i.test(String(lastUser?.content ?? ''))) {
      if (toolResults.length === 0) {
        streamToolCall(res, 'call_1', 'list_connections', {});
        return;
      }
      if (toolResults.length === 1) {
        let conns = [];
        try {
          conns = JSON.parse(toolResults[0].content);
        } catch {
          /* ignore */
        }
        const id = conns[0]?.id ?? 'none';
        streamToolCall(res, 'call_2', 'run_sql', { connection: id, sql: 'SELECT COUNT(*) AS n FROM orders' });
        return;
      }
      let n = '?';
      try {
        const r = JSON.parse(toolResults[toolResults.length - 1].content);
        n = r.rows?.[0]?.[0] ?? r.error ?? '?';
      } catch {
        /* ignore */
      }
      streamText(res, `The orders table holds ${n} rows (checked with run_sql).`);
      return;
    }
    if (parsed.stream === false) return jsonReply(res, parsed.model, { text: 'Mock answer.' });
    streamText(res, reply);
  });
}).listen(8899, () => console.log('mock llm on 8899'));

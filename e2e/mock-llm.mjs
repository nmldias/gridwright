// Minimal OpenAI-compatible mock: streams a canned reply with a gridwright-actions block.
// With `tools` in the request and a user message mentioning "orders" it plays a tool round:
// list_connections → run_sql (count of orders) → a final answer quoting the count.
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
    console.log('mock-llm: model', parsed.model, 'messages', msgs.length, 'tools', Array.isArray(parsed.tools) ? parsed.tools.length : 0, 'tool results', toolResults.length);
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
    streamText(res, reply);
  });
}).listen(8899, () => console.log('mock llm on 8899'));

// Minimal OpenAI-compatible mock: streams a canned reply with a gridwright-actions block.
import { createServer } from 'node:http';
const reply = `Here is a summary table.\n\n\`\`\`gridwright-actions\n[{"action":"add_table","name":"AI summary","values":[["Metric","Value"],["Total units","=SUM('Table 1'::B2:B5)"],["Note","from mock"]]},{"action":"set_cell","table":"Table 1","ref":"F8","input":"=1+1"}]\n\`\`\`\nDone.`;
createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunks = reply.match(/.{1,20}/gs) ?? [];
    let i = 0;
    const tick = () => {
      if (i < chunks.length) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`);
        setTimeout(tick, 5);
      } else {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    };
    console.log('mock-llm: model', parsed.model, 'messages', parsed.messages.length, 'system chars', parsed.messages[0]?.content.length);
    tick();
  });
}).listen(8899, () => console.log('mock llm on 8899'));

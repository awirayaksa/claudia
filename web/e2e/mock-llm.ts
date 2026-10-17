/**
 * OpenAI-compatible mock for the browser tests. Replies depend on the last
 * user message:
 * - contains "slow": 80 words, one every 120 ms (time to stop or open a second tab);
 * - contains "save it" and a write_file tool is offered: calls it, then answers
 *   "Saved: <tool result>";
 * - otherwise: "Echo: <message>" in a few chunks, prefixed with "[skill] " when
 *   a system prompt contains SKILL-MARKER.
 * Non-streaming calls (titles) answer "E2E Chat Title".
 */
import http from 'node:http';

const port = Number(process.env.MOCK_LLM_PORT ?? 18080);

const chunk = (delta: object) =>
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;

http
  .createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;

    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'e2e-model', name: 'e2e-model' }, { id: 'e2e-other', name: 'e2e-other' }] }));
    }
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404);
      return res.end();
    }

    const json = JSON.parse(body);
    const last = [...json.messages].reverse().find((m: any) => m.role === 'user');
    const prompt = typeof last?.content === 'string' ? last.content : '';
    const final = json.messages[json.messages.length - 1];
    const skill = json.messages.some((m: any) => m.role === 'system' && String(m.content).includes('SKILL-MARKER'));
    const writeTool = (json.tools ?? []).find((t: any) => t.function?.name === 'write_file');

    if (!json.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'E2E Chat Title' }, finish_reason: 'stop' }],
        })
      );
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    if (final?.role === 'user' && prompt.includes('save it') && writeTool) {
      const args = JSON.stringify({ path: 'e2e-note.txt', content: 'hello from e2e' });
      res.write(chunk({ tool_calls: [{ index: 0, id: 'call_e2e', type: 'function', function: { name: 'write_file', arguments: args } }] }));
      res.write(`data: ${JSON.stringify({ id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    if (final?.role === 'tool') {
      res.write(chunk({ content: `Saved: ${String(final.content).slice(0, 200)}` }));
      res.write(`data: ${JSON.stringify({ id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    let closed = false;
    res.on('close', () => (closed = true));
    const words = prompt.includes('slow')
      ? Array.from({ length: 80 }, (_, i) => `word${i} `)
      : [skill ? '[skill] Echo: ' : 'Echo: ', ...prompt.split(/(\s+)/)];
    const delay = prompt.includes('slow') ? 120 : 15;
    for (const w of words) {
      if (closed) return;
      res.write(chunk({ content: w }));
      await new Promise((r) => setTimeout(r, delay));
    }
    res.write(
      `data: ${JSON.stringify({
        id: 'c',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: words.length, total_tokens: 10 + words.length },
      })}\n\n`
    );
    res.write('data: [DONE]\n\n');
    res.end();
  })
  .listen(port, '127.0.0.1', () => console.log(`mock LLM on ${port}`));

/**
 * OpenAI-compatible mock for the browser tests. Replies depend on the last
 * user message:
 * - contains "slow": 80 words, one every 120 ms (time to stop or open a second tab);
 * - otherwise: "Echo: <message>" in a few chunks.
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
    let closed = false;
    res.on('close', () => (closed = true));
    const words = prompt.includes('slow')
      ? Array.from({ length: 80 }, (_, i) => `word${i} `)
      : ['Echo: ', ...prompt.split(/(\s+)/)];
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

/**
 * A scripted OpenAI-compatible endpoint for orchestrator tests: GET /models
 * and POST /chat/completions (streaming and not). Each completion request
 * takes the next scripted turn and is recorded.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { hashDims, hashEmbed } from './hash-embed';

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export interface MockTurn {
  text?: string[];
  reasoning?: string[];
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  /** Respond with this HTTP status and error message instead. */
  fail?: { status: number; message: string };
  /** Pause between chunks (ms), to leave room to stop a run. */
  delayMs?: number;
  finishReason?: string;
}

export interface MockOpenAI {
  url: string;
  requests: any[];
  /** Headers of every request received (model listings included). */
  headers: http.IncomingHttpHeaders[];
  /** Turns used by non-streaming calls (titles); defaults to a fixed title. */
  completions: Array<{ content: string }>;
  /** Bodies of POST /embeddings (answered with hashEmbed vectors; "hash-<n>" models give n dimensions). */
  embeddingCalls: any[];
  /** Bodies of POST /images/generations (answered with a 1×1 PNG). */
  imageCalls: any[];
  /** POST /audio/speech and /audio/transcriptions. */
  audioCalls: any[];
  push(...turns: MockTurn[]): void;
  close(): Promise<void>;
}

const chunk = (delta: object, extra: object = {}) =>
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;

export async function startMockOpenAI(models = ['gpt-test', 'gpt-other']): Promise<MockOpenAI> {
  const queue: MockTurn[] = [];
  const requests: any[] = [];
  const headers: http.IncomingHttpHeaders[] = [];
  const completions: Array<{ content: string }> = [];
  const embeddingCalls: any[] = [];
  const imageCalls: any[] = [];
  const audioCalls: any[] = [];

  const server = http.createServer(async (req, res) => {
    headers.push(req.headers);
    const body = await new Promise<string>((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => resolve(data));
    });

    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: models.map((id) => ({ id, name: id, created: 0, owned_by: 'mock' })) }));
    }
    if (req.method === 'POST' && req.url?.endsWith('/images/generations')) {
      const json = JSON.parse(body);
      imageCalls.push(json);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ created: 0, data: [{ b64_json: TINY_PNG_B64 }] }));
    }
    if (req.method === 'POST' && req.url?.endsWith('/audio/speech')) {
      audioCalls.push({ kind: 'speech', body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      return res.end(Buffer.from('ID3fake-mp3'));
    }
    if (req.method === 'POST' && req.url?.endsWith('/audio/transcriptions')) {
      audioCalls.push({ kind: 'transcription', contentType: req.headers['content-type'], size: body.length });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ text: 'Hello from the microphone' }));
    }
    if (req.method === 'POST' && req.url?.endsWith('/embeddings')) {
      const json = JSON.parse(body);
      embeddingCalls.push(json);
      const input: string[] = Array.isArray(json.input) ? json.input : [json.input];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          object: 'list',
          data: input.map((t, index) => ({ object: 'embedding', index, embedding: hashEmbed(String(t), hashDims(json.model ?? '')) })),
          model: json.model,
        })
      );
    }
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404);
      return res.end();
    }

    const json = JSON.parse(body);
    requests.push(json);

    if (!json.stream) {
      const content = completions.shift()?.content ?? 'Mock Title';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          created: 0,
          model: json.model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        })
      );
    }

    const turn = queue.shift() ?? { text: ['(no scripted turn)'] };
    if (turn.fail) {
      res.writeHead(turn.fail.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: turn.fail.message } }));
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let aborted = false;
    res.on('close', () => (aborted = true));
    const wait = () => (turn.delayMs ? new Promise((r) => setTimeout(r, turn.delayMs)) : Promise.resolve());

    for (const r of turn.reasoning ?? []) {
      if (aborted) return;
      res.write(chunk({ reasoning_content: r }));
      await wait();
    }
    for (const t of turn.text ?? []) {
      if (aborted) return;
      res.write(chunk({ content: t }));
      await wait();
    }
    (turn.toolCalls ?? []).forEach((tc, index) => {
      res.write(chunk({ tool_calls: [{ index, id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }] }));
    });
    res.write(
      `data: ${JSON.stringify({
        id: 'c',
        choices: [{ index: 0, delta: {}, finish_reason: turn.finishReason ?? (turn.toolCalls?.length ? 'tool_calls' : 'stop') }],
        ...(turn.usage ? { usage: turn.usage } : {}),
      })}\n\n`
    );
    res.write('data: [DONE]\n\n');
    res.end();
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    headers,
    completions,
    embeddingCalls,
    imageCalls,
    audioCalls,
    push: (...turns) => queue.push(...turns),
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

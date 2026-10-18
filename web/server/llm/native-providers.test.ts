/**
 * Native Anthropic and Ollama providers end to end: a connection of each type
 * lists its models and answers a chat with a tool round, against mock
 * servers that check the request shapes the real APIs expect.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';
import { chatFixture, type ChatFixture } from '../test/chat-fixture';
import type { RunToolset } from './tools';
import { toAnthropicMessages, toAnthropicRequest } from '../../../src/services/api/providers/anthropic.provider';
import { toOllamaMessages } from '../../../src/services/api/providers/ollama.provider';

let f: ChatFixture | undefined;
let server: http.Server | undefined;
afterEach(async () => {
  await f?.close();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  f = undefined;
  server = undefined;
});

async function listen(handler: (req: http.IncomingMessage, body: any, res: http.ServerResponse) => void): Promise<string> {
  server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    handler(req, raw ? JSON.parse(raw) : null, res);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const lookupTool: RunToolset = {
  definitions: [{ type: 'function', function: { name: 'lookup', description: 'Look a word up', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }],
  firstTurnOnly: false,
  locate: () => ({ serverId: 'test', tool: 'lookup' }),
  async execute(call) {
    return { serverId: 'test', tool: 'lookup', result: { type: 'tool_result', callId: call.id, content: 'tide: the rise and fall of the sea' } };
  },
};

async function chatWith(fx: ChatFixture, connection: Record<string, unknown>, model: string) {
  const res = await fx.admin.post('/api/admin/connections', connection);
  expect(res.statusCode, res.body).toBe(201);
  const models = (await fx.admin.get('/api/models')).json().models.map((m: any) => m.id);
  expect(models).toContain(model);
  const chat = (await fx.admin.post('/api/chats', {})).json().chat.id;
  const start = await fx.admin.post(`/api/chats/${chat}/completions`, {
    parentId: null,
    content: 'What is a tide?',
    modelIds: [model],
    toolIds: ['test'],
    params: { effort: 'low' },
  });
  expect(start.statusCode, start.body).toBe(202);
  await fx.readRun(fx.admin, start.json().runId);
  const node = (await fx.admin.get(`/api/chats/${chat}`)).json().chat.messages.find((m: any) => m.role === 'assistant');
  return node;
}

describe('Anthropic provider', () => {
  it('streams text, thinking and tool use, and sends tool results back as blocks', async () => {
    const requests: any[] = [];
    const sse = (res: http.ServerResponse, events: object[]) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const e of events) res.write(`event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`);
      res.end();
    };
    const url = await listen((req, body, res) => {
      if (req.url?.startsWith('/v1/models')) {
        expect(req.headers['x-api-key']).toBe('sk-ant-test');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'claude-test', display_name: 'Claude Test' }] }));
      }
      requests.push({ headers: req.headers, body });
      if (requests.length === 1) {
        return sse(res, [
          { type: 'message_start', message: { usage: { input_tokens: 12 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Look it up.' } },
          { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"tide"}' } },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
          { type: 'message_stop' },
        ]);
      }
      return sse(res, [
        { type: 'message_start', message: { usage: { input_tokens: 30 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A tide is the rise ' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'and fall of the sea.' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
        { type: 'message_stop' },
      ]);
    });
    f = await chatFixture({ orchestrator: { toolsFor: async () => lookupTool } });
    const node = await chatWith(f, { name: 'Anthropic', prefix: 'ant', type: 'anthropic', baseUrl: url, apiKey: 'sk-ant-test' }, 'ant/claude-test');

    expect(node.parts.map((p: any) => p.type)).toEqual(['reasoning', 'tool_call', 'tool_result', 'text']);
    expect(node.parts[1]).toMatchObject({ tool: 'lookup', args: '{"q":"tide"}' });
    expect(node.parts.at(-1).text).toBe('A tide is the rise and fall of the sea.');
    expect(node.usage).toMatchObject({ prompt_tokens: 42, completion_tokens: 16 });

    const [first, second] = requests;
    expect(first.headers['anthropic-version']).toBe('2023-06-01');
    expect(first.body).toMatchObject({ model: 'claude-test', stream: true, thinking: { type: 'enabled', budget_tokens: 2048 } });
    expect(first.body.max_tokens).toBeGreaterThan(2048);
    expect(first.body.tools[0]).toMatchObject({ name: 'lookup', input_schema: { type: 'object' } });
    expect(first.body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'What is a tide?' }] }]);
    expect(second.body.messages.slice(1)).toEqual([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'tide' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'tide: the rise and fall of the sea' }] },
    ]);
  });

  it('maps system prompts, images and merged turns', () => {
    const { system, messages } = toAnthropicMessages([
      { role: 'system', content: 'Be brief.' },
      { role: 'system', content: 'Use metric units.' },
      { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'user', content: 'And quickly.' },
    ]);
    expect(system).toBe('Be brief.\n\nUse metric units.');
    expect(messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'text', text: 'And quickly.' },
        ],
      },
    ]);
    const body = toAnthropicRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: 1.5, tool_choice: 'none' }, false);
    expect(body).toMatchObject({ temperature: 1, max_tokens: 8192 });
  });
});

describe('Ollama provider', () => {
  it('streams NDJSON with thinking and tool calls, and sends tool results by name', async () => {
    const requests: any[] = [];
    const url = await listen((req, body, res) => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ models: [{ name: 'llama3.2:latest', model: 'llama3.2:latest' }] }));
      }
      requests.push(body);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      if (requests.length === 1) {
        res.write(JSON.stringify({ message: { role: 'assistant', content: '', thinking: 'Need a lookup.' }, done: false }) + '\n');
        res.write(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'lookup', arguments: { q: 'tide' } } }] }, done: false }) + '\n');
        res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 4 }) + '\n');
        return;
      }
      res.write(JSON.stringify({ message: { role: 'assistant', content: 'The sea ' }, done: false }) + '\n');
      res.write(JSON.stringify({ message: { role: 'assistant', content: 'rises.' }, done: false }) + '\n');
      res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 20, eval_count: 3 }));
    });
    f = await chatFixture({ orchestrator: { toolsFor: async () => lookupTool } });
    const node = await chatWith(f, { name: 'Ollama', prefix: 'ol', type: 'ollama', baseUrl: url }, 'ol/llama3.2:latest');

    expect(node.parts.map((p: any) => p.type)).toEqual(['reasoning', 'tool_call', 'tool_result', 'text']);
    expect(node.parts.at(-1).text).toBe('The sea rises.');
    expect(node.usage).toMatchObject({ prompt_tokens: 30, completion_tokens: 7 });
    expect(requests[0]).toMatchObject({ model: 'llama3.2:latest', stream: true, think: true });
    expect(requests[0].tools[0].function.name).toBe('lookup');
    expect(requests[1].messages.slice(-2)).toEqual([
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'lookup', arguments: { q: 'tide' } } }] },
      { role: 'tool', content: 'tide: the rise and fall of the sea', tool_name: 'lookup' },
    ]);
  });

  it('sends images as base64', () => {
    expect(
      toOllamaMessages([{ role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }] }])
    ).toEqual([{ role: 'user', content: 'Look', images: ['QUJD'] }]);
  });
});

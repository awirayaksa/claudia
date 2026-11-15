/**
 * opencode Go connections end to end against a mock service: one session per
 * chat on every request, the client named in User-Agent (#68), and a
 * connection test that chats instead of trusting the public model list (#70).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';
import { chatFixture, type ChatFixture } from '../test/chat-fixture';
import { VERSION } from '../version';

let f: ChatFixture | undefined;
let server: http.Server | undefined;
afterEach(async () => {
  await f?.close();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  f = undefined;
  server = undefined;
});

interface Seen {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

/** A mock opencode Go: lists two models, answers chats, rejects keys other than `go-key`. */
async function mockGo(): Promise<{ url: string; chats: Seen[] }> {
  const chats: Seen[] = [];
  server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/v1/models') {
      // Public: no key needed
      return json(200, {
        object: 'list',
        data: [
          { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', type: 'chat', limit: { context: 262144 } },
          { id: 'glm-5.3', name: 'GLM-5.3', type: 'chat' },
        ],
      });
    }
    const body = raw ? JSON.parse(raw) : null;
    chats.push({ url: req.url ?? '', headers: req.headers, body });
    if (req.headers.authorization !== 'Bearer go-key') return json(401, { error: { message: 'Invalid API key.' } });
    if (!req.headers['x-opencode-session']) {
      return json(400, { error: { message: 'Request is missing x-opencode-session and cannot be routed efficiently.' } });
    }
    if (!body.stream) {
      return json(200, { id: 'c', object: 'chat.completion', created: 0, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'Tides' }, finish_reason: 'stop' }] });
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'The sea rises.' }, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, chats };
}

async function addConnection(fx: ChatFixture, url: string, apiKey: string): Promise<string> {
  const res = await fx.admin.post('/api/admin/connections', { name: 'Go', prefix: 'go', type: 'opencode-go', baseUrl: url, apiKey });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().connection.id;
}

async function send(fx: ChatFixture, chatId: string, content: string, parentId: string | null): Promise<string> {
  const start = await fx.admin.post(`/api/chats/${chatId}/completions`, { parentId, content, modelIds: ['go/kimi-k2.7-code'] });
  expect(start.statusCode, start.body).toBe(202);
  await fx.readRun(fx.admin, start.json().runId);
  return start.json().assistantMessageIds[0];
}

describe('opencode Go connection', () => {
  it('lists the service models and sends each chat with its own stable session', async () => {
    const go = await mockGo();
    f = await chatFixture();
    await addConnection(f, go.url, 'go-key');

    const models = (await f.admin.get('/api/models')).json().models.map((m: any) => m.id);
    expect(models).toEqual(expect.arrayContaining(['go/kimi-k2.7-code', 'go/glm-5.3']));

    const chatA = await f.newChat(f.admin);
    const first = await send(f, chatA, 'What is a tide?', null);
    await send(f, chatA, 'And a wave?', first);
    const chatB = await f.newChat(f.admin);
    await send(f, chatB, 'Hello', null);

    const sessions = (chats: Seen[]) => [...new Set(chats.map((c) => c.headers['x-opencode-session']))];
    const streamed = go.chats.filter((c) => c.body.stream);
    expect(streamed).toHaveLength(3);
    expect(streamed.map((c) => c.headers['x-opencode-session'])).toEqual([chatA, chatA, chatB]);
    // Title and follow-up requests stay in their chat's session too
    expect(go.chats.length).toBeGreaterThan(streamed.length);
    expect(sessions(go.chats).sort()).toEqual([chatA, chatB].sort());

    for (const c of go.chats) {
      expect(c.headers['user-agent']).toBe(`Claudia-Web/${VERSION}`);
      expect(JSON.stringify(c.body)).not.toContain(chatA);
    }
  });

  it('tests the connection with a chat, and fails on a bad key although the models list', async () => {
    const go = await mockGo();
    f = await chatFixture();
    const good = await addConnection(f, go.url, 'go-key');

    const ok = (await f.admin.post(`/api/admin/connections/${good}/test`, {})).json();
    expect(ok).toMatchObject({ ok: true, error: null });
    expect(go.chats.at(-1)).toMatchObject({ url: '/v1/chat/completions', body: { model: 'kimi-k2.7-code' } });
    expect(go.chats.at(-1)!.headers['x-opencode-session']).toBeTruthy();

    await f.admin.patch(`/api/admin/connections/${good}`, { apiKey: 'invalid-key' });
    const bad = (await f.admin.post(`/api/admin/connections/${good}/test`, {})).json();
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('Invalid API key.');
    // The model list stays available
    expect(bad.models).toEqual(['go/kimi-k2.7-code', 'go/glm-5.3']);
  });

  it('fails the test for an unreachable endpoint', async () => {
    f = await chatFixture();
    const id = await addConnection(f, 'http://127.0.0.1:1', 'go-key');
    const res = (await f.admin.post(`/api/admin/connections/${id}/test`, {})).json();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Network Error/);
  });
});

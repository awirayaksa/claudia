/**
 * Orchestrator end to end: HTTP → orchestrator → shared provider classes →
 * scripted OpenAI endpoint, with events read back over SSE.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { chatFixture, types, type ChatFixture } from '../test/chat-fixture';
import { messages, providerConnections, usageEvents } from '../db/schema';
import type { RunToolset } from './tools';

let f: ChatFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const send = (fx: ChatFixture, chatId: string, body: Record<string, unknown>) =>
  fx.admin.post(`/api/chats/${chatId}/completions`, { parentId: null, modelIds: ['mock/gpt-test'], ...body });

describe('completions', () => {
  it('streams a reply, stores the turn and names the chat', async () => {
    f = await chatFixture();
    f.mock.push({
      reasoning: ['think ', 'hard'],
      text: ['Hello', ', world'],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    });
    f.mock.completions.push({ content: '"Greeting the World."' });
    const chatId = await f.newChat(f.admin);

    const start = await send(f, chatId, { content: 'Say hello' });
    expect(start.statusCode).toBe(202);
    const { runId, userMessageId, assistantMessageIds } = start.json();

    const events = await f.readRun(f.admin, runId);
    expect(types(events)).toEqual([
      'run.started',
      'message.created',
      'message.created',
      'message.reasoning',
      'message.reasoning',
      'message.delta',
      'message.delta',
      'message.usage',
      'message.completed',
      'chat.updated',
      'message.followups',
      'run.completed',
    ]);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.find((e) => e.event.type === 'chat.updated')!.event).toMatchObject({ title: 'Greeting the World' });

    // The request the provider saw
    expect(f.mock.requests[0]).toMatchObject({
      model: 'gpt-test',
      stream: true,
      messages: [{ role: 'user', content: 'Say hello' }],
    });

    const chat = (await f.admin.get(`/api/chats/${chatId}`)).json().chat;
    expect(chat.title).toBe('Greeting the World');
    expect(chat.currentLeafId).toBe(assistantMessageIds[0]);
    expect(chat.activeRuns).toEqual([]);
    const assistant = chat.messages.find((m: any) => m.id === assistantMessageIds[0]);
    expect(assistant).toMatchObject({
      parentId: userMessageId,
      role: 'assistant',
      modelId: 'mock/gpt-test',
      status: 'completed',
      parts: [
        { type: 'reasoning', text: 'think hard' },
        { type: 'text', text: 'Hello, world' },
      ],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    });

    const usage = await f.db.db.select().from(usageEvents);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ modelId: 'mock/gpt-test', promptTokens: 7, completionTokens: 3, kind: 'chat' });
  });

  it('sends the earlier turns and the system prompts on the next message', async () => {
    f = await chatFixture();
    await f.admin.patch('/api/me/settings', { preferences: { systemPrompt: 'Be brief.', temperature: 0.2 } });
    f.mock.push({ text: ['First answer'] }, { text: ['Second answer'] });
    const chatId = await f.newChat(f.admin);

    const first = (await send(f, chatId, { content: 'One' })).json();
    await f.readRun(f.admin, first.runId);
    const second = (await send(f, chatId, { content: 'Two', parentId: first.assistantMessageIds[0] })).json();
    await f.readRun(f.admin, second.runId);

    const req = f.mock.requests.filter((r) => r.stream)[1];
    expect(req.temperature).toBe(0.2);
    expect(req.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'One' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Two' },
    ]);
    // The title is only generated once (the other calls are follow-up suggestions)
    const isTitle = (r: any) => r.messages[0].content.includes('title');
    expect(f.mock.requests.filter((r) => !r.stream && isTitle(r))).toHaveLength(1);
    expect(f.mock.requests.filter((r) => !r.stream && !isTitle(r))).toHaveLength(2);
  });

  it('stops a run on request, keeping the partial reply', async () => {
    f = await chatFixture();
    f.mock.push({ text: Array.from({ length: 50 }, (_, i) => `w${i} `), delayMs: 40 });
    const chatId = await f.newChat(f.admin);
    const { runId, assistantMessageIds } = (await send(f, chatId, { content: 'Long one' })).json();

    const partial = await f.readRun(f.admin, runId, 0, (e) => e.event.type === 'message.delta' && e.seq > 6);
    expect(partial.length).toBeGreaterThan(0);
    expect((await f.admin.post(`/api/runs/${runId}/stop`)).statusCode).toBe(200);

    const rest = await f.readRun(f.admin, runId, partial.at(-1)!.seq);
    const completed = rest.find((e) => e.event.type === 'message.completed')!.event as any;
    expect(completed.status).toBe('stopped');
    expect(rest.at(-1)!.event).toMatchObject({ type: 'run.completed', status: 'stopped' });

    const [row] = await f.db.db.select().from(messages).where(eq(messages.id, assistantMessageIds[0]));
    expect(row.status).toBe('stopped');
    const text = (row.parts[0] as any).text as string;
    expect(text.startsWith('w0 w1 ')).toBe(true);
    expect(text.split(' ').length).toBeLessThan(50);
  });

  it('lets a second tab resume a live run from any point', async () => {
    f = await chatFixture();
    f.mock.push({ text: ['a', 'b', 'c', 'd', 'e'], delayMs: 30 });
    const chatId = await f.newChat(f.admin);
    const { runId } = (await send(f, chatId, { content: 'Go' })).json();

    // Tab 2 opens the chat mid-run and sees the run to resume
    const detail = (await f.admin.get(`/api/chats/${chatId}`)).json().chat;
    expect(detail.activeRuns.map((r: any) => r.runId)).toEqual([runId]);

    const [tab1, tab2] = await Promise.all([f.readRun(f.admin, runId), f.readRun(f.admin, runId, 3)]);
    expect(tab2[0].seq).toBe(4);
    expect(tab2.map((e) => e.seq)).toEqual(tab1.slice(3).map((e) => e.seq));
    // Replaying a finished run works too
    expect(await f.readRun(f.admin, runId)).toEqual(tab1);
  });

  it('refuses a second send to the same branch point while a run is active', async () => {
    f = await chatFixture();
    f.mock.push({ text: ['x', 'y', 'z'], delayMs: 100 }, { text: ['ok'] });
    const chatId = await f.newChat(f.admin);
    const first = (await send(f, chatId, { content: 'One' })).json();
    const again = await send(f, chatId, { content: 'One again' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('run_in_progress');
    await f.readRun(f.admin, first.runId);
    // Free again afterwards
    expect((await send(f, chatId, { content: 'Retry', parentId: first.assistantMessageIds[0] })).statusCode).toBe(202);
  });

  it('records a provider error on the message', async () => {
    f = await chatFixture();
    f.mock.push({ fail: { status: 401, message: 'invalid api key' } });
    const chatId = await f.newChat(f.admin);
    const { runId, assistantMessageIds } = (await send(f, chatId, { content: 'Hi' })).json();
    const events = await f.readRun(f.admin, runId);
    expect(events.find((e) => e.event.type === 'message.completed')!.event).toMatchObject({
      status: 'error',
      error: 'invalid api key',
    });
    expect(events.at(-1)!.event).toMatchObject({ type: 'run.completed', status: 'error' });
    const [row] = await f.db.db.select().from(messages).where(eq(messages.id, assistantMessageIds[0]));
    expect(row).toMatchObject({ status: 'error', error: 'invalid api key' });
  });

  it('answers with every requested model as sibling replies', async () => {
    f = await chatFixture();
    f.mock.push({ text: ['from one'] }, { text: ['from two'] });
    const chatId = await f.newChat(f.admin);
    const res = await send(f, chatId, { content: 'Compare', modelIds: ['mock/gpt-test', 'mock/gpt-other'] });
    const { runId, userMessageId, assistantMessageIds } = res.json();
    await f.readRun(f.admin, runId);
    const chat = (await f.admin.get(`/api/chats/${chatId}`)).json().chat;
    const replies = chat.messages.filter((m: any) => m.parentId === userMessageId);
    expect(replies.map((m: any) => m.id).sort()).toEqual([...assistantMessageIds].sort());
    expect(replies.map((m: any) => m.modelId).sort()).toEqual(['mock/gpt-other', 'mock/gpt-test']);
  });

  it('runs the tool loop and re-offers tools each round', async () => {
    const toolset: RunToolset = {
      definitions: [{ type: 'function', function: { name: 'lookup', description: 'Look up', parameters: { type: 'object', properties: {} } } }],
      firstTurnOnly: false,
      locate: (alias) => (alias === 'lookup' ? { serverId: 'srv-1', tool: 'lookup' } : null),
      execute: async (call) => ({
        serverId: 'srv-1',
        tool: 'lookup',
        result: { type: 'tool_result', callId: call.id, content: `result for ${call.function.arguments}` },
      }),
    };
    f = await chatFixture({ orchestrator: { toolsFor: async () => toolset } });
    f.mock.push(
      { text: ['Checking.'], toolCalls: [{ id: 'call_1', name: 'lookup', arguments: '{"q":"a"}' }] },
      { text: ['Found it.'] }
    );
    const chatId = await f.newChat(f.admin);
    const { runId, assistantMessageIds } = (await send(f, chatId, { content: 'Find a' })).json();
    const events = await f.readRun(f.admin, runId);
    expect(types(events)).toContain('message.tool_call');
    expect(types(events)).toContain('tool.result');

    const [first, second] = f.mock.requests.filter((r) => r.stream);
    expect(first.tools.map((t: any) => t.function.name)).toEqual(['lookup']);
    expect(second.tools).toHaveLength(1);
    expect(second.messages.slice(-2)).toEqual([
      { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"a"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'result for {"q":"a"}' },
    ]);

    const [row] = await f.db.db.select().from(messages).where(eq(messages.id, assistantMessageIds[0]));
    expect(row.parts.map((p) => p.type)).toEqual(['text', 'tool_call', 'tool_result', 'text']);
    expect(row.parts[1]).toMatchObject({ serverId: 'srv-1', tool: 'lookup', alias: 'lookup' });
  });

  it('enforces the per-user completion rate limit', async () => {
    f = await chatFixture();
    await f.admin.patch('/api/admin/settings/limits', { completionsPerMinute: 2, concurrentRuns: 5, maxToolIterations: 10 });
    const chatId = await f.newChat(f.admin);
    const codes: number[] = [];
    let parent: string | null = null;
    for (let i = 0; i < 3; i++) {
      f.mock.push({ text: ['ok'] });
      const res = await send(f, chatId, { content: `m${i}`, parentId: parent });
      codes.push(res.statusCode);
      if (res.statusCode === 202) {
        await f.readRun(f.admin, res.json().runId);
        parent = res.json().assistantMessageIds[0];
      }
    }
    expect(codes).toEqual([202, 202, 429]);
  });
});

describe('isolation between users', () => {
  it("never shows or touches another user's chats, folders or runs", async () => {
    f = await chatFixture();
    f.mock.push({ text: ['secret answer'], delayMs: 50 });
    const chatId = await f.newChat(f.admin);
    const folder = (await f.admin.post('/api/folders', { name: 'Private' })).json().folder;
    const { runId } = (await send(f, chatId, { content: 'secret question' })).json();

    const { TestClient } = await import('../test/client');
    const other = new TestClient(f.app);
    await other.signup('mallory@example.com');
    await f.admin.patch('/api/admin/settings/auth.signup', { enabled: true, defaultRole: 'user' });
    const users = (await f.admin.get('/api/admin/users')).json().users;
    await f.admin.patch(`/api/admin/users/${users.find((u: any) => u.email === 'mallory@example.com').id}`, { role: 'user' });

    expect((await other.get('/api/chats')).json().chats).toEqual([]);
    expect((await other.get(`/api/chats/${chatId}`)).statusCode).toBe(404);
    expect((await other.patch(`/api/chats/${chatId}`, { title: 'pwned' })).statusCode).toBe(404);
    expect((await other.delete(`/api/chats/${chatId}`)).statusCode).toBe(404);
    expect(
      (await other.post(`/api/chats/${chatId}/completions`, { parentId: null, content: 'x', modelIds: ['mock/gpt-test'] })).statusCode
    ).toBe(404);
    expect((await other.get(`/api/runs/${runId}/events`)).statusCode).toBe(404);
    expect((await other.post(`/api/runs/${runId}/stop`)).statusCode).toBe(404);
    expect((await other.get('/api/folders')).json().folders).toEqual([]);
    expect((await other.patch(`/api/folders/${folder.id}`, { name: 'x' })).statusCode).toBe(404);
    expect((await other.post('/api/chats', { folderId: folder.id })).statusCode).toBe(404);
    expect((await other.get('/api/admin/connections')).statusCode).toBe(403);

    await f.readRun(f.admin, runId);
    expect((await f.admin.get(`/api/chats/${chatId}`)).json().chat.title).not.toBe('pwned');
  });
});

describe('models and connections', () => {
  it('never returns an API key, and stores it encrypted', async () => {
    f = await chatFixture();
    const list = await f.admin.get('/api/admin/connections');
    expect(list.body).not.toContain('sk-mock-secret-key-1234');
    expect(list.json().connections[0]).toMatchObject({ hasKey: true, keyLast4: '1234', prefix: 'mock', modelCount: 2 });
    const [row] = await f.db.db.select().from(providerConnections);
    expect(row.keyCipher).toMatch(/^v1:[0-9a-f]{8}:/);
    expect(row.keyCipher).not.toContain('sk-mock');
    // Nor through any other route
    for (const url of ['/api/models', '/api/auth/session', '/api/me', '/api/admin/settings']) {
      expect((await f.admin.get(url)).body).not.toContain('sk-mock-secret-key-1234');
    }
  });

  it('filters models by the role allowlist and refuses others', async () => {
    f = await chatFixture();
    await f.admin.patch('/api/admin/settings/auth.signup', { enabled: true, defaultRole: 'user' });
    const { TestClient } = await import('../test/client');
    const user = new TestClient(f.app);
    await user.signup('u@example.com');
    expect((await user.get('/api/models')).json().models.map((m: any) => m.id)).toEqual(['mock/gpt-test', 'mock/gpt-other']);

    await f.admin.patch('/api/admin/settings/models.allowlist', { user: ['mock/gpt-other'] });
    const after = (await user.get('/api/models')).json();
    expect(after.models.map((m: any) => m.id)).toEqual(['mock/gpt-other']);
    expect(after.defaultModel).toBe('mock/gpt-other');

    const chatId = (await user.post('/api/chats', {})).json().chat.id;
    const denied = await user.post(`/api/chats/${chatId}/completions`, { parentId: null, content: 'x', modelIds: ['mock/gpt-test'] });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('model_not_allowed');
    // Admins still see everything
    expect((await f.admin.get('/api/models')).json().models).toHaveLength(2);
  });
});

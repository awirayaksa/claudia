/**
 * The conversation log: off by default; when on, a copy of each prompt and
 * reply from chats, the OpenAI-compatible API and channel mentions, which
 * outlives the chat, is admin-only, and whose reading is itself audited.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { chatFixture, type ChatFixture } from '../test/chat-fixture';
import { newInput } from '../modules/openai/routes';

let f: ChatFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const ON = { enabled: true, retentionDays: 30, chats: true, api: true, channels: true };

describe('conversation log', () => {
  it('records nothing while it is off (the default)', async () => {
    f = await chatFixture();
    expect((await f.admin.get('/api/admin/settings')).json().settings['audit.conversations'].enabled).toBe(false);
    f.mock.push({ text: ['Hi'] });
    const chatId = await f.newChat(f.admin);
    const { runId } = (await f.admin.post(`/api/chats/${chatId}/completions`, { parentId: null, content: 'Hello', modelIds: ['mock/gpt-test'] })).json();
    await f.readRun(f.admin, runId);
    expect(await f.app.ctx.conversations.count()).toBe(0);
  });

  it('keeps chat turns after the chat is deleted, for admins only, and audits who read them', async () => {
    f = await chatFixture();
    expect((await f.admin.patch('/api/admin/settings/audit.conversations', ON)).statusCode).toBe(200);
    const kim = await f.newUser('kim@example.com');

    f.mock.push({ text: ['Paris ', 'is the capital.'], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } });
    const chatId = await f.newChat(kim);
    const { runId } = (await kim.post(`/api/chats/${chatId}/completions`, { parentId: null, content: 'What is the capital of France?', modelIds: ['mock/gpt-test'] })).json();
    await f.readRun(kim, runId);
    // Users can delete their chat; the record stays
    expect((await kim.delete(`/api/chats/${chatId}`)).statusCode).toBe(200);

    const page = (await f.admin.get('/api/admin/conversations')).json();
    expect(page.turns).toHaveLength(1);
    const [turn] = page.turns;
    expect(turn).toMatchObject({
      source: 'chat',
      userEmail: 'kim@example.com',
      modelId: 'mock/gpt-test',
      chatId,
      promptPreview: 'What is the capital of France?',
      replyPreview: 'Paris is the capital.',
      status: 'completed',
      promptTokens: 12,
      completionTokens: 4,
    });

    // Users, even the one who wrote it, can't read the log
    expect((await kim.get('/api/admin/conversations')).statusCode).toBe(403);
    expect((await kim.get(`/api/admin/conversations/${turn.id}`)).statusCode).toBe(403);

    const full = (await f.admin.get(`/api/admin/conversations/${turn.id}`)).json().turn;
    expect(full).toMatchObject({ prompt: 'What is the capital of France?', reply: 'Paris is the capital.' });
    expect((await f.admin.get('/api/admin/conversations/00000000-0000-7000-8000-000000000000')).statusCode).toBe(404);

    // Filters
    expect((await f.admin.get('/api/admin/conversations?user=KIM')).json().turns).toHaveLength(1);
    expect((await f.admin.get('/api/admin/conversations?user=nobody')).json().turns).toHaveLength(0);
    expect((await f.admin.get('/api/admin/conversations?q=capital%20of')).json().turns).toHaveLength(1);
    expect((await f.admin.get('/api/admin/conversations?q=berlin')).json().turns).toHaveLength(0);
    expect((await f.admin.get('/api/admin/conversations?source=api')).json().turns).toHaveLength(0);

    const csv = await f.admin.get('/api/admin/conversations/export.csv');
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\r\n')[0]).toBe(
      'time,user,source,model,chat_id,chat_title,status,prompt_tokens,completion_tokens,prompt,reply,error,details'
    );
    expect(csv.body).toContain('Paris is the capital.');

    // Reading and exporting are in the audit log
    await vi.waitFor(async () => {
      const actions = (await f!.admin.get('/api/admin/audit?action=conversations.*')).json().entries.map((e: any) => e.action);
      expect(actions.sort()).toEqual(['conversations.exported', 'conversations.viewed']);
    });
  });

  it('records the API and channel mentions, each switchable', async () => {
    f = await chatFixture();
    await f.admin.patch('/api/admin/settings/audit.conversations', { ...ON, channels: false });
    const key = (await f.admin.post('/api/me/api-keys', { name: 'sdk' })).json().secret;
    const client = new OpenAI({ baseURL: `${f.base}/api/v1`, apiKey: key, maxRetries: 0 });

    f.mock.push({ text: ['Four'] });
    await client.chat.completions.create({ model: 'mock/gpt-test', messages: [{ role: 'user', content: '2+2?' }] });
    f.mock.push({ text: ['Fi', 've'] });
    const stream = await client.chat.completions.create({
      model: 'mock/gpt-test',
      messages: [
        { role: 'user', content: '2+2?' },
        { role: 'assistant', content: 'Four' },
        { role: 'user', content: 'And 2+3?' },
      ],
      stream: true,
    });
    for await (const _ of stream) void _;

    // A channel mention, while channels are switched off
    const channel = (await f.admin.post('/api/channels', { name: 'general' })).json().channel;
    f.mock.push({ text: ['Hello!'] });
    await f.admin.post(`/api/channels/${channel.id}/messages`, { content: '@mock/gpt-test hi' });
    await vi.waitFor(async () => {
      const list = (await f!.admin.get(`/api/channels/${channel.id}/messages`)).json().messages;
      expect(list.at(-1)).toMatchObject({ status: 'done' });
    });

    await vi.waitFor(async () => expect(await f!.app.ctx.conversations.count()).toBe(2));
    const api = (await f.admin.get('/api/admin/conversations?source=api')).json().turns;
    expect(api.map((t: any) => [t.promptPreview, t.replyPreview])).toEqual([
      ['And 2+3?', 'Five'],
      ['2+2?', 'Four'],
    ]);

    // Channels on again
    await f.admin.patch('/api/admin/settings/audit.conversations', ON);
    f.mock.push({ text: ['Hi again'] });
    await f.admin.post(`/api/channels/${channel.id}/messages`, { content: '@mock/gpt-test again' });
    await vi.waitFor(async () => {
      const turns = (await f!.admin.get('/api/admin/conversations?source=channel')).json().turns;
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({ promptPreview: '@mock/gpt-test again', replyPreview: 'Hi again', chatTitle: '#general', chatId: channel.id });
    });
  });

  it('removes turns past the retention period', async () => {
    f = await chatFixture();
    await f.admin.patch('/api/admin/settings/audit.conversations', ON);
    f.mock.push({ text: ['Hi'] });
    const chatId = await f.newChat(f.admin);
    const { runId } = (await f.admin.post(`/api/chats/${chatId}/completions`, { parentId: null, content: 'Hello', modelIds: ['mock/gpt-test'] })).json();
    await f.readRun(f.admin, runId);
    const log = f.app.ctx.conversations;
    expect(await log.count()).toBe(1);
    expect(await log.purge(new Date(Date.now() + 29 * 86_400_000))).toBe(0);
    expect(await log.purge(new Date(Date.now() + 31 * 86_400_000))).toBe(1);
  });

  it('logs what the API caller added this turn', () => {
    expect(newInput([{ role: 'system', content: 'Be short.' }, { role: 'user', content: 'Hi' }])).toBe('Hi');
    expect(
      newInput([
        { role: 'user', content: 'Weather?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
        { role: 'tool', tool_call_id: 'c1', content: 'Sunny' },
      ])
    ).toBe('[tool result c1]\nSunny');
    expect(newInput([{ role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: {} }] }])).toBe('Look\n[image_url]');
  });
});

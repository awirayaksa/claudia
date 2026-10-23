/**
 * Searching past chats as tools: the model finds the right earlier chat,
 * cites it as a source, and never sees other users' or temporary chats.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { chatFixture, type ChatFixture } from '../../test/chat-fixture';
import type { TestClient } from '../../test/client';

let f: ChatFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

async function chatAbout(fx: ChatFixture, c: TestClient, title: string, question: string, answer: string, extra: Record<string, unknown> = {}) {
  const id = (await c.post('/api/chats', { title, ...extra })).json().chat.id;
  fx.mock.push({ text: [answer] });
  const res = await c.post(`/api/chats/${id}/completions`, { parentId: null, modelIds: ['mock/gpt-test'], content: question });
  await fx.readRun(c, res.json().runId);
  return id as string;
}

const call = (name: string, args: object) => ({ toolCalls: [{ id: 'call_1', name, arguments: JSON.stringify(args) }] });

describe('past chats as a tool', () => {
  it('finds and cites the right earlier chat, and only the user’s own', async () => {
    f = await chatFixture();
    const fx = f;
    await fx.admin.patch('/api/admin/settings/tasks', { generateTitles: false, generateFollowUps: false, titleModel: null });
    const bob = await fx.newUser('bob@example.com');
    const api = await chatAbout(fx, fx.admin, 'API design', 'Should the API paginate with cursors or offsets?', 'We decided on cursor pagination with a limit of 100.');
    await chatAbout(fx, fx.admin, 'Dinner', 'Ideas for dinner?', 'Try a mushroom risotto.');
    await chatAbout(fx, bob, 'Bob API notes', 'Our API pagination uses offsets', 'Offsets are fine.');
    const temp = (await fx.admin.post('/api/chats', { temporary: true })).json().chat.id;
    fx.mock.push({ text: ['ok'] });
    await fx.readRun(fx.admin, (await fx.admin.post(`/api/chats/${temp}/completions`, { parentId: null, modelIds: ['mock/gpt-test'], content: 'secret pagination plan' })).json().runId);

    // Not offered unless asked for
    await chatAbout(fx, fx.admin, 'Plain', 'Hello', 'Hi');
    expect((fx.mock.requests.filter((r) => r.stream).at(-1).tools ?? []).some((t: any) => t.function.name === 'conversation_search')).toBe(false);

    const now = (await fx.admin.post('/api/chats', {})).json().chat.id;
    fx.mock.push(call('conversation_search', { query: 'API pagination decision' }), { text: ['You chose cursor pagination [1].'] });
    const res = await fx.admin.post(`/api/chats/${now}/completions`, {
      parentId: null,
      modelIds: ['mock/gpt-test'],
      content: 'What did we decide about API pagination?',
      features: { pastChats: true },
    });
    const events = await fx.readRun(fx.admin, res.json().runId);
    const result = JSON.parse((events.find((e) => e.event.type === 'tool.result')!.event as any).part.content);
    expect(result.chats[0]).toMatchObject({ cite: 1, title: 'API design' });
    expect(JSON.stringify(result.chats[0].snippets)).toContain('cursor');
    const titles = result.chats.map((c: any) => c.title);
    expect(titles).not.toContain('Bob API notes');
    expect(JSON.stringify(result)).not.toContain('secret pagination');
    // Cited as a source that opens the chat
    const cites = (events.filter((e) => e.event.type === 'message.citations').at(-1)!.event as any).citations;
    expect(cites[0]).toMatchObject({ index: 1, source: { kind: 'chat', id: api, title: 'API design' } });

    // Recent chats, newest first, without the current one
    fx.mock.push(call('recent_chats', { n: 2 }), { text: ['Those.'] });
    const res2 = await fx.admin.post(`/api/chats/${now}/completions`, {
      parentId: res.json().assistantMessageIds[0],
      modelIds: ['mock/gpt-test'],
      content: 'And what else did we talk about lately?',
      features: { pastChats: true },
    });
    const events2 = await fx.readRun(fx.admin, res2.json().runId);
    const recent = JSON.parse((events2.find((e) => e.event.type === 'tool.result')!.event as any).part.content);
    expect(recent.chats.map((c: any) => c.title)).toEqual(['Plain', 'Dinner']);
    // Numbered after the sources the reply already has
    expect(recent.chats[0].cite).toBe(1);
  });

  it('stays inside the folder of the chat', async () => {
    f = await chatFixture();
    const fx = f;
    await fx.admin.patch('/api/admin/settings/tasks', { generateTitles: false, generateFollowUps: false, titleModel: null });
    const folder = (await fx.admin.post('/api/folders', { name: 'Thesis' })).json().folder;
    await chatAbout(fx, fx.admin, 'Reef notes', 'Coral bleaching data', 'Bleaching rose 30%.', { folderId: folder.id });
    await chatAbout(fx, fx.admin, 'Holiday', 'Coral reefs to snorkel', 'Try the Red Sea.');
    const inFolder = (await fx.admin.post('/api/chats', { folderId: folder.id })).json().chat.id;
    fx.mock.push(call('conversation_search', { query: 'coral' }), { text: ['Found it.'] });
    const res = await fx.admin.post(`/api/chats/${inFolder}/completions`, { parentId: null, modelIds: ['mock/gpt-test'], content: 'coral?', features: { pastChats: true } });
    const events = await fx.readRun(fx.admin, res.json().runId);
    const result = JSON.parse((events.find((e) => e.event.type === 'tool.result')!.event as any).part.content);
    expect(result.chats.map((c: any) => c.title)).toEqual(['Reef notes']);
  });
});

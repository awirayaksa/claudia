/**
 * Phase 2 on the server: versions (regenerate, edit, switch), multi-model,
 * ratings, forks, per-chat parameters, search, tags, archive, temporary
 * chats, share links, and export → import.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { chatFixture, type ChatFixture } from '../../test/chat-fixture';
import { TestClient } from '../../test/client';
import { chats, messages } from '../../db/schema';
import { ChatRepo, TEMPORARY_CHAT_TTL_MS, toPrefixQuery } from './repo';
import { orderTree } from './transfer';
import { parseFollowUps } from '../../llm/tasks';
import { SNIPPET_MARK_END, SNIPPET_MARK_START, type ClaudiaExport } from '../../../shared/chats';

let f: ChatFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

type Client = ChatFixture['admin'];

async function setup() {
  f = await chatFixture();
  return f;
}

/** Send a message and wait for the run to finish. */
async function say(fx: ChatFixture, client: Client, chatId: string, body: Record<string, unknown>) {
  const res = await client.post(`/api/chats/${chatId}/completions`, { parentId: null, modelIds: ['mock/gpt-test'], ...body });
  if (res.statusCode !== 202) throw new Error(`send: ${res.statusCode} ${res.body}`);
  const out = res.json();
  await fx.readRun(client, out.runId);
  return out as { runId: string; userMessageId: string; assistantMessageIds: string[] };
}

const getChat = async (client: Client, id: string) => (await client.get(`/api/chats/${id}`)).json().chat;
const textOf = (node: any) => node.parts.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('');

describe('versions', () => {
  it('regenerates as a sibling, keeping the skill and effort of the turn', async () => {
    const fx = await setup();
    await fx.admin.post('/api/skills', { id: 'pirate', name: 'Pirate', description: 'Talk like a pirate', body: 'PIRATE-MARKER {{args}}' });
    fx.mock.push({ text: ['Arr one'] }, { text: ['Arr two'] });
    const chatId = await fx.newChat(fx.admin);
    const first = await say(fx, fx.admin, chatId, {
      content: 'hello',
      skill: { id: 'pirate', args: 'hello' },
      params: { effort: 'high' },
    });

    const again = await say(fx, fx.admin, chatId, { parentId: first.userMessageId, regenerate: true });
    expect(again.userMessageId).toBe(first.userMessageId);

    const chat = await getChat(fx.admin, chatId);
    const replies = chat.messages.filter((m: any) => m.parentId === first.userMessageId);
    expect(replies.map(textOf)).toEqual(['Arr one', 'Arr two']);
    // Only one user node; the leaf is the new reply
    expect(chat.messages.filter((m: any) => m.role === 'user')).toHaveLength(1);
    expect(chat.currentLeafId).toBe(again.assistantMessageIds[0]);

    const streamed = fx.mock.requests.filter((r) => r.stream);
    expect(streamed[1].messages).toEqual(streamed[0].messages);
    expect(streamed[1].messages.some((m: any) => m.role === 'system' && m.content.includes('PIRATE-MARKER'))).toBe(true);
    expect(streamed[1].reasoning_effort).toBe('high');
  });

  it('refuses to regenerate an assistant node', async () => {
    const fx = await setup();
    fx.mock.push({ text: ['a'] });
    const chatId = await fx.newChat(fx.admin);
    const first = await say(fx, fx.admin, chatId, { content: 'x' });
    const res = await fx.admin.post(`/api/chats/${chatId}/completions`, {
      parentId: first.assistantMessageIds[0],
      regenerate: true,
      modelIds: ['mock/gpt-test'],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_parent');
  });

  it('edits a message as a sibling and switches between versions', async () => {
    const fx = await setup();
    fx.mock.push({ text: ['A1'] }, { text: ['A2'] }, { text: ['B1'] });
    const chatId = await fx.newChat(fx.admin);
    const one = await say(fx, fx.admin, chatId, { content: 'first' });
    const two = await say(fx, fx.admin, chatId, { content: 'second', parentId: one.assistantMessageIds[0] });
    // Edit "second": same parent as the original
    const edited = await say(fx, fx.admin, chatId, { content: 'second, edited', parentId: one.assistantMessageIds[0] });

    let chat = await getChat(fx.admin, chatId);
    const userSiblings = chat.messages.filter((m: any) => m.parentId === one.assistantMessageIds[0]);
    expect(userSiblings.map(textOf)).toEqual(['second', 'second, edited']);
    expect(chat.currentLeafId).toBe(edited.assistantMessageIds[0]);

    // The edited branch's history is the shared prefix only
    expect(fx.mock.requests.filter((r) => r.stream)[2].messages.map((m: any) => m.content)).toEqual([
      'first',
      'A1',
      'second, edited',
    ]);

    const before = chat.updatedAt;
    const back = await fx.admin.patch(`/api/chats/${chatId}`, { currentLeafId: two.assistantMessageIds[0] });
    expect(back.statusCode).toBe(200);
    chat = await getChat(fx.admin, chatId);
    expect(chat.currentLeafId).toBe(two.assistantMessageIds[0]);
    // Switching versions doesn't move the chat up the list
    expect(chat.updatedAt).toBe(before);
  });

  it('answers with several models as siblings and records which were asked', async () => {
    const fx = await setup();
    fx.mock.push({ text: ['from test'] }, { text: ['from other'] });
    const chatId = await fx.newChat(fx.admin);
    const res = await say(fx, fx.admin, chatId, { content: 'compare', modelIds: ['mock/gpt-test', 'mock/gpt-other'] });
    expect(res.assistantMessageIds).toHaveLength(2);

    const chat = await getChat(fx.admin, chatId);
    const user = chat.messages.find((m: any) => m.id === res.userMessageId);
    expect(user.models).toEqual(['mock/gpt-test', 'mock/gpt-other']);
    const replies = chat.messages.filter((m: any) => m.parentId === res.userMessageId);
    expect(replies.map((m: any) => m.modelId).sort()).toEqual(['mock/gpt-other', 'mock/gpt-test']);
    expect(chat.modelIds).toEqual(['mock/gpt-test', 'mock/gpt-other']);

    // Answering one column again keeps the chat's models
    fx.mock.push({ text: ['other again'] });
    await say(fx, fx.admin, chatId, { parentId: res.userMessageId, regenerate: true, modelIds: ['mock/gpt-other'] });
    const after = await getChat(fx.admin, chatId);
    expect(after.modelIds).toEqual(['mock/gpt-test', 'mock/gpt-other']);
    expect(after.messages.filter((m: any) => m.parentId === res.userMessageId && m.modelId === 'mock/gpt-other')).toHaveLength(2);
  });

  it('suggests follow-up questions under the reply', async () => {
    const fx = await setup();
    fx.mock.push({ text: ['Paris is the capital.'] });
    fx.mock.completions.push({ content: 'Title' }, { content: '["How big is Paris?", "What to see there?"]' });
    const chatId = await fx.newChat(fx.admin);
    const res = await say(fx, fx.admin, chatId, { content: 'Capital of France?' });
    const chat = await getChat(fx.admin, chatId);
    expect(chat.messages.find((m: any) => m.id === res.assistantMessageIds[0]).followUps).toEqual([
      'How big is Paris?',
      'What to see there?',
    ]);

    // The admin can turn them off
    await fx.admin.patch('/api/admin/settings/tasks', { generateTitles: true, generateFollowUps: false, titleModel: null });
    fx.mock.push({ text: ['More.'] });
    const before = fx.mock.requests.length;
    await say(fx, fx.admin, chatId, { content: 'Tell me more', parentId: res.assistantMessageIds[0] });
    expect(fx.mock.requests.slice(before).filter((r) => !r.stream)).toHaveLength(0);
  });
});

describe('feedback and forks', () => {
  it('rates a reply, with a comment, and clears it', async () => {
    const fx = await setup();
    fx.mock.push({ text: ['meh'] });
    const chatId = await fx.newChat(fx.admin);
    const res = await say(fx, fx.admin, chatId, { content: 'q' });
    const url = `/api/chats/${chatId}/messages/${res.assistantMessageIds[0]}/feedback`;

    expect((await fx.admin.put(url, { rating: -1, comment: 'Too vague', reasons: ['inaccurate'] })).statusCode).toBe(200);
    let node = (await getChat(fx.admin, chatId)).messages.find((m: any) => m.id === res.assistantMessageIds[0]);
    expect(node).toMatchObject({ rating: -1, feedback: { comment: 'Too vague', reasons: ['inaccurate'] } });

    await fx.admin.put(url, { rating: null });
    node = (await getChat(fx.admin, chatId)).messages.find((m: any) => m.id === res.assistantMessageIds[0]);
    expect(node.rating).toBeUndefined();
    expect(node.feedback).toBeUndefined();

    // Only replies can be rated, and only in your own chats
    expect((await fx.admin.put(`/api/chats/${chatId}/messages/${res.userMessageId}/feedback`, { rating: 1 })).statusCode).toBe(404);
    const other = await fx.newUser('other@example.com');
    expect((await other.put(url, { rating: 1 })).statusCode).toBe(404);
  });

  it('forks the path up to a message into a new chat', async () => {
    const fx = await setup();
    fx.mock.push({ text: ['A1'] }, { text: ['A2'] });
    const chatId = await fx.newChat(fx.admin);
    const one = await say(fx, fx.admin, chatId, { content: 'one' });
    await say(fx, fx.admin, chatId, { content: 'two', parentId: one.assistantMessageIds[0] });
    await fx.admin.put(`/api/chats/${chatId}/messages/${one.assistantMessageIds[0]}/feedback`, { rating: 1 });

    const res = await fx.admin.post(`/api/chats/${chatId}/fork`, { messageId: one.assistantMessageIds[0] });
    expect(res.statusCode).toBe(201);
    const fork = await getChat(fx.admin, res.json().chat.id);
    expect(fork.title).toMatch(/\(fork\)$/);
    expect(fork.messages.map(textOf)).toEqual(['one', 'A1']);
    expect(fork.messages.every((m: any) => m.id !== one.userMessageId && m.id !== one.assistantMessageIds[0])).toBe(true);
    expect(fork.currentLeafId).toBe(fork.messages[1].id);
    expect(fork.messages[1].parentId).toBe(fork.messages[0].id);
    expect(fork.messages[1].rating).toBeUndefined();
    // The original is untouched
    expect((await getChat(fx.admin, chatId)).messages).toHaveLength(4);
  });
});

describe('per-chat parameters', () => {
  it('sends the chat parameters and system prompt, and null clears one', async () => {
    const fx = await setup();
    fx.mock.push({ text: ['a'] }, { text: ['b'] });
    const chatId = await fx.newChat(fx.admin);
    const patch = await fx.admin.patch(`/api/chats/${chatId}`, {
      params: { temperature: 0.4, topP: 0.9, maxTokens: 256, presencePenalty: 0.5, systemPrompt: 'CHAT-PROMPT' },
    });
    expect(patch.statusCode).toBe(200);
    const one = await say(fx, fx.admin, chatId, { content: 'x' });
    const req = fx.mock.requests.filter((r) => r.stream)[0];
    expect(req).toMatchObject({ temperature: 0.4, top_p: 0.9, max_tokens: 256, presence_penalty: 0.5 });
    expect(req.messages[0]).toEqual({ role: 'system', content: 'CHAT-PROMPT' });

    await fx.admin.patch(`/api/chats/${chatId}`, { params: { topP: null, systemPrompt: null } });
    expect((await getChat(fx.admin, chatId)).params).toEqual({ temperature: 0.4, maxTokens: 256, presencePenalty: 0.5 });
    await say(fx, fx.admin, chatId, { content: 'y', parentId: one.assistantMessageIds[0] });
    const second = fx.mock.requests.filter((r) => r.stream)[1];
    expect(second.top_p).toBeUndefined();
    expect(second.messages[0].role).toBe('user');

    expect((await fx.admin.patch(`/api/chats/${chatId}`, { params: { temperature: 5 } })).statusCode).toBe(400);
  });
});

describe('search, tags and archive', () => {
  it('finds text inside messages, with a snippet, only in your own chats', async () => {
    const fx = await setup();
    fx.mock.push({ text: ['The answer mentions a zeppelin over Lisbon.'] }, { text: ['ok'] }, { text: ['ok'] });
    const a = await fx.newChat(fx.admin);
    await say(fx, fx.admin, a, { content: 'Tell me a story' });
    const b = await fx.newChat(fx.admin);
    await say(fx, fx.admin, b, { content: 'Something about gardening' });
    const other = await fx.newUser('other@example.com');
    const c = await fx.newChat(other);
    await say(fx, other, c, { content: 'zeppelin facts' });

    const hits = (await fx.admin.get('/api/chats?search=zeppel')).json().chats;
    expect(hits.map((h: any) => h.id)).toEqual([a]);
    expect(hits[0].match.snippet).toContain(`${SNIPPET_MARK_START}zeppelin${SNIPPET_MARK_END}`);
    // Every word must match
    expect((await fx.admin.get('/api/chats?search=zeppelin%20paris')).json().chats).toEqual([]);
    expect((await fx.admin.get('/api/chats?search=lisbon%20zeppelin')).json().chats).toHaveLength(1);
    // Titles still match ("Mock Title" from the mock)
    expect((await fx.admin.get('/api/chats?search=mock')).json().chats).toHaveLength(2);
    // Odd input is just text
    expect((await fx.admin.get(`/api/chats?search=${encodeURIComponent("'):* & |!")}`)).statusCode).toBe(200);
    expect(toPrefixQuery("it's o'clock")).toBe("'it':* & 's':* & 'o':* & 'clock':*");
  });

  it('tags chats, filters by tag and lists tags', async () => {
    const fx = await setup();
    const a = await fx.newChat(fx.admin);
    const b = await fx.newChat(fx.admin);
    expect((await fx.admin.patch(`/api/chats/${a}`, { tags: ['Work', 'urgent'] })).statusCode).toBe(200);
    await fx.admin.patch(`/api/chats/${b}`, { tags: ['work'] });

    expect((await getChat(fx.admin, a)).tags).toEqual(['work', 'urgent']);
    expect((await fx.admin.get('/api/chats?tag=urgent')).json().chats.map((c: any) => c.id)).toEqual([a]);
    expect((await fx.admin.get('/api/chats/tags')).json().tags).toEqual([
      { tag: 'urgent', count: 1 },
      { tag: 'work', count: 2 },
    ]);
    expect((await fx.admin.patch(`/api/chats/${a}`, { tags: ['two words'] })).statusCode).toBe(400);
  });

  it('lists archived chats separately', async () => {
    const fx = await setup();
    const a = await fx.newChat(fx.admin);
    const b = await fx.newChat(fx.admin);
    await fx.admin.patch(`/api/chats/${a}`, { archived: true });
    expect((await fx.admin.get('/api/chats')).json().chats.map((c: any) => c.id)).toEqual([b]);
    expect((await fx.admin.get('/api/chats?archived=true')).json().chats.map((c: any) => c.id)).toEqual([a]);
  });
});

describe('temporary chats', () => {
  it('are not listed or titled, can be kept, and go after a day', async () => {
    const fx = await setup();
    fx.mock.push({ text: ['hi'] });
    const res = await fx.admin.post('/api/chats', { temporary: true });
    const tempId = res.json().chat.id;
    expect(res.json().chat.temporary).toBe(true);
    await say(fx, fx.admin, tempId, { content: 'secret thing' });

    expect((await fx.admin.get('/api/chats')).json().chats).toEqual([]);
    expect((await fx.admin.get('/api/chats?search=secret')).json().chats).toEqual([]);
    expect(fx.mock.requests.filter((r) => !r.stream && r.messages[0].content.includes('title'))).toHaveLength(0);
    expect((await getChat(fx.admin, tempId)).title).toBe('New chat');
    expect((await fx.admin.post(`/api/chats/${tempId}/share`)).statusCode).toBe(400);
    expect((await fx.admin.get('/api/chats/export')).json().chats).toEqual([]);

    // An old one is removed; a kept one stays
    const kept = (await fx.admin.post('/api/chats', { temporary: true })).json().chat.id;
    expect((await fx.admin.patch(`/api/chats/${kept}`, { temporary: false })).statusCode).toBe(200);
    expect((await fx.admin.patch(`/api/chats/${kept}`, { temporary: true })).statusCode).toBe(400);
    const old = new Date(Date.now() - TEMPORARY_CHAT_TTL_MS - 60_000);
    await fx.db.db.update(chats).set({ updatedAt: old }).where(eq(chats.id, tempId));
    await fx.db.db.update(chats).set({ updatedAt: old }).where(eq(chats.id, kept));
    expect(await new ChatRepo(fx.db.db).purgeTemporary(new Date(Date.now() - TEMPORARY_CHAT_TTL_MS))).toBe(1);
    expect((await fx.admin.get(`/api/chats/${tempId}`)).statusCode).toBe(404);
    expect((await fx.admin.get(`/api/chats/${kept}`)).statusCode).toBe(200);
  });
});

describe('share links', () => {
  it('shares a snapshot that anyone can read, refreshes it and revokes it', async () => {
    const fx = await setup();
    fx.mock.push({ text: ['first reply'] }, { text: ['second reply'] });
    const chatId = await fx.newChat(fx.admin);
    const one = await say(fx, fx.admin, chatId, { content: 'hello <script>alert(1)</script>' });
    // A UI resource and a file in the chat
    await fx.db.db
      .update(messages)
      .set({
        parts: [
          { type: 'text', text: 'first reply' },
          { type: 'tool_call', callId: 'c1', alias: 'ui', serverId: 's', tool: 'ui', args: '{}' },
          { type: 'tool_result', callId: 'c1', content: 'ok', uiResource: { uri: 'ui://x', mimeType: 'text/html', text: '<b>x</b>' } },
          { type: 'file', fileId: '00000000-0000-0000-0000-000000000001', name: 'a.pdf', mime: 'application/pdf' },
        ],
      })
      .where(eq(messages.id, one.assistantMessageIds[0]));

    const created = await fx.admin.post(`/api/chats/${chatId}/share`);
    expect(created.statusCode).toBe(201);
    const { token } = created.json().share;
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect((await getChat(fx.admin, chatId)).share.token).toBe(token);

    // Signed out
    const anon = new TestClient(fx.app);
    const read = await anon.get(`/api/shared/${token}`);
    expect(read.statusCode).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    const shared = read.json().chat;
    expect(shared.sharedBy).toBe('admin');
    expect(shared.messages.map((m: any) => m.id)).toEqual(['n1', 'n2']);
    expect(shared.messages[1].parentId).toBe('n1');
    expect(JSON.stringify(shared)).not.toContain(chatId);
    expect(JSON.stringify(shared)).not.toContain('00000000-0000-0000-0000-000000000001');
    expect(shared.messages[1].parts.find((p: any) => p.type === 'tool_result').uiResource).toBeUndefined();

    // Later messages appear only when the link is refreshed (same token)
    await say(fx, fx.admin, chatId, { content: 'more', parentId: one.assistantMessageIds[0] });
    expect((await anon.get(`/api/shared/${token}`)).json().chat.messages).toHaveLength(2);
    expect((await fx.admin.post(`/api/chats/${chatId}/share`)).json().share.token).toBe(token);
    expect((await anon.get(`/api/shared/${token}`)).json().chat.messages).toHaveLength(4);

    // Someone else can't revoke it; the owner can
    const other = await fx.newUser('other@example.com');
    expect((await other.delete(`/api/shares/${token}`)).statusCode).toBe(404);
    expect((await fx.admin.get('/api/shares')).json().shares).toMatchObject([{ token, chatId }]);
    expect((await fx.admin.delete(`/api/chats/${chatId}/share`)).statusCode).toBe(200);
    expect((await anon.get(`/api/shared/${token}`)).statusCode).toBe(404);
    expect((await anon.get('/api/shared/not-a-token')).statusCode).toBe(404);
  });
});

describe('export and import', () => {
  it('round-trips chats with branches, folders, tags and parameters', async () => {
    const fx = await setup();
    fx.mock.push({ text: ['A1'] }, { text: ['A1 again'] });
    const parent = (await fx.admin.post('/api/folders', { name: 'Work' })).json().folder;
    const child = (await fx.admin.post('/api/folders', { name: 'Reports', parentId: parent.id })).json().folder;
    const chatId = (await fx.admin.post('/api/chats', { folderId: child.id })).json().chat.id;
    const one = await say(fx, fx.admin, chatId, { content: 'question' });
    await say(fx, fx.admin, chatId, { parentId: one.userMessageId, regenerate: true });
    await fx.admin.patch(`/api/chats/${chatId}`, { tags: ['q3'], params: { temperature: 0.3 }, pinned: true });

    const exported = (await fx.admin.get('/api/chats/export')).json() as ClaudiaExport;
    expect(exported).toMatchObject({ format: 'claudia-web', version: 1 });
    expect(exported.chats[0]).toMatchObject({ folder: ['Work', 'Reports'], tags: ['q3'], pinned: true, params: { temperature: 0.3 } });

    // Into another account
    const other = await fx.newUser('other@example.com');
    const res = await other.post('/api/chats/import', { chats: exported.chats });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ imported: 1, skippedMessages: 0 });
    const [imported] = (await other.get('/api/chats')).json().chats;
    const chat = await getChat(other, imported.id);
    const original = await getChat(fx.admin, chatId);
    expect(chat.title).toBe(original.title);
    expect(chat.messages.map(textOf).sort()).toEqual(original.messages.map(textOf).sort());
    expect(chat.messages.filter((m: any) => m.parentId === chat.messages[0].id)).toHaveLength(2);
    expect(chat.messages.every((m: any) => !original.messages.some((o: any) => o.id === m.id))).toBe(true);
    expect(textOf(chat.messages.find((m: any) => m.id === chat.currentLeafId))).toBe('A1 again');
    const folders = (await other.get('/api/folders')).json().folders;
    expect(folders.map((x: any) => x.name).sort()).toEqual(['Reports', 'Work']);
    expect(folders.find((x: any) => x.id === chat.folderId).name).toBe('Reports');

    // Importing again reuses the folders
    await other.post('/api/chats/import', { chats: exported.chats });
    expect((await other.get('/api/folders')).json().folders).toHaveLength(2);
  });

  it('leaves out messages whose parent is missing, and rejects bad input', async () => {
    const fx = await setup();
    const res = await fx.admin.post('/api/chats/import', {
      chats: [
        {
          title: 'Broken',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          currentLeafId: 'b',
          messages: [
            { id: 'a', parentId: null, role: 'user', parts: [{ type: 'text', text: 'hi' }], createdAt: '2024-01-01T00:00:00Z' },
            { id: 'b', parentId: 'a', role: 'assistant', parts: [{ type: 'text', text: 'yo' }], createdAt: '2024-01-01T00:00:01Z' },
            { id: 'c', parentId: 'zzz', role: 'user', parts: [], createdAt: '2024-01-01T00:00:02Z' },
            { id: 'd', parentId: 'c', role: 'assistant', parts: [], createdAt: '2024-01-01T00:00:03Z' },
          ],
        },
      ],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().skippedMessages).toBe(2);
    const chat = await getChat(fx.admin, res.json().chatIds[0]);
    expect(chat.messages.map(textOf)).toEqual(['hi', 'yo']);
    expect(chat.createdAt).toBe('2024-01-01T00:00:00.000Z');

    const bad = await fx.admin.post('/api/chats/import', { chats: [{ title: 'x', messages: [{ role: 'hacker' }] }] });
    expect(bad.statusCode).toBe(400);
  });

  it('orders trees parents first and drops loops', () => {
    const { ordered, skipped } = orderTree([
      { id: 'c', parentId: 'b' },
      { id: 'a', parentId: null },
      { id: 'b', parentId: 'a' },
      { id: 'x', parentId: 'y' },
      { id: 'y', parentId: 'x' },
    ]);
    expect(ordered.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(skipped).toBe(2);
  });
});

describe('follow-up parsing', () => {
  it('reads JSON arrays and plain lists', () => {
    expect(parseFollowUps('Sure! ["One?", "Two?", "Three?", "Four?"]')).toEqual(['One?', 'Two?', 'Three?']);
    expect(parseFollowUps('1. How?\n2) Why?\n- What?')).toEqual(['How?', 'Why?', 'What?']);
    expect(parseFollowUps('["a", 3, "Same?", "same?"]')).toEqual(['Same?']);
  });
});

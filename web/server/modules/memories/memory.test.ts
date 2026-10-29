/**
 * Automatic memory: the model's memory tools, learning from a quiet chat,
 * undo, sensitive topics, temporary chats, project memories and imports.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { chatFixture, type ChatFixture } from '../../test/chat-fixture';
import { memories, messages } from '../../db/schema';
import { parseImport, parseLearned } from './learn';

let f: ChatFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

async function setup(opts: { tools?: boolean; extraction?: boolean } = {}) {
  f = await chatFixture({ orchestrator: { memoryIdleMs: 0 } });
  await f.admin.patch('/api/admin/settings/tasks', { generateTitles: false, generateFollowUps: false, titleModel: null });
  await f.admin.patch('/api/admin/settings/memory', { tools: opts.tools ?? false, extraction: opts.extraction ?? false, model: null });
  return f;
}

async function say(fx: ChatFixture, content: string, opts: { chatId?: string; parentId?: string | null } = {}) {
  const chatId = opts.chatId ?? (await fx.newChat(fx.admin));
  const res = await fx.admin.post(`/api/chats/${chatId}/completions`, { parentId: opts.parentId ?? null, modelIds: ['mock/gpt-test'], content });
  expect(res.statusCode).toBe(202);
  const started = res.json();
  const events = await fx.readRun(fx.admin, started.runId);
  return { chatId, ...started, events };
}

const systemOf = (req: any) =>
  req.messages
    .filter((m: any) => m.role === 'system')
    .map((m: any) => m.content)
    .join('\n');
const lastStream = (fx: ChatFixture) => fx.mock.requests.filter((r) => r.stream).at(-1);
const memoryList = async (fx: ChatFixture) => (await fx.admin.get('/api/me/memories')).json().memories as any[];
const toolCall = (name: string, args: object, id = 'call_1') => ({ toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });

describe('memory tools', () => {
  it('lets the model save a memory that a new chat uses, shown under the reply and undoable', async () => {
    const fx = await setup({ tools: true });
    fx.mock.push(toolCall('memory_add', { topic: 'work', content: 'Works at Acme as a data engineer', sensitive: false }), { text: ['Noted!'] });
    const first = await say(fx, 'I work at Acme as a data engineer.');

    // Offered with the other tools, and run on the server
    expect(fx.mock.requests.find((r) => r.stream).tools.map((t: any) => t.function.name)).toEqual(
      expect.arrayContaining(['memory_view', 'memory_add', 'memory_update', 'memory_delete'])
    );
    const memoryEvent = first.events.find((e: any) => e.event.type === 'message.memory')!.event as any;
    expect(memoryEvent.change).toMatchObject({ action: 'add', topic: 'work', content: 'Works at Acme as a data engineer', undone: false });
    const [saved] = await memoryList(fx);
    expect(saved).toMatchObject({ content: 'Works at Acme as a data engineer', topic: 'work', source: 'model', chatId: first.chatId });

    const chat = (await fx.admin.get(`/api/chats/${first.chatId}`)).json().chat;
    const reply = chat.messages.find((m: any) => m.id === first.assistantMessageIds[0]);
    expect(reply.memoryChanges).toEqual([memoryEvent.change]);

    // A new chat knows it, grouped by topic and with ids for the tools
    fx.mock.push({ text: ['Hi.'] });
    await say(fx, 'Hello');
    expect(systemOf(lastStream(fx))).toContain(`Work:\n- [${saved.id}] Works at Acme as a data engineer`);

    // Undo from the chip: gone, and the chip says so
    const undo = await fx.admin.post(`/api/me/memories/changes/${memoryEvent.change.id}/undo`);
    expect(undo.statusCode).toBe(200);
    expect(await memoryList(fx)).toEqual([]);
    const again = (await fx.admin.get(`/api/chats/${first.chatId}`)).json().chat;
    expect(again.messages.find((m: any) => m.id === first.assistantMessageIds[0]).memoryChanges[0].undone).toBe(true);
  });

  it('changes and forgets memories, and undo puts them back', async () => {
    const fx = await setup({ tools: true });
    const created = (await fx.admin.post('/api/me/memories', { content: 'Works at Acme', topic: 'work' })).json().memory;
    fx.mock.push(toolCall('memory_update', { id: created.id, content: 'Works at Globex' }), { text: ['Updated.'] });
    const t1 = await say(fx, 'I moved to Globex.');
    expect((await memoryList(fx))[0].content).toBe('Works at Globex');

    fx.mock.push(toolCall('memory_delete', { id: created.id }), { text: ['Forgotten.'] });
    const t2 = await say(fx, 'Forget where I work.');
    expect(await memoryList(fx)).toEqual([]);

    const changeOf = (t: any) => (t.events.find((e: any) => e.event.type === 'message.memory')!.event as any).change;
    await fx.admin.post(`/api/me/memories/changes/${changeOf(t2).id}/undo`);
    expect((await memoryList(fx))[0]).toMatchObject({ id: created.id, content: 'Works at Globex' });
    await fx.admin.post(`/api/me/memories/changes/${changeOf(t1).id}/undo`);
    expect((await memoryList(fx))[0].content).toBe('Works at Acme');

    // Someone else's change can't be undone
    const bob = await fx.newUser('bob@example.com');
    expect((await bob.post(`/api/me/memories/changes/${changeOf(t1).id}/undo`)).statusCode).toBe(404);
  });

  it('skips sensitive topics unless the user allows them', async () => {
    const fx = await setup({ tools: true });
    fx.mock.push(toolCall('memory_add', { topic: 'about', content: 'Has type 1 diabetes', sensitive: true }), { text: ['OK.'] });
    await say(fx, 'I have type 1 diabetes.');
    expect(await memoryList(fx)).toEqual([]);
    expect(fx.mock.requests.filter((r) => r.stream).at(-1).messages.at(-1).content).toContain('"saved":false');

    await fx.admin.patch('/api/me/settings', { memory: { sensitive: true } });
    fx.mock.push(toolCall('memory_add', { topic: 'about', content: 'Has type 1 diabetes', sensitive: true }), { text: ['OK.'] });
    await say(fx, 'I have type 1 diabetes.');
    expect((await memoryList(fx)).map((m) => m.content)).toEqual(['Has type 1 diabetes']);
  });

  it('are not offered in temporary chats, when the user turns learning off, or by default', async () => {
    const fx = await setup({ tools: true });
    const offered = () => (lastStream(fx).tools ?? []).some((t: any) => t.function.name.startsWith('memory_'));

    const temp = (await fx.admin.post('/api/chats', { temporary: true })).json().chat.id;
    fx.mock.push({ text: ['Hi.'] });
    await say(fx, 'Hello', { chatId: temp });
    expect(offered()).toBe(false);

    await fx.admin.patch('/api/me/settings', { memory: { learn: false } });
    fx.mock.push({ text: ['Hi.'] });
    await say(fx, 'Hello');
    expect(offered()).toBe(false);

    await fx.admin.patch('/api/me/settings', { memory: { learn: true } });
    await fx.admin.patch('/api/admin/settings/memory', { tools: false, extraction: false, model: null });
    fx.mock.push({ text: ['Hi.'] });
    await say(fx, 'Hello');
    expect(offered()).toBe(false);
  });
});

describe('learning from chats', () => {
  it('remembers lasting facts once the chat is quiet, and a new chat uses them', async () => {
    const fx = await setup({ extraction: true });
    fx.mock.push({ text: ['Great, TypeScript it is.'] });
    fx.mock.completions.push({
      content: JSON.stringify({
        add: [
          { topic: 'preferences', content: 'Prefers TypeScript', sensitive: false },
          { topic: 'work', content: 'Works at Initech', sensitive: false },
          { topic: 'about', content: 'Is pregnant', sensitive: true },
        ],
        update: [],
        delete: [],
      }),
    });
    const t = await say(fx, 'I prefer TypeScript and I work at Initech. Also I am pregnant.');
    await fx.app.ctx.jobs.idle();

    const learn = fx.mock.requests.find((r) => !r.stream && String(r.messages[0].content).includes('long-term memory'));
    expect(String(learn.messages[1].content)).toContain('User: I prefer TypeScript');
    const list = await memoryList(fx);
    expect(list.map((m) => [m.topic, m.content, m.source]).sort()).toEqual([
      ['preferences', 'Prefers TypeScript', 'auto'],
      ['work', 'Works at Initech', 'auto'],
    ]);
    const chat = (await fx.admin.get(`/api/chats/${t.chatId}`)).json().chat;
    expect(chat.messages.find((m: any) => m.id === t.assistantMessageIds[0]).memoryChanges).toHaveLength(2);

    fx.mock.push({ text: ['Sure.'] });
    await say(fx, 'Write me a hello world.');
    expect(systemOf(lastStream(fx))).toContain('Prefers TypeScript');
    // That chat is read too, once it is quiet
    await fx.app.ctx.jobs.idle();
    const learnCalls = () => fx.mock.requests.filter((r) => !r.stream && String(r.messages[0].content).includes('long-term memory'));
    expect(learnCalls()).toHaveLength(2);

    // The same reply is not read twice
    const me = (await fx.admin.get('/api/me')).json().user.id;
    await fx.app.ctx.memoryLearner.extract(me, t.chatId, t.assistantMessageIds[0]);
    expect(learnCalls()).toHaveLength(2);
  });

  it('merges with what it knows, and only reads what is new since last time', async () => {
    const fx = await setup({ extraction: true });
    const known = (await fx.admin.post('/api/me/memories', { content: 'Works at Initech', topic: 'work' })).json().memory;
    fx.mock.push({ text: ['Congrats!'] });
    fx.mock.completions.push({ content: '```json\n' + JSON.stringify({ add: [{ topic: 'work', content: 'Works at Initech' }], update: [{ id: known.id, content: 'Works at Hooli' }], delete: [] }) + '\n```' });
    const t1 = await say(fx, 'I just moved from Initech to Hooli.');
    await fx.app.ctx.jobs.idle();
    expect((await memoryList(fx)).map((m) => m.content)).toEqual(['Works at Hooli']);
    const firstLearn = fx.mock.requests.filter((r) => !r.stream).at(-1);
    expect(String(firstLearn.messages[1].content)).toContain(`[${known.id}] (work) Works at Initech`);

    fx.mock.push({ text: ['Nice.'] });
    fx.mock.completions.push({ content: '{"add":[],"update":[],"delete":[]}' });
    await say(fx, 'I also like hiking.', { chatId: t1.chatId, parentId: t1.assistantMessageIds[0] });
    await fx.app.ctx.jobs.idle();
    const secondLearn = fx.mock.requests.filter((r) => !r.stream).at(-1);
    expect(String(secondLearn.messages[1].content)).toContain('I also like hiking');
    expect(String(secondLearn.messages[1].content)).not.toContain('Initech to Hooli');
  });

  it('never reads temporary chats, chats that moved on, or users who turned it off', async () => {
    const fx = await setup({ extraction: true });
    const learnCalls = () => fx.mock.requests.filter((r) => !r.stream && String(r.messages[0].content).includes('long-term memory'));

    const temp = (await fx.admin.post('/api/chats', { temporary: true })).json().chat.id;
    fx.mock.push({ text: ['Hi.'] });
    await say(fx, 'I work at Initech.', { chatId: temp });
    await fx.app.ctx.jobs.idle();
    expect(learnCalls()).toHaveLength(0);

    await fx.admin.patch('/api/me/settings', { memory: { learn: false } });
    fx.mock.push({ text: ['Hi.'] });
    const t = await say(fx, 'I work at Initech.');
    await fx.app.ctx.jobs.idle();
    expect(learnCalls()).toHaveLength(0);

    // A reply that is no longer the chat's latest is left to the newer one's job
    await fx.admin.patch('/api/me/settings', { memory: { learn: true } });
    fx.mock.push({ text: ['Again.'] });
    fx.mock.completions.push({ content: '{"add":[]}' });
    await say(fx, 'Still Initech.', { chatId: t.chatId, parentId: t.assistantMessageIds[0] });
    await fx.app.ctx.jobs.idle();
    const [row] = await fx.db.db.select().from(messages).where(eq(messages.id, t.assistantMessageIds[0]));
    await fx.app.ctx.memoryLearner.extract((await fx.admin.get('/api/me')).json().user.id, t.chatId, row.id);
    expect(learnCalls()).toHaveLength(1);
  });
});

describe('project memories and import', () => {
  it('keeps a folder memory to chats in that folder', async () => {
    const fx = await setup();
    const folder = (await fx.admin.post('/api/folders', { name: 'Thesis' })).json().folder;
    expect((await fx.admin.post('/api/me/memories', { content: 'Thesis is about coral reefs', topic: 'projects', folderId: folder.id })).statusCode).toBe(201);
    await fx.admin.post('/api/me/memories', { content: 'Likes green tea', topic: 'preferences' });

    fx.mock.push({ text: ['a'] }, { text: ['b'] });
    await say(fx, 'Hello');
    expect(systemOf(lastStream(fx))).not.toContain('coral reefs');
    const inFolder = (await fx.admin.post('/api/chats', { folderId: folder.id })).json().chat.id;
    await say(fx, 'Hello', { chatId: inFolder });
    expect(systemOf(lastStream(fx))).toContain('Thesis is about coral reefs (this project)');
    expect(systemOf(lastStream(fx))).toContain('Likes green tea');

    // Someone else's folder can't be used
    const bob = await fx.newUser('bob@example.com');
    expect((await bob.post('/api/me/memories', { content: 'x', folderId: folder.id })).statusCode).toBe(400);
    // Deleting the folder deletes its memories
    await fx.admin.delete(`/api/folders/${folder.id}`);
    expect((await memoryList(fx)).map((m) => m.content)).toEqual(['Likes green tea']);
  });

  it("imports another assistant's memories into topics, skipping duplicates and sensitive ones", async () => {
    const fx = await setup();
    await fx.admin.post('/api/me/memories', { content: 'Likes green tea' });
    fx.mock.completions.push({ content: '[{"topic":"work","sensitive":false},{"topic":"about","sensitive":true},{"topic":"people","sensitive":false}]' });
    const res = await fx.admin.post('/api/me/memories/import', {
      text: 'Here is what I remember:\n- Likes green tea\n- Is a nurse in Oslo\n- Takes antidepressants\n- Sister is called Ana\n- Is a nurse in Oslo',
    });
    expect(res.json()).toEqual({ added: 2, skipped: 2 });
    const list = await memoryList(fx);
    expect(list.map((m) => [m.topic, m.content, m.source]).sort()).toEqual([
      ['other', 'Likes green tea', 'user'],
      ['people', 'Sister is called Ana', 'import'],
      ['work', 'Is a nurse in Oslo', 'import'],
    ]);
    const [stored] = await fx.db.db.select().from(memories).where(eq(memories.content, 'Is a nurse in Oslo'));
    expect(stored.source).toBe('import');
  });
});

describe('parsers', () => {
  it('read the learning answer, ignoring what is malformed', () => {
    expect(parseLearned('Sure! {"add":[{"topic":"work","content":" Works at X "},{"content":""},{"topic":"nope","content":"Y","sensitive":true}],"delete":["a",{"id":"b"}]}')).toEqual({
      add: [
        { topic: 'work', content: 'Works at X', sensitive: false, project: false },
        { topic: 'other', content: 'Y', sensitive: true, project: false },
      ],
      update: [],
      delete: ['a', 'b'],
    });
    expect(parseLearned('nothing to add')).toEqual({ add: [], update: [], delete: [] });
  });

  it('read lists, JSON exports and plain lines', () => {
    expect(parseImport('## Work\n1. Is a nurse\n* Likes tea\n\nPreferences:\n• Likes tea')).toEqual(['Is a nurse', 'Likes tea']);
    expect(parseImport('["Is a nurse", "Likes tea"]')).toEqual(['Is a nurse', 'Likes tea']);
    expect(parseImport('{"memories":[{"content":"Is a nurse"},{"memory":"Likes tea"}]}')).toEqual(['Is a nurse', 'Likes tea']);
  });
});

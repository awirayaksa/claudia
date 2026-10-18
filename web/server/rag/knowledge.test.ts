/**
 * Phase 4: knowledge bases end to end — ingestion of every supported format,
 * hybrid search with and without embeddings, progress over the WebSocket,
 * citations in chats (#kb, folders, custom models), #url / YouTube / #chat
 * references, web search, reranking and memory retrieval.
 */
import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { sql } from 'drizzle-orm';
import { chatFixture, types, type ChatFixture } from '../test/chat-fixture';
import { startMockWeb, type MockWeb } from '../test/mock-web';
import type { TestClient } from '../test/client';
import { docxWith, pdfPages, pptxWith, TINY_PNG, xlsxWith } from '../test/documents';
import { rowsOf } from './vector-store';
import { DEFAULT_PERMISSIONS } from '../../shared/access';

let f: ChatFixture | undefined;
let web: MockWeb | undefined;
afterEach(async () => {
  await f?.close();
  await web?.close();
  f = undefined;
  web = undefined;
});

async function upload(c: TestClient, name: string, data: Buffer | string, mime: string): Promise<string> {
  const res = await c.upload(name, data, mime);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().file.id;
}

async function newKb(c: TestClient, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await c.post('/api/knowledge', { name, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().knowledge.id;
}

async function addDoc(fx: ChatFixture, c: TestClient, kbId: string, name: string, data: Buffer | string, mime = 'text/markdown') {
  const fileId = await upload(c, name, data, mime);
  const res = await c.post(`/api/knowledge/${kbId}/files`, { fileId });
  expect(res.statusCode, res.body).toBe(202);
  await fx.app.ctx.jobs.idle();
  return fileId;
}

async function search(c: TestClient, kbId: string, query: string, k = 5) {
  const res = await c.post(`/api/knowledge/${kbId}/search`, { query, k });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().hits as Array<{ title: string; text: string; page: number | null; heading: string | null; fileId: string }>;
}

async function enableEmbeddings(fx: ChatFixture, model = 'hash-256') {
  const res = await fx.admin.put('/api/admin/rag', { embedding: { engine: 'openai', baseUrl: fx.mock.url, model, batchSize: 8 } });
  expect(res.statusCode, res.body).toBe(200);
  await fx.app.ctx.jobs.idle();
  return res.json();
}

async function ask(fx: ChatFixture, c: TestClient, body: Record<string, unknown>, chatId?: string) {
  const chat = chatId ?? (await c.post('/api/chats', body.folderId ? { folderId: body.folderId } : {})).json().chat.id;
  const { folderId: _f, ...rest } = body;
  const res = await c.post(`/api/chats/${chat}/completions`, { parentId: null, content: 'Question', modelIds: ['mock/gpt-test'], ...rest });
  expect(res.statusCode, res.body).toBe(202);
  const events = await fx.readRun(c, res.json().runId);
  const request = fx.mock.requests.filter((r) => r.stream).at(-1);
  const system = (request?.messages ?? []).filter((m: any) => m.role === 'system').map((m: any) => m.content).join('\n');
  return { chatId: chat, events, system, assistantId: res.json().assistantMessageIds[0] as string };
}

describe('ingestion', () => {
  it('reads every supported format, keeping pages, slides, sheets and headings', async () => {
    f = await chatFixture();
    const kb = await newKb(f.admin, 'Formats');
    await addDoc(f, f.admin, kb, 'report.pdf', pdfPages(['Revenue grew in March', 'Churn fell in April']), 'application/pdf');
    await addDoc(f, f.admin, kb, 'memo.docx', await docxWith('The memo announces the new parking rules'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    await addDoc(f, f.admin, kb, 'budget.xlsx', xlsxWith('Q3 Budget', [['Item', 'Cost'], ['Laptops', 12000]]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await addDoc(f, f.admin, kb, 'deck.pptx', await pptxWith(['Kickoff agenda', 'Roadmap for satellites']), 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    await addDoc(f, f.admin, kb, 'page.html', '<html><head><title>Garden</title></head><body><article><h2>Tomatoes</h2><p>Water tomatoes every morning in summer.</p></article></body></html>', 'text/html');
    await addDoc(f, f.admin, kb, 'notes.md', '# Handbook\n\n## Holidays\n\nStaff get twenty-five vacation days.\n\n## Travel\n\nBook trains through the portal.');
    await addDoc(f, f.admin, kb, 'list.csv', 'city,population\nOslo,709000\nBergen,291000', 'text/csv');
    const bad = await addDoc(f, f.admin, kb, 'pic.png', TINY_PNG, 'image/png');

    const detail = (await f.admin.get(`/api/knowledge/${kb}`)).json().knowledge;
    const byName = Object.fromEntries(detail.files.map((x: any) => [x.name, x]));
    for (const name of ['report.pdf', 'memo.docx', 'budget.xlsx', 'deck.pptx', 'page.html', 'notes.md', 'list.csv']) {
      expect(byName[name], name).toMatchObject({ status: 'ready', error: null });
      expect(byName[name].chunks, name).toBeGreaterThan(0);
    }
    expect(byName['pic.png']).toMatchObject({ status: 'failed', error: expect.stringContaining("Images can't be searched") });
    expect(detail.fileCount).toBe(8);
    expect(detail.embedModel).toBeNull();

    // Keyword search finds each, with where it came from
    expect((await search(f.admin, kb, 'churn'))[0]).toMatchObject({ title: 'report.pdf', page: 2 });
    expect((await search(f.admin, kb, 'satellites'))[0]).toMatchObject({ title: 'deck.pptx', page: 2 });
    expect((await search(f.admin, kb, 'laptops'))[0]).toMatchObject({ title: 'budget.xlsx', heading: 'Q3 Budget' });
    expect((await search(f.admin, kb, 'vacation days'))[0]).toMatchObject({ title: 'notes.md', heading: 'Handbook › Holidays' });
    expect((await search(f.admin, kb, 'parking'))[0].title).toBe('memo.docx');
    expect((await search(f.admin, kb, 'tomatoes'))[0].title).toBe('page.html');
    expect((await search(f.admin, kb, 'Bergen'))[0].title).toBe('list.csv');
    expect(await search(f.admin, kb, 'xylophone')).toEqual([]);

    // Removing a file takes its passages with it
    const memo = byName['memo.docx'].fileId;
    expect((await f.admin.delete(`/api/knowledge/${kb}/files/${memo}`)).statusCode).toBe(200);
    expect(await search(f.admin, kb, 'parking')).toEqual([]);
    void bad;
  });
});

describe('embeddings', () => {
  it('search by meaning as well as words, and re-embed everything when the model changes', async () => {
    f = await chatFixture();
    const kb = await newKb(f.admin, 'Policies');
    await addDoc(f, f.admin, kb, 'refunds.md', '# Refunds\n\nCustomers may return products within thirty days for a full refund.');
    await addDoc(f, f.admin, kb, 'shipping.md', '# Shipping\n\nOrders ship from the warehouse within two business days.');
    // Keyword only so far
    expect((await f.admin.get(`/api/knowledge/${kb}`)).json().knowledge.embedModel).toBeNull();

    const saved = await enableEmbeddings(f);
    expect(saved.reindexing).toBe(true);
    const detail = (await f.admin.get(`/api/knowledge/${kb}`)).json().knowledge;
    expect(detail.embedModel).toBe('openai:hash-256');
    expect(detail.files.every((x: any) => x.status === 'ready')).toBe(true);
    const [{ n }] = rowsOf<{ n: number }>(await f.db.db.execute(sql`select count(*)::int as n from embeddings_256`));
    expect(Number(n)).toBeGreaterThanOrEqual(2);

    // "returning" shares no word with the text except via the vector's stems; the keyword list may miss, vectors don't
    expect((await search(f.admin, kb, 'returning a product'))[0].title).toBe('refunds.md');
    expect(f.mock.embeddingCalls.at(-1).input).toEqual(['returning a product']);

    // A new model: everything is embedded again, with its own dimensions
    await enableEmbeddings(f, 'hash-384');
    expect((await f.admin.get(`/api/knowledge/${kb}`)).json().knowledge.embedModel).toBe('openai:hash-384');
    const [{ m }] = rowsOf<{ m: number }>(await f.db.db.execute(sql`select count(*)::int as m from embeddings_384`));
    expect(Number(m)).toBeGreaterThanOrEqual(2);
    expect((await search(f.admin, kb, 'warehouse'))[0].title).toBe('shipping.md');

    const tested = await f.admin.post('/api/admin/rag/test-embeddings');
    expect(tested.json()).toEqual({ ok: true, error: null, dims: 384 });
  });

  it('can be reranked', async () => {
    f = await chatFixture();
    web = await startMockWeb();
    const kb = await newKb(f.admin, 'Fruit');
    await addDoc(f, f.admin, kb, 'a.md', 'Apples are red fruit.');
    await addDoc(f, f.admin, kb, 'b.md', 'Bananas are yellow fruit.');
    await addDoc(f, f.admin, kb, 'c.md', 'Cherries are small fruit.');
    await f.admin.put('/api/admin/rag', { rerank: { engine: 'cohere', baseUrl: web.url, model: 'rerank-test' }, rerankKey: 'rk' });
    web.preferred = 'Cherries';
    const hits = await search(f.admin, kb, 'fruit', 3);
    expect(hits[0].title).toBe('c.md');
    expect(web.reranks.at(-1)).toMatchObject({ query: 'fruit' });
    expect((await f.admin.get('/api/admin/rag')).json()).toMatchObject({ hasRerankKey: true, settings: { rerank: { engine: 'cohere' } } });
    expect((await f.admin.get('/api/admin/rag')).body).not.toContain('"rk"');
  });
});

describe('progress over the WebSocket', () => {
  it('reaches people who may read the knowledge base, from this origin only', async () => {
    f = await chatFixture();
    const bob = await f.newUser('bob@example.com');
    const kb = await newKb(f.admin, 'Live');
    const cookie = (c: TestClient) => [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const wsUrl = f.base.replace('http', 'ws') + '/api/ws';
    const connect = (c: TestClient, origin = f!.base) =>
      new Promise<{ socket: WebSocket; messages: any[] }>((resolve, reject) => {
        const socket = new WebSocket(wsUrl, { headers: { cookie: cookie(c), origin } });
        const messages: any[] = [];
        socket.on('message', (d) => messages.push(JSON.parse(String(d))));
        socket.on('open', () => resolve({ socket, messages }));
        socket.on('error', reject);
      });
    const waitFor = async (messages: any[], pred: (m: any) => boolean) => {
      for (let i = 0; i < 200 && !messages.some(pred); i++) await new Promise((r) => setTimeout(r, 25));
      return messages.find(pred);
    };

    const admin = await connect(f.admin);
    admin.socket.send(JSON.stringify({ type: 'subscribe', topic: `kb:${kb}` }));
    expect(await waitFor(admin.messages, (m) => m.type === 'subscribed')).toBeTruthy();
    const other = await connect(bob);
    other.socket.send(JSON.stringify({ type: 'subscribe', topic: `kb:${kb}` }));
    expect(await waitFor(other.messages, (m) => m.type === 'denied')).toBeTruthy();

    await addDoc(f, f.admin, kb, 'live.md', '# Live\n\nProgress events are sent.');
    const ready = await waitFor(admin.messages, (m) => m.event?.status === 'ready');
    expect(ready).toMatchObject({ topic: `kb:${kb}`, event: { type: 'kb.file', kbId: kb, chunks: 1, progress: 1 } });
    const statuses = admin.messages.filter((m) => m.event).map((m) => m.event.status);
    expect(statuses).toEqual(expect.arrayContaining(['queued', 'processing', 'ready']));
    expect(other.messages.some((m) => m.event)).toBe(false);

    // Another origin is refused (cross-site WebSocket hijacking)
    const foreign = await connect(f.admin, 'https://evil.example');
    const code = await new Promise<number>((r) => foreign.socket.on('close', (c) => r(c)));
    expect(code).toBe(4401);
    admin.socket.close();
    other.socket.close();
  });
});

describe('citations in chats', () => {
  it('cite #kb, folder and custom-model knowledge; private knowledge stays private', async () => {
    f = await chatFixture();
    await enableEmbeddings(f);
    const kb = await newKb(f.admin, 'Handbook');
    await addDoc(f, f.admin, kb, 'handbook.pdf', pdfPages(['Welcome to the company', 'Staff get twenty-five vacation days per year']), 'application/pdf');

    // #kb reference
    f.mock.push({ text: ['You get 25 days [1].'] });
    const one = await ask(f, f.admin, { content: 'How many vacation days do I get?', refs: [{ type: 'kb', id: kb }] });
    expect(one.system).toContain('<source id="1" title="handbook.pdf" page="2">');
    expect(one.system).toContain('twenty-five vacation days');
    expect(types(one.events)).toContain('message.citations');
    const cit = one.events.find((e) => e.event.type === 'message.citations')!.event as any;
    expect(cit.citations[0]).toMatchObject({ index: 1, source: { kind: 'file', title: 'handbook.pdf', page: 2 } });
    const stored = (await f.admin.get(`/api/chats/${one.chatId}`)).json().chat.messages.find((m: any) => m.id === one.assistantId);
    expect(stored.parts[0]).toMatchObject({ type: 'citation', index: 1, source: { title: 'handbook.pdf', page: 2 } });
    expect(stored.parts.at(-1)).toEqual({ type: 'text', text: 'You get 25 days [1].' });
    // The user turn remembers its references, and a regeneration uses them again
    const userNode = (await f.admin.get(`/api/chats/${one.chatId}`)).json().chat.messages.find((m: any) => m.role === 'user');
    f.mock.push({ text: ['Again [1].'] });
    const again = await f.admin.post(`/api/chats/${one.chatId}/completions`, { parentId: userNode.id, regenerate: true, modelIds: ['mock/gpt-test'] });
    await f.readRun(f.admin, again.json().runId);
    expect(f.mock.requests.filter((r) => r.stream).at(-1).messages.some((m: any) => String(m.content).includes('twenty-five'))).toBe(true);

    // Folder knowledge applies to every chat in it (and its subfolders)
    const folder = (await f.admin.post('/api/folders', { name: 'HR' })).json().folder.id;
    const sub = (await f.admin.post('/api/folders', { name: 'Leave', parentId: folder })).json().folder.id;
    expect((await f.admin.patch(`/api/folders/${folder}`, { knowledgeIds: [kb] })).json().folder.knowledgeIds).toEqual([kb]);
    f.mock.push({ text: ['From the folder [1].'] });
    expect((await ask(f, f.admin, { content: 'vacation days?', folderId: sub })).system).toContain('twenty-five vacation days');

    // Bob can't reference the admin's private knowledge, or bind it to a folder
    const bob = await f.newUser('bob@example.com');
    const chat = (await bob.post('/api/chats', {})).json().chat.id;
    const refused = await bob.post(`/api/chats/${chat}/completions`, { parentId: null, content: 'x', modelIds: ['mock/gpt-test'], refs: [{ type: 'kb', id: kb }] });
    expect(refused.statusCode).toBe(400);
    const bobFolder = (await bob.post('/api/folders', { name: 'Mine' })).json().folder.id;
    expect((await bob.patch(`/api/folders/${bobFolder}`, { knowledgeIds: [kb] })).statusCode).toBe(400);

    // ...but a custom model the admin shares uses it with the admin's access
    const model = (await f.admin.post('/api/workspace/models', { name: 'HR bot', baseModelId: 'mock/gpt-test', knowledgeIds: [kb] })).json().model;
    await f.admin.put(`/api/workspace/models/${model.id}/access`, { grants: [{ principalType: 'public', perm: 'read' }] });
    f.mock.push({ text: ['25 [1].'] });
    const viaModel = await ask(f, bob, { content: 'vacation days?', modelIds: [model.key] });
    expect(viaModel.system).toContain('twenty-five vacation days');
    // Bob still can't search it directly
    expect((await bob.post(`/api/knowledge/${kb}/search`, { query: 'vacation' })).statusCode).toBe(404);
  });

  it('reads #url pages (through the SSRF guard), YouTube transcripts and #chat references', async () => {
    web = await startMockWeb();
    f = await chatFixture({ youtubeOrigin: web.url });
    web.pages.set('/tides', { title: 'Tide tables', body: '<p>High tide in Bergen is at 06:12 tomorrow.</p>' });

    // 127.0.0.1 is private: refused until the admin allows it
    f.mock.push({ text: ['No page.'] });
    const blocked = await ask(f, f.admin, { content: 'When is high tide?', refs: [{ type: 'url', url: `${web.url}/tides` }] });
    expect(blocked.system).not.toContain('06:12');
    expect(blocked.events.some((e) => e.event.type === 'run.notice' && /Couldn't read/.test((e.event as any).message))).toBe(true);

    await f.admin.patch('/api/admin/settings/net.allowlist', { hosts: ['127.0.0.1'] });
    f.mock.push({ text: ['At 06:12 [1].'] });
    const page = await ask(f, f.admin, { content: 'When is high tide?', refs: [{ type: 'url', url: `${web.url}/tides` }] });
    expect(page.system).toContain('High tide in Bergen is at 06:12');
    expect(page.system).toContain(`url="${web.url}/tides"`);

    f.mock.push({ text: ['Reef early [1].'] });
    const video = await ask(f, f.admin, { content: 'What does the video say?', refs: [{ type: 'url', url: 'https://www.youtube.com/watch?v=abcdefghijk' }] });
    expect(video.system).toContain('title="Sailing basics"');
    expect(video.system).toContain('Always reef the mainsail before the squall arrives.');

    // #chat: another of my chats as a source
    f.mock.push({ text: ['Noted.'] });
    const earlier = await ask(f, f.admin, { content: 'My boat is called Wren.' });
    f.mock.push({ text: ['Wren [1].'] });
    const ref = await ask(f, f.admin, { content: "What's my boat called?", refs: [{ type: 'chat', id: earlier.chatId }] });
    expect(ref.system).toContain('User: My boat is called Wren.');
    // Someone else's chat can't be referenced
    const bob = await f.newUser('bob@example.com');
    const bobChat = (await bob.post('/api/chats', {})).json().chat.id;
    const theirs = await bob.post(`/api/chats/${bobChat}/completions`, { parentId: null, content: 'x', modelIds: ['mock/gpt-test'], refs: [{ type: 'chat', id: earlier.chatId }] });
    expect(theirs.statusCode).toBe(404);
  });

  it('searches the web when asked, for users allowed to', async () => {
    web = await startMockWeb();
    f = await chatFixture();
    web.pages.set('/news', { title: 'Harbour news', body: '<p>The ferry to Stavanger now leaves at 9:30.</p>' });
    await f.admin.patch('/api/admin/settings/net.allowlist', { hosts: ['127.0.0.1'] });

    const chat = (await f.admin.post('/api/chats', {})).json().chat.id;
    const off = await f.admin.post(`/api/chats/${chat}/completions`, { parentId: null, content: 'ferry?', modelIds: ['mock/gpt-test'], features: { webSearch: true } });
    expect(off.statusCode).toBe(400);
    expect(off.json().error.code).toBe('web_search_off');

    await f.admin.put('/api/admin/rag', { webSearch: { engine: 'searxng', baseUrl: web.url, cx: '', resultCount: 3, fetchPages: true } });
    f.mock.push({ text: ['9:30 [1].'] });
    const res = await ask(f, f.admin, { content: 'When does the ferry to Stavanger leave?', features: { webSearch: true } });
    expect(web.searches.at(-1)).toBe('When does the ferry to Stavanger leave?');
    expect(res.system).toContain('The ferry to Stavanger now leaves at 9:30.');
    const cit = res.events.find((e) => e.event.type === 'message.citations')!.event as any;
    expect(cit.citations[0].source).toMatchObject({ kind: 'url', url: `${web.url}/news`, title: 'Harbour news' });

    // Not for users without the permission
    await f.admin.patch('/api/admin/settings/permissions.default', { ...DEFAULT_PERMISSIONS, 'features.web_search': false });
    const bob = await f.newUser('bob@example.com');
    const bobChat = (await bob.post('/api/chats', {})).json().chat.id;
    const denied = await bob.post(`/api/chats/${bobChat}/completions`, { parentId: null, content: 'x', modelIds: ['mock/gpt-test'], features: { webSearch: true } });
    expect(denied.statusCode).toBe(403);
  });
});

describe('memory retrieval', () => {
  it('sends only the memories closest to the message once there are many', async () => {
    f = await chatFixture();
    await enableEmbeddings(f);
    const filler = (i: number) => `Note ${i}: I collect stamps from the year ${1900 + i} and keep them in album number ${i} on the shelf.`;
    for (let i = 0; i < 25; i++) await f.admin.post('/api/me/memories', { content: filler(i) });
    await f.admin.post('/api/me/memories', { content: 'My daughter Ingrid is allergic to peanuts.' });
    await f.app.ctx.jobs.idle();

    f.mock.push({ text: ['Noted.'] });
    const res = await ask(f, f.admin, { content: 'Plan a snack for my daughter Ingrid, mind her allergies.' });
    expect(res.system).toContain('Ingrid is allergic to peanuts');
    // Not all 26 of them
    expect((res.system.match(/I collect stamps/g) ?? []).length).toBeLessThan(10);
  });
});

/**
 * Phase 7 features: blind comparisons and the Elo leaderboard, notes (and
 * #note references), channels with @model replies over the WebSocket hub,
 * scheduled prompts, and Google Drive / OneDrive imports (fake providers).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { chatFixture, type ChatFixture } from '../test/chat-fixture';
import { startFakeCloud, type FakeCloud } from '../test/fake-cloud';
import { schedules } from '../db/schema';
import { ARENA_MODEL_ID, eloRatings } from '../../shared/arena';
import { nextRun } from './schedules/service';

let f: ChatFixture | undefined;
let cloud: FakeCloud | undefined;
afterEach(async () => {
  await f?.close();
  await cloud?.close();
  f = undefined;
  cloud = undefined;
});

const send = (_fx: ChatFixture, client: ChatFixture['admin'], chatId: string, body: Record<string, unknown>) =>
  client.post(`/api/chats/${chatId}/completions`, { parentId: null, modelIds: ['mock/gpt-test'], ...body });

describe('arena', () => {
  it('answers with two unnamed models, reveals them on the vote, and ranks them', async () => {
    f = await chatFixture();
    // Off until the admin picks at least two models
    expect((await f.admin.get('/api/models')).json().models.map((m: any) => m.id)).not.toContain(ARENA_MODEL_ID);
    await f.admin.patch('/api/admin/settings/arena', { enabled: true, models: ['mock/gpt-test', 'mock/gpt-other'] });
    expect((await f.admin.get('/api/models')).json().models.map((m: any) => m.id)).toContain(ARENA_MODEL_ID);
    expect((await f.admin.get('/api/auth/session')).json().features.arena).toBe(true);

    f.mock.push({ text: ['First answer'] }, { text: ['Second answer'] });
    const chatId = await f.newChat(f.admin);
    const res = await send(f, f.admin, chatId, { content: 'Which is better?', modelIds: [ARENA_MODEL_ID] });
    expect(res.statusCode).toBe(202);
    const { runId, userMessageId } = res.json();
    const events = await f.readRun(f.admin, runId);
    // Nothing on the wire names the models
    const created = events.filter((e) => e.event.type === 'message.created').map((e: any) => e.event.message);
    expect(created.find((m: any) => m.role === 'user')).toMatchObject({ models: ['arena:A', 'arena:B'], arena: { winner: null, models: null } });
    expect(created.filter((m: any) => m.role === 'assistant').map((m: any) => m.modelId).sort()).toEqual(['arena:A', 'arena:B']);
    expect(JSON.stringify(events)).not.toMatch(/gpt-test|gpt-other/);
    // Both models really answered
    expect(f.mock.requests.filter((r) => r.stream).map((r) => r.model).sort()).toEqual(['gpt-other', 'gpt-test']);

    const before = (await f.admin.get(`/api/chats/${chatId}`)).json().chat;
    expect(JSON.stringify(before.messages)).not.toMatch(/mock\/gpt/);
    // No regenerating before the vote
    expect((await f.admin.post(`/api/chats/${chatId}/completions`, { parentId: userMessageId, regenerate: true, modelIds: [ARENA_MODEL_ID] })).json().error.code).toBe(
      'arena_vote_first'
    );

    const vote = await f.admin.post(`/api/chats/${chatId}/messages/${userMessageId}/arena-vote`, { winner: 'a' });
    expect(vote.statusCode).toBe(200);
    const [a, b] = vote.json().models;
    expect([a, b].sort()).toEqual(['mock/gpt-other', 'mock/gpt-test']);
    expect((await f.admin.post(`/api/chats/${chatId}/messages/${userMessageId}/arena-vote`, { winner: 'b' })).statusCode).toBe(409);
    const after = (await f.admin.get(`/api/chats/${chatId}`)).json().chat.messages;
    expect(after.find((m: any) => m.id === userMessageId).arena).toEqual({ winner: 'a', models: [a, b] });
    expect(after.filter((m: any) => m.role === 'assistant').map((m: any) => m.modelId).sort()).toEqual([a, b].sort());

    const board = (await f.admin.get('/api/admin/arena/leaderboard')).json();
    expect(board.votes).toBe(1);
    expect(board.rows[0]).toMatchObject({ modelId: a, wins: 1, games: 1, rating: 1016 });
    expect(board.rows[1]).toMatchObject({ modelId: b, losses: 1, rating: 984 });
    const user = await f.newUser('voter@example.com');
    expect((await user.get('/api/admin/arena/leaderboard')).statusCode).toBe(403);
  });

  it('computes Elo in vote order, with ties', () => {
    const rows = eloRatings([
      { modelA: 'x', modelB: 'y', winner: 'a' },
      { modelA: 'y', modelB: 'z', winner: 'tie' },
      { modelA: 'x', modelB: 'z', winner: 'a' },
    ]);
    expect(rows.map((r) => r.modelId)).toEqual(['x', 'y', 'z']);
    expect(rows.find((r) => r.modelId === 'y')).toMatchObject({ wins: 0, losses: 1, ties: 1, games: 2 });
    expect(rows.reduce((s, r) => s + r.rating, 0)).toBeCloseTo(3000, -1);
  });
});

describe('notes', () => {
  it('are private, shareable read-only or for editing, and usable in a chat with #note', async () => {
    f = await chatFixture();
    const ann = await f.newUser('ann@example.com');
    const bob = await f.newUser('bob@example.com');
    const created = await ann.post('/api/notes', { title: 'Trip', content: '# Oslo\nThe hotel is the Grand, room 412.' });
    expect(created.statusCode).toBe(201);
    const note = created.json().note;
    expect(note).toMatchObject({ title: 'Trip', mine: true, canEdit: true, canManage: true, snippet: 'Oslo The hotel is the Grand, room 412.' });

    // Not even an admin sees another's private note
    expect((await bob.get(`/api/notes/${note.id}`)).statusCode).toBe(404);
    expect((await f.admin.get(`/api/notes/${note.id}`)).statusCode).toBe(404);
    expect((await f.admin.get('/api/notes')).json().notes).toEqual([]);

    const bobId = (await f.admin.get('/api/admin/users?search=bob')).json().users[0].id;
    expect((await ann.put(`/api/notes/${note.id}/access`, { grants: [{ principalType: 'user', principalId: bobId, perm: 'read' }] })).statusCode).toBe(200);
    expect((await bob.get('/api/notes')).json().notes).toEqual([expect.objectContaining({ id: note.id, mine: false, canEdit: false, ownerName: 'ann' })]);
    expect((await bob.patch(`/api/notes/${note.id}`, { content: 'x' })).statusCode).toBe(403);
    await ann.put(`/api/notes/${note.id}/access`, { grants: [{ principalType: 'user', principalId: bobId, perm: 'write' }] });
    expect((await bob.patch(`/api/notes/${note.id}`, { title: 'Trip to Oslo' })).json().note.title).toBe('Trip to Oslo');
    expect((await bob.delete(`/api/notes/${note.id}`)).statusCode).toBe(403);

    // Asking about it in a chat
    f.mock.push({ text: ['Room 412.'] });
    const chatId = await f.newChat(bob);
    const res = await send(f, bob, chatId, { content: 'Which room?', refs: [{ type: 'note', id: note.id }] });
    expect(res.statusCode).toBe(202);
    const events = await f.readRun(bob, res.json().runId);
    expect(events.find((e) => e.event.type === 'message.citations')?.event).toMatchObject({ citations: [{ index: 1, source: { kind: 'note', id: note.id, title: 'Trip to Oslo' } }] });
    const sent = f.mock.requests.filter((r) => r.stream).at(-1);
    expect(JSON.stringify(sent.messages)).toContain('room 412');
    // Someone without access can't refer to it
    const carl = await f.newUser('carl@example.com');
    const carlChat = await f.newChat(carl);
    expect((await send(f, carl, carlChat, { content: 'x', refs: [{ type: 'note', id: note.id }] })).json().error.code).toBe('note_not_found');

    expect((await ann.delete(`/api/notes/${note.id}`)).statusCode).toBe(200);
    expect((await bob.get(`/api/notes/${note.id}`)).statusCode).toBe(404);
  });
});

describe('channels', () => {
  it('lets members talk, streams an @model reply to everyone watching, and keeps others out', async () => {
    f = await chatFixture();
    const ann = await f.newUser('ann@example.com');
    const out = await f.newUser('out@example.com');
    expect((await ann.post('/api/channels', { name: 'general' })).statusCode).toBe(403);
    const channel = (await f.admin.post('/api/channels', { name: 'general', description: 'Everything' })).json().channel;
    const annId = (await f.admin.get('/api/admin/users?search=ann')).json().users[0].id;
    await f.admin.put(`/api/channels/${channel.id}/access`, { grants: [{ principalType: 'user', principalId: annId, perm: 'read' }] });
    expect((await ann.get('/api/channels')).json().channels.map((c: any) => c.name)).toEqual(['general']);
    expect((await out.get('/api/channels')).json().channels).toEqual([]);
    expect((await out.post(`/api/channels/${channel.id}/messages`, { content: 'hi' })).statusCode).toBe(404);

    // A socket watching the channel (as the WebSocket gateway would hold it)
    const got: any[] = [];
    const socket = { readyState: 1, OPEN: 1, send: (d: string) => got.push(JSON.parse(d).event) } as never;
    const annUser = { id: annId, role: 'user' } as never;
    expect(await f.app.ctx.events.subscribe(socket, annUser, `channel:${channel.id}`)).toBe(true);
    expect(await f.app.ctx.events.subscribe(socket, { id: 'nobody', role: 'user' } as never, `channel:${channel.id}x`)).toBe(false);

    expect((await ann.post(`/api/channels/${channel.id}/messages`, { content: 'Morning all' })).statusCode).toBe(201);
    f.mock.push({ text: ['Good ', 'morning!'], usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } });
    const asked = await ann.post(`/api/channels/${channel.id}/messages`, { content: '@mock/gpt-test say hello' });
    expect(asked.statusCode).toBe(201);
    await vi.waitFor(() => expect(got.some((e) => e.type === 'channel.message.updated' && e.message.status === 'done')).toBe(true));
    expect(got.filter((e) => e.type === 'channel.delta').map((e) => e.text).join('')).toBe('Good morning!');

    const list = (await ann.get(`/api/channels/${channel.id}/messages`)).json().messages;
    expect(list.map((m: any) => [m.author.kind, m.content])).toEqual([
      ['user', 'Morning all'],
      ['user', '@mock/gpt-test say hello'],
      ['model', 'Good morning!'],
    ]);
    // The model saw who said what
    const sent = f.mock.requests.filter((r) => r.stream).at(-1);
    expect(sent.messages.at(-1)).toEqual({ role: 'user', content: 'ann: @mock/gpt-test say hello' });
    expect((await f.admin.get('/api/admin/analytics?days=1')).json().byKind.map((k: any) => k.kind)).toContain('channel');

    // A model nobody may use, editing others' messages, deleting one's own
    expect((await ann.post(`/api/channels/${channel.id}/messages`, { content: '@other/secret hi' })).json().error.code).toBe('unknown_model');
    expect((await ann.patch(`/api/channels/${channel.id}/messages/${list[2].id}`, { content: 'x' })).statusCode).toBe(404);
    expect((await ann.delete(`/api/channels/${channel.id}/messages/${list[0].id}`)).statusCode).toBe(200);
    expect((await ann.get(`/api/channels/${channel.id}/messages`)).json().messages[0]).toMatchObject({ deleted: true, content: '' });
    f.app.ctx.events.unsubscribe(socket);
  });
});

describe('scheduled prompts', () => {
  it('validates the schedule, runs when due (once) and records the outcome', async () => {
    f = await chatFixture();
    const sam = await f.newUser('sam@example.com');
    expect((await sam.get('/api/schedules')).statusCode).toBe(403);
    await f.admin.patch('/api/admin/settings/permissions.default', { ...(await f.admin.get('/api/admin/settings')).json().settings['permissions.default'], 'features.schedules': true });

    const base = { name: 'Morning brief', prompt: 'Summarise today', modelId: 'mock/gpt-test', cron: '0 8 * * 1-5', timezone: 'Europe/Oslo' };
    expect((await sam.post('/api/schedules', { ...base, cron: 'every day' })).json().error.code).toBe('invalid_cron');
    expect((await sam.post('/api/schedules', { ...base, cron: '* * * * *' })).json().error.code).toBe('cron_too_often');
    expect((await sam.post('/api/schedules', { ...base, timezone: 'Mars/Olympus' })).json().error.code).toBe('invalid_timezone');
    expect((await sam.post('/api/schedules', { ...base, modelId: 'nope/model' })).statusCode).toBe(404);
    const created = await sam.post('/api/schedules', base);
    expect(created.statusCode).toBe(201);
    const s = created.json().schedule;
    expect(new Date(s.nextRunAt).getUTCHours()).toBeOneOf([6, 7]);

    // Due now: two ticks (as from two instances) run it once
    await f.db.db.update(schedules).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(schedules.id, s.id));
    f.mock.push({ text: ['Here is your brief.'] });
    const runs = await Promise.all([f.app.ctx.schedules.tick(), f.app.ctx.schedules.tick()]);
    expect(runs.reduce((a, b) => a + b, 0)).toBe(1);
    let after: any;
    await vi.waitFor(async () => {
      after = (await sam.get('/api/schedules')).json().schedules[0];
      expect(after.lastStatus).toBe('completed');
    });
    expect(new Date(after.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    const chat = (await sam.get(`/api/chats/${after.lastChatId}`)).json().chat;
    expect(chat.title).toMatch(/^Morning brief · /);
    expect(chat.messages.map((m: any) => m.parts[0]?.text)).toEqual(['Summarise today', 'Here is your brief.']);

    // "Same chat" continues one chat; run now
    await sam.patch(`/api/schedules/${s.id}`, { chatMode: 'same' });
    f.mock.push({ text: ['One.'] }, { text: ['Two.'] });
    const first = (await sam.post(`/api/schedules/${s.id}/run`)).json();
    await f.readRun(sam, first.runId);
    const second = (await sam.post(`/api/schedules/${s.id}/run`)).json();
    expect(second.chatId).toBe(first.chatId);
    await f.readRun(sam, second.runId);
    expect((await sam.get(`/api/chats/${first.chatId}`)).json().chat.messages).toHaveLength(4);

    // Without the permission it is skipped, not run
    await f.admin.patch('/api/admin/settings/permissions.default', { ...(await f.admin.get('/api/admin/settings')).json().settings['permissions.default'], 'features.schedules': false });
    await f.db.db.update(schedules).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(schedules.id, s.id));
    await f.app.ctx.schedules.tick();
    const [row] = await f.db.db.select().from(schedules).where(eq(schedules.id, s.id));
    expect(row).toMatchObject({ lastStatus: 'skipped' });
  });

  it('follows the time zone', () => {
    const from = new Date('2026-10-17T12:00:00Z'); // a Saturday
    expect(nextRun('0 8 * * 1-5', 'Europe/Oslo', from)?.toISOString()).toBe('2026-10-19T06:00:00.000Z');
    expect(nextRun('0 8 * * *', 'America/New_York', from)?.toISOString()).toBe('2026-10-18T12:00:00.000Z');
  });
});

describe('cloud files', () => {
  async function withCloud() {
    cloud = await startFakeCloud();
    f = await chatFixture({ cloudEndpoints: cloud.endpoints });
    const saved = await f.admin.put('/api/admin/cloud', {
      google: { enabled: true, clientId: 'g-client' },
      microsoft: { enabled: true, clientId: 'm-client', tenant: 'contoso.example' },
      googleSecret: 'cloud-secret',
      microsoftSecret: 'cloud-secret',
    });
    expect(saved.json()).toMatchObject({ hasSecret: { google: true, microsoft: true } });
    expect(JSON.stringify(saved.json())).not.toContain('cloud-secret');
    return f;
  }

  /** The pop-up's round trip: connect → provider → callback page. */
  async function connect(_fx: ChatFixture, client: ChatFixture['admin'], provider: 'google' | 'microsoft') {
    const start = await client.get(`/api/cloud/${provider}/connect`);
    expect(start.statusCode).toBe(302);
    const location = new URL(String(start.headers.location));
    expect(location.searchParams.get('scope')).toContain(provider === 'google' ? 'drive.readonly' : 'Files.Read.All');
    if (provider === 'microsoft') expect(location.pathname).toBe('/ms/contoso.example/oauth2/v2.0/authorize');
    const back = new URL((await fetch(location, { redirect: 'manual' })).headers.get('location')!);
    const done = await client.get(back.pathname + back.search);
    expect(done.body).toContain('data-cloud-result="ok"');
  }

  it('connects Google Drive, browses folders, searches, and imports files (Docs exported)', async () => {
    const fx = await withCloud();
    const user = await fx.newUser('dee@example.com');
    expect((await user.get('/api/auth/session')).json().features.cloudFiles).toEqual({ google: true, microsoft: true });
    expect((await user.get('/api/cloud/google/files')).json().error.code).toBe('cloud_not_connected');
    await connect(fx, user, 'google');
    expect((await user.get('/api/cloud/accounts')).json().accounts).toEqual([
      { provider: 'google', connected: true, accountEmail: 'drive.user@example.com' },
      { provider: 'microsoft', connected: false, accountEmail: null },
    ]);

    const root = (await user.get('/api/cloud/google/files')).json();
    expect(root.items.map((i: any) => [i.name, i.folder])).toEqual([
      ['Projects', true],
      ['Roadmap.docx', false],
      ['notes.txt', false],
    ]);
    expect((await user.get('/api/cloud/google/files?folder=folder-1')).json().items.map((i: any) => i.name)).toEqual(['plan.txt']);
    expect((await user.get('/api/cloud/google/files?q=plan')).json().items.map((i: any) => i.name)).toEqual(['plan.txt']);

    const imported = await user.post('/api/cloud/google/import', { fileId: 'txt-1' });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().file).toMatchObject({ name: 'notes.txt', status: 'ready', hasText: true });
    const doc = (await user.post('/api/cloud/google/import', { fileId: 'doc-1' })).json().file;
    expect(doc).toMatchObject({ name: 'Roadmap.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    expect((await user.post('/api/cloud/google/import', { fileId: 'folder-1' })).json().error.code).toBe('cloud_folder');
    // Someone else's connection isn't shared
    const other = await fx.newUser('eve@example.com');
    expect((await other.get('/api/cloud/google/files')).json().error.code).toBe('cloud_not_connected');
  });

  it('connects OneDrive, refreshes an expired token, and disconnects', async () => {
    const fx = await withCloud();
    const user = await fx.newUser('fay@example.com');
    cloud!.longLivedTokens = false;
    await connect(fx, user, 'microsoft');
    expect((await user.get('/api/cloud/microsoft/files')).json().items.map((i: any) => i.name)).toEqual(['Documents', 'budget.csv']);
    // The 1-second token was refreshed
    expect(cloud!.tokenGrants.map((g) => g.grant_type)).toContain('refresh_token');
    expect((await user.post('/api/cloud/microsoft/import', { fileId: 'od-1' })).json().file).toMatchObject({ name: 'budget.csv' });
    expect((await user.delete('/api/cloud/microsoft')).statusCode).toBe(200);
    expect((await user.get('/api/cloud/microsoft/files')).json().error.code).toBe('cloud_not_connected');
  });

  it('refuses a callback that this user did not start', async () => {
    const fx = await withCloud();
    const user = await fx.newUser('gus@example.com');
    const done = await user.get('/api/cloud/google/callback?code=code-ok&state=forged');
    expect(done.body).toContain('data-cloud-result="error"');
    expect((await user.get('/api/cloud/accounts')).json().accounts[0].connected).toBe(false);
  });
});

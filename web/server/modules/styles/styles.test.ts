/**
 * Writing styles: built-ins and one's own reach the model in a style block,
 * the chat remembers the last one, regenerations keep the turn's, custom
 * styles are private until shared, and "write it for me" drafts one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { chatFixture, type ChatFixture } from '../../test/chat-fixture';
import type { TestClient } from '../../test/client';

let f: ChatFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

async function setup() {
  f = await chatFixture();
  await f.admin.patch('/api/me/settings', { preferences: { visualExplanations: false } });
  await f.admin.patch('/api/admin/settings/tasks', { generateTitles: false, generateFollowUps: false, titleModel: null });
  return f;
}

async function ask(fx: ChatFixture, c: TestClient, chatId: string, body: Record<string, unknown>) {
  fx.mock.push({ text: ['OK.'] });
  const res = await c.post(`/api/chats/${chatId}/completions`, { parentId: null, modelIds: ['mock/gpt-test'], content: 'Explain DNS', ...body });
  expect(res.statusCode, res.body).toBe(202);
  await fx.readRun(c, res.json().runId);
  const req = fx.mock.requests.filter((r) => r.stream).at(-1);
  return { ...res.json(), system: (req.messages as any[]).filter((m) => m.role === 'system').map((m) => m.content).join('\n') };
}

describe('writing styles', () => {
  it('sends a built-in style, which the chat remembers and a regeneration keeps', async () => {
    const fx = await setup();
    const list = (await fx.admin.get('/api/styles')).json().styles;
    expect(list.map((s: any) => s.id)).toEqual(['normal', 'concise', 'explanatory', 'formal']);

    const chatId = await fx.newChat(fx.admin);
    const first = await ask(fx, fx.admin, chatId, { styleId: 'concise' });
    expect(first.system).toContain('<style name="Concise">');
    expect(first.system).toContain('Be brief.');
    expect((await fx.admin.get(`/api/chats/${chatId}`)).json().chat.params.styleId).toBe('concise');

    // Answering the turn again keeps its style, whatever is picked now
    fx.mock.push({ text: ['Again.'] });
    const again = await fx.admin.post(`/api/chats/${chatId}/completions`, { parentId: first.userMessageId, regenerate: true, modelIds: ['mock/gpt-test'], styleId: 'formal' });
    await fx.readRun(fx.admin, again.json().runId);
    expect(fx.mock.requests.filter((r) => r.stream).at(-1).messages.some((m: any) => String(m.content).includes('<style name="Concise">'))).toBe(true);

    // Normal: no style block, and the chat forgets the style
    const normal = await ask(fx, fx.admin, chatId, { styleId: 'normal', parentId: first.assistantMessageIds[0] });
    expect(normal.system).not.toContain('<style');
    expect((await fx.admin.get(`/api/chats/${chatId}`)).json().chat.params.styleId).toBeUndefined();
  });

  it('keeps custom styles private until shared; admins make styles for everyone', async () => {
    const fx = await setup();
    const bob = await fx.newUser('bob@example.com');
    const bobId = (await bob.get('/api/me')).json().user.id;
    const mine = (await fx.admin.post('/api/styles', { name: 'Pirate', instructions: 'Talk like a pirate.' })).json().style;
    expect(mine).toMatchObject({ scope: 'mine', canEdit: true, canManage: true });

    // Bob can't see or use it
    expect((await bob.get('/api/styles')).json().styles.some((s: any) => s.id === mine.id)).toBe(false);
    const bobChat = await fx.newChat(bob);
    fx.mock.push({ text: ['x'] });
    expect((await bob.post(`/api/chats/${bobChat}/completions`, { parentId: null, modelIds: ['mock/gpt-test'], content: 'Hi', styleId: mine.id })).statusCode).toBe(400);

    // Shared with him: he sees and uses it, but can't change it
    expect((await fx.admin.put(`/api/styles/${mine.id}/access`, { grants: [{ principalType: 'user', principalId: bobId, perm: 'read' }] })).statusCode).toBe(200);
    const shared = (await bob.get('/api/styles')).json().styles.find((s: any) => s.id === mine.id);
    expect(shared).toMatchObject({ scope: 'shared', ownerName: 'admin', canEdit: false });
    expect((await ask(fx, bob, bobChat, { styleId: mine.id })).system).toContain('Talk like a pirate.');
    expect((await bob.patch(`/api/styles/${mine.id}`, { name: 'Mine now' })).statusCode).toBe(403);

    // For everyone: only admins make them, everyone sees them
    expect((await bob.post('/api/styles', { name: 'Ours', instructions: 'x', everyone: true })).statusCode).toBe(403);
    const ours = (await fx.admin.post('/api/styles', { name: 'House style', instructions: 'Use British spelling.', everyone: true })).json().style;
    expect((await bob.get('/api/styles')).json().styles.find((s: any) => s.id === ours.id)).toMatchObject({ scope: 'everyone', canEdit: false });
    expect((await bob.delete(`/api/styles/${ours.id}`)).statusCode).toBe(403);
    expect((await fx.admin.delete(`/api/styles/${mine.id}`)).statusCode).toBe(200);
    expect((await bob.get('/api/styles')).json().styles.some((s: any) => s.id === mine.id)).toBe(false);
  });

  it('writes a style from a sample', async () => {
    const fx = await setup();
    fx.mock.completions.push({ content: '{"name":"Warm & brief","description":"Friendly and short","instructions":"Use a warm tone. Keep replies under five sentences."}' });
    const res = await fx.admin.post('/api/styles/generate', { samples: 'Hey! Quick note: all good here. Talk soon :)' });
    expect(res.json()).toEqual({ name: 'Warm & brief', description: 'Friendly and short', instructions: 'Use a warm tone. Keep replies under five sentences.' });
    const prompt = fx.mock.requests.filter((r) => !r.stream).at(-1);
    expect(prompt.messages[1].content).toContain('Quick note');
    expect((await fx.admin.post('/api/styles/generate', {})).statusCode).toBe(400);
  });
});

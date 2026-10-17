import { describe, it, expect, afterEach } from 'vitest';
import { chatFixture, type ChatFixture } from '../../test/chat-fixture';

let f: ChatFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

describe('skills', () => {
  it('lists built-ins and lets each user keep their own', async () => {
    f = await chatFixture();
    const bob = await f.newUser('bob@example.com');
    const builtins = (await bob.get('/api/skills')).json().skills;
    expect(builtins.length).toBeGreaterThan(0);
    expect(builtins.every((s: any) => s.builtin)).toBe(true);

    const created = await f.admin.post('/api/skills', { id: 'standup', name: 'Standup', description: 'Daily', body: 'Write a standup about {{args}}' });
    expect(created.statusCode).toBe(201);
    expect(created.json().skill).toMatchObject({ id: 'standup', builtin: false });

    // Private to its owner
    expect((await bob.get('/api/skills')).json().skills.some((s: any) => s.id === 'standup')).toBe(false);
    expect((await bob.get('/api/skills/standup')).statusCode).toBe(404);
    expect((await bob.delete('/api/skills/standup')).statusCode).toBe(404);
    // Bob may use the same name for his own
    expect((await bob.post('/api/skills', { id: 'standup', name: 'Mine', body: 'b' })).statusCode).toBe(201);

    const updated = await f.admin.put('/api/skills/standup', { name: 'Standup 2', body: 'New body' });
    expect(updated.json().skill).toMatchObject({ name: 'Standup 2', body: 'New body' });
    expect((await f.admin.post('/api/skills', { id: 'standup', name: 'Dup', body: 'b' })).json().error.code).toBe('skill_exists');
    expect((await f.admin.delete('/api/skills/standup')).statusCode).toBe(200);
  });

  it('protects built-ins and validates names', async () => {
    f = await chatFixture();
    const builtin = (await f.admin.get('/api/skills')).json().skills[0].id;
    expect((await f.admin.post('/api/skills', { id: builtin, name: 'X', body: 'b' })).json().error.code).toBe('skill_builtin');
    expect((await f.admin.delete(`/api/skills/${builtin}`)).json().error.code).toBe('skill_builtin');
    expect((await f.admin.post('/api/skills', { id: 'Bad Name', name: 'X', body: 'b' })).statusCode).toBe(400);
  });

  it('sends an invoked skill as a system prompt after the global one', async () => {
    f = await chatFixture();
    await f.admin.patch('/api/me/settings', { preferences: { systemPrompt: 'Be brief.' } });
    await f.admin.post('/api/skills', { id: 'pirate', name: 'Pirate', body: 'Talk like a pirate about {{args}}' });
    f.mock.push({ text: ['Arr'] });
    const chatId = await f.newChat(f.admin);
    const start = await f.admin.post(`/api/chats/${chatId}/completions`, {
      parentId: null,
      modelIds: ['mock/gpt-test'],
      content: 'the sea',
      skill: { id: 'pirate', args: 'the sea' },
    });
    expect(start.statusCode).toBe(202);
    await f.readRun(f.admin, start.json().runId);
    expect(f.mock.requests.find((r) => r.stream)!.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'system', content: 'Talk like a pirate about the sea' },
      { role: 'user', content: 'the sea' },
    ]);

    const missing = await f.admin.post(`/api/chats/${chatId}/completions`, {
      parentId: null,
      modelIds: ['mock/gpt-test'],
      content: 'x',
      skill: { id: 'nope', args: '' },
    });
    expect(missing.json().error.code).toBe('skill_not_found');
  });
});

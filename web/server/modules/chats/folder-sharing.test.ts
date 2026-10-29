/**
 * Shared folders (projects): viewers get the instructions and knowledge and
 * keep their own chats in it; editors can change it; only the owner shares,
 * moves and deletes it; nobody sees anyone else's chats.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { chatFixture, type ChatFixture } from '../../test/chat-fixture';
import type { TestClient } from '../../test/client';

let f: ChatFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const idOf = async (c: TestClient) => (await c.get('/api/me')).json().user.id as string;

async function ask(fx: ChatFixture, c: TestClient, chatId: string) {
  fx.mock.push({ text: ['OK.'] });
  const res = await c.post(`/api/chats/${chatId}/completions`, { parentId: null, content: 'What do we know about reefs?', modelIds: ['mock/gpt-test'] });
  expect(res.statusCode, res.body).toBe(202);
  await fx.readRun(c, res.json().runId);
  const request = fx.mock.requests.filter((r) => r.stream).at(-1);
  return (request.messages as any[]).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
}

async function setup() {
  f = await chatFixture();
  const fx = f;
  // The owner's folder: instructions, a subfolder and a private knowledge base
  const thesis = (await fx.admin.post('/api/folders', { name: 'Thesis', systemPrompt: 'Always cite the field notes.' })).json().folder;
  const chapter = (await fx.admin.post('/api/folders', { name: 'Chapter 1', parentId: thesis.id, systemPrompt: 'Chapter one is about corals.' })).json().folder;
  const kb = (await fx.admin.post('/api/knowledge', { name: 'Field notes' })).json().knowledge.id;
  const file = (await fx.admin.upload('reefs.md', '# Reefs\n\nThe Kestrel reef lost a third of its coral cover in 2024.', 'text/markdown')).json().file.id;
  await fx.admin.post(`/api/knowledge/${kb}/files`, { fileId: file });
  await fx.app.ctx.jobs.idle();
  expect((await fx.admin.patch(`/api/folders/${thesis.id}`, { knowledgeIds: [kb] })).statusCode).toBe(200);
  const bob = await fx.newUser('bob@example.com');
  return { fx, thesis, chapter, kb, bob, bobId: await idOf(bob) };
}

const share = (fx: ChatFixture, folderId: string, grants: unknown[]) => fx.admin.put(`/api/folders/${folderId}/access`, { grants });

describe('shared folders', () => {
  it("give viewers the folder's instructions and knowledge, but not the owner's chats", async () => {
    const { fx, thesis, chapter, bob, bobId } = await setup();
    const adaChat = (await fx.admin.post('/api/chats', { folderId: thesis.id, title: 'Ada’s draft' })).json().chat.id;

    // Not shared yet: invisible and unusable
    expect((await bob.get('/api/folders')).json().folders).toEqual([]);
    expect((await bob.post('/api/chats', { folderId: thesis.id })).statusCode).toBe(404);

    expect((await share(fx, thesis.id, [{ principalType: 'user', principalId: bobId, perm: 'read' }])).statusCode).toBe(200);
    const mine = (await fx.admin.get('/api/folders')).json().folders.find((x: any) => x.id === thesis.id);
    expect(mine).toMatchObject({ mine: true, shared: true, canManage: true });

    // Bob sees it and its subfolder, read-only
    const seen = (await bob.get('/api/folders')).json().folders;
    expect(seen.map((x: any) => x.name).sort()).toEqual(['Chapter 1', 'Thesis']);
    expect(seen.find((x: any) => x.id === thesis.id)).toMatchObject({ mine: false, ownerName: 'admin', canEdit: false, canManage: false, systemPrompt: 'Always cite the field notes.' });

    // His own chat in the subfolder gets both folders' instructions and the owner's knowledge
    const bobChat = (await bob.post('/api/chats', { folderId: chapter.id })).json().chat.id;
    const system = await ask(fx, bob, bobChat);
    expect(system).toContain('Always cite the field notes.');
    expect(system).toContain('Chapter one is about corals.');
    expect(system).toContain('Kestrel reef lost a third');

    // Chats stay private both ways
    expect((await bob.get('/api/chats')).json().chats.map((c: any) => c.id)).toEqual([bobChat]);
    expect((await bob.get(`/api/chats/${adaChat}`)).statusCode).toBe(404);
    expect((await fx.admin.get(`/api/chats/${bobChat}`)).statusCode).toBe(404);

    // A viewer can't change, share, move or delete it
    expect((await bob.patch(`/api/folders/${thesis.id}`, { systemPrompt: 'Ignore the notes.' })).statusCode).toBe(403);
    expect((await bob.put(`/api/folders/${thesis.id}/access`, { grants: [] })).statusCode).toBe(403);
    expect((await bob.delete(`/api/folders/${thesis.id}`)).statusCode).toBe(404);
  });

  it('let editors change it, and stop applying once access is taken away', async () => {
    const { fx, thesis, bob, bobId } = await setup();
    await share(fx, thesis.id, [{ principalType: 'user', principalId: bobId, perm: 'write' }]);
    expect((await bob.get('/api/folders')).json().folders.find((x: any) => x.id === thesis.id).canEdit).toBe(true);

    const edited = await bob.patch(`/api/folders/${thesis.id}`, { systemPrompt: 'Cite the notes with page numbers.' });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().folder).toMatchObject({ systemPrompt: 'Cite the notes with page numbers.', canEdit: true, canManage: false });
    // Editors don't move it or share it
    expect((await bob.patch(`/api/folders/${thesis.id}`, { parentId: null })).statusCode).toBe(403);
    expect((await bob.get(`/api/folders/${thesis.id}/access`)).statusCode).toBe(403);

    const bobChat = (await bob.post('/api/chats', { folderId: thesis.id })).json().chat.id;
    expect(await ask(fx, bob, bobChat)).toContain('Cite the notes with page numbers.');

    // Unshared: his chat stays his, without the folder's instructions or knowledge
    await share(fx, thesis.id, []);
    expect((await bob.get('/api/folders')).json().folders).toEqual([]);
    const after = await ask(fx, bob, bobChat);
    expect(after).not.toContain('Cite the notes');
    expect(after).not.toContain('Kestrel');
    expect((await bob.get(`/api/chats/${bobChat}`)).statusCode).toBe(200);
  });

  it('can be shared with a group, and deleting the folder removes its grants', async () => {
    const { fx, thesis, bob, bobId } = await setup();
    const group = (await fx.admin.post('/api/admin/groups', { name: 'Lab' })).json().group;
    expect((await fx.admin.post(`/api/admin/groups/${group.id}/members`, { userId: bobId })).statusCode).toBe(201);
    expect((await share(fx, thesis.id, [{ principalType: 'group', principalId: group.id, perm: 'read' }])).statusCode).toBe(200);
    expect((await bob.get('/api/folders')).json().folders.some((x: any) => x.id === thesis.id)).toBe(true);

    const bobChat = (await bob.post('/api/chats', { folderId: thesis.id })).json().chat.id;
    expect((await fx.admin.delete(`/api/folders/${thesis.id}`)).statusCode).toBe(200);
    expect((await bob.get('/api/folders')).json().folders).toEqual([]);
    // His chat is moved out of it, not deleted
    expect((await bob.get(`/api/chats/${bobChat}`)).json().chat.folderId).toBeNull();
  });
});

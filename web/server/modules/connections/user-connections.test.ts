/**
 * Personal LLM connections: off unless the admin allows them, private to their
 * owner, and every request goes through the SSRF guard.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { chatFixture, type ChatFixture } from '../../test/chat-fixture';
import { DEFAULT_PERMISSIONS } from '../../../shared/access';

let f: ChatFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const input = (fx: ChatFixture) => ({
  name: 'Mine',
  prefix: 'mine',
  type: 'openai',
  baseUrl: fx.mock.url,
  apiKey: 'sk-personal-key-9876',
});

describe('user connections', () => {
  it('are refused until the admin allows them', async () => {
    f = await chatFixture();
    const bob = await f.newUser('bob@example.com');
    expect((await bob.get('/api/connections')).json()).toEqual({ enabled: false, connections: [] });
    const res = await bob.post('/api/connections', input(f));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('user_connections_disabled');
  });

  it("can't reach private addresses unless the admin lists them", async () => {
    f = await chatFixture();
    await f.admin.patch('/api/admin/settings/permissions.default', { ...DEFAULT_PERMISSIONS, 'connections.own': true });
    const bob = await f.newUser('bob@example.com');

    // The mock endpoint is on 127.0.0.1: blocked for users (the admin's own connection to it still works)
    const before = f.mock.headers.length;
    const created = await bob.post('/api/connections', input(f));
    expect(created.statusCode).toBe(201);
    const conn = created.json().connection;
    // (OpenAI-compatible endpoints without a model list are normal, so no error is shown)
    expect(conn).toMatchObject({ prefix: 'mine', hasKey: true, keyLast4: '9876', modelCount: 0 });
    expect(created.body).not.toContain('sk-personal-key');
    expect(f.mock.headers.length).toBe(before);
    const chatId = await f.newChat(bob);
    const blocked = await bob.post(`/api/chats/${chatId}/completions`, {
      parentId: null,
      modelIds: ['@mine/gpt-test'],
      content: 'Hello',
    });
    expect(blocked.statusCode).toBe(404);
    expect(f.mock.headers.length).toBe(before);

    await f.admin.patch('/api/admin/settings/net.allowlist', { hosts: ['127.0.0.1'] });
    const test = await bob.post(`/api/connections/${conn.id}/test`);
    expect(test.json()).toMatchObject({ ok: true, error: null, models: ['@mine/gpt-test', '@mine/gpt-other'] });

    const models = (await bob.get('/api/models')).json().models;
    expect(models.find((m: any) => m.id === '@mine/gpt-test')).toMatchObject({ own: true, connectionName: 'Mine' });
  });

  it('serve only their owner', async () => {
    f = await chatFixture();
    await f.admin.patch('/api/admin/settings/permissions.default', { ...DEFAULT_PERMISSIONS, 'connections.own': true });
    await f.admin.patch('/api/admin/settings/net.allowlist', { hosts: ['127.0.0.1'] });
    const bob = await f.newUser('bob@example.com');
    const carol = await f.newUser('carol@example.com');
    const conn = (await bob.post('/api/connections', input(f))).json().connection;

    f.mock.push({ text: ['Hi Bob'] });
    const bobChat = await f.newChat(bob);
    const start = await bob.post(`/api/chats/${bobChat}/completions`, {
      parentId: null,
      modelIds: ['@mine/gpt-test'],
      content: 'Hello',
    });
    expect(start.statusCode).toBe(202);
    await f.readRun(bob, start.json().runId);
    const req = f.mock.requests.find((r) => r.stream)!;
    expect(req.model).toBe('gpt-test');
    expect(f.mock.headers.at(-1)?.authorization).toBe('Bearer sk-personal-key-9876');

    // Carol sees none of it
    expect((await carol.get('/api/connections')).json().connections).toEqual([]);
    expect((await carol.get('/api/models')).json().models.some((m: any) => m.own)).toBe(false);
    const carolChat = await f.newChat(carol);
    const denied = await carol.post(`/api/chats/${carolChat}/completions`, {
      parentId: null,
      modelIds: ['@mine/gpt-test'],
      content: 'Hello',
    });
    expect(denied.statusCode).toBe(404);
    expect((await carol.patch(`/api/connections/${conn.id}`, { name: 'x' })).statusCode).toBe(404);
    expect((await carol.delete(`/api/connections/${conn.id}`)).statusCode).toBe(404);
    // Nor do admins' connection routes touch it
    expect((await f.admin.patch(`/api/admin/connections/${conn.id}`, { name: 'x' })).statusCode).toBe(404);

    // Switching the feature off hides the models but lets Bob delete his key
    await f.admin.patch('/api/admin/settings/permissions.default', DEFAULT_PERMISSIONS);
    expect((await bob.get('/api/models')).json().models.some((m: any) => m.own)).toBe(false);
    expect((await bob.delete(`/api/connections/${conn.id}`)).statusCode).toBe(200);
  });

  it('validate the endpoint URL', async () => {
    f = await chatFixture();
    await f.admin.patch('/api/admin/settings/permissions.default', { ...DEFAULT_PERMISSIONS, 'connections.own': true });
    for (const baseUrl of ['', 'file:///etc/passwd', 'http://user:pw@example.com/v1']) {
      const res = await f.admin.post('/api/connections', { ...input(f), baseUrl });
      expect(res.statusCode, baseUrl).toBe(400);
      expect(res.json().error.code).toBe('invalid_base_url');
    }
  });
});

/**
 * Phase 3 workspace: custom models in chats, the prompt library, memory and
 * usage caps.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { chatFixture, DIAGRAMS, type ChatFixture } from '../../test/chat-fixture';
import { startMockMcp, type MockMcp } from '../../test/mock-mcp';
import type { TestClient } from '../../test/client';
import { DEFAULT_PERMISSIONS } from '../../../shared/access';

let f: ChatFixture | undefined;
let mcp: MockMcp | undefined;
afterEach(async () => {
  await f?.close();
  await mcp?.close();
  f = undefined;
  mcp = undefined;
});

async function ask(fx: ChatFixture, c: TestClient, model: string, content = 'Hello', extra: Record<string, unknown> = {}) {
  const chat = (await c.post('/api/chats', {})).json().chat.id;
  const res = await c.post(`/api/chats/${chat}/completions`, { parentId: null, content, modelIds: [model], ...extra });
  if (res.statusCode === 202) await fx.readRun(c, res.json().runId);
  return res;
}

const lastStream = (fx: ChatFixture) => fx.mock.requests.filter((r) => r.stream).at(-1);
const userIdOf = async (c: TestClient) => (await c.get('/api/me')).json().user.id as string;

describe('custom models', () => {
  it('answer with their system prompt and parameters on the base model', async () => {
    f = await chatFixture();
    const created = await f.admin.post('/api/workspace/models', {
      name: 'Pirate',
      description: 'Talks like a pirate',
      baseModelId: 'mock/gpt-test',
      systemPrompt: 'You are a pirate. The user is {{USER_NAME}}.',
      params: { temperature: 0.2, maxTokens: 321 },
      suggestions: ['Tell me a sea story'],
    });
    expect(created.statusCode).toBe(201);
    const model = created.json().model;
    expect(model.key).toBe(`custom/${model.id}`);

    const listed = (await f.admin.get('/api/models')).json().models.find((m: any) => m.id === model.key);
    expect(listed).toMatchObject({ name: 'Pirate', custom: true, description: 'Talks like a pirate', suggestions: ['Tell me a sea story'] });

    f.mock.push({ text: ['Arr.'] });
    expect((await ask(f, f.admin, model.key)).statusCode).toBe(202);
    const req = lastStream(f);
    expect(req.model).toBe('gpt-test');
    expect(req.temperature).toBe(0.2);
    expect(req.max_tokens).toBe(321);
    expect(req.messages.slice(0, 2)).toEqual([DIAGRAMS, { role: 'system', content: 'You are a pirate. The user is admin.' }]);

    // A per-message temperature still wins
    f.mock.push({ text: ['Arr.'] });
    await ask(f, f.admin, model.key, 'Again', { params: { temperature: 0.9 } });
    expect(lastStream(f).temperature).toBe(0.9);
  });

  it('run with their owner’s model access, and stop when the owner loses it', async () => {
    f = await chatFixture();
    await f.admin.patch('/api/admin/settings/permissions.default', { ...DEFAULT_PERMISSIONS, 'workspace.models': true });
    const bob = await f.newUser('bob@example.com');
    const carol = await f.newUser('carol@example.com');
    const carolId = await userIdOf(carol);

    // Bob builds on gpt-test and shares with Carol
    const m = (await bob.post('/api/workspace/models', { name: 'Helper', baseModelId: 'mock/gpt-test' })).json().model;
    await bob.put(`/api/workspace/models/${m.id}/access`, { grants: [{ principalType: 'user', principalId: carolId, perm: 'read' }] });

    // Carol may not use gpt-test herself, but may use Bob's model
    await f.admin.patch('/api/admin/settings/models.allowlist', { user: ['mock/gpt-other'] });
    const bobModels = async () => ((await bob.get('/api/models')).json().models as any[]).map((x) => x.id);
    const carolModels = async () => ((await carol.get('/api/models')).json().models as any[]).map((x) => x.id);
    expect(await carolModels()).not.toContain('mock/gpt-test');
    // ...except Bob can't use gpt-test now either, so the model is gone for both
    expect(await bobModels()).not.toContain(m.key);
    expect(await carolModels()).not.toContain(m.key);
    const refused = await ask(f, carol, m.key);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('base_model_unavailable');

    // An admin's model on gpt-test, shared with Carol, works for her
    const a = (await f.admin.post('/api/workspace/models', { name: 'Admin helper', baseModelId: 'mock/gpt-test' })).json().model;
    await f.admin.put(`/api/workspace/models/${a.id}/access`, { grants: [{ principalType: 'user', principalId: carolId, perm: 'read' }] });
    expect(await carolModels()).toContain(a.key);
    f.mock.push({ text: ['Hi Carol.'] });
    expect((await ask(f, carol, a.key)).statusCode).toBe(202);
    expect(lastStream(f).model).toBe('gpt-test');

    // Turned off: hidden and refused
    await f.admin.patch(`/api/workspace/models/${a.id}`, { active: false });
    expect(await carolModels()).not.toContain(a.key);
    expect((await ask(f, carol, a.key)).statusCode).toBe(403);
  });

  it('must be built on a global model the editor can use', async () => {
    f = await chatFixture();
    const first = (await f.admin.post('/api/workspace/models', { name: 'One', baseModelId: 'mock/gpt-test' })).json().model;
    for (const baseModelId of [first.key, '@own/x', 'mock/nope']) {
      const res = await f.admin.post('/api/workspace/models', { name: 'Two', baseModelId });
      expect(res.statusCode, baseModelId).toBe(400);
    }
    // A partial update keeps everything else
    const patched = await f.admin.patch(`/api/workspace/models/${first.id}`, { description: 'New' });
    expect(patched.json().model).toMatchObject({ name: 'One', baseModelId: 'mock/gpt-test', description: 'New', active: true });
  });

  it('switch their tools on even when the user turned them off', async () => {
    f = await chatFixture();
    mcp = await startMockMcp();
    const server = (await f.admin.post('/api/admin/mcp-servers', { name: 'Mock', transport: 'streamable-http', url: mcp.url })).json()
      .server;
    await f.admin.post(`/api/mcp/servers/${server.id}/disable`);
    const m = (await f.admin.post('/api/workspace/models', { name: 'Tooled', baseModelId: 'mock/gpt-test', toolIds: [server.id] })).json()
      .model;

    f.mock.push({ text: ['Plain.'] });
    await ask(f, f.admin, 'mock/gpt-test');
    expect(lastStream(f).tools).toBeUndefined();

    f.mock.push({ text: ['With tools.'] });
    await ask(f, f.admin, m.key);
    expect(lastStream(f).tools.map((t: any) => t.function.name)).toContain('echo');
  });
});

describe('prompt library', () => {
  it('stores variables and keeps commands apart from skills', async () => {
    f = await chatFixture();
    const res = await f.admin.post('/api/workspace/prompts', {
      command: 'email',
      title: 'Email',
      body: 'Write to {{name}} about {{topic:the meeting}} on {{CURRENT_DATE}}.',
    });
    expect(res.statusCode).toBe(201);
    const p = res.json().prompt;
    expect(p.variables).toEqual([
      { name: 'name', default: '' },
      { name: 'topic', default: 'the meeting' },
    ]);

    expect((await f.admin.post('/api/workspace/prompts', { command: 'email', title: 'Again', body: 'x' })).statusCode).toBe(409);
    await f.admin.post('/api/skills', { id: 'tone', name: 'Tone', body: 'Be nice.' });
    const clash = await f.admin.post('/api/workspace/prompts', { command: 'tone', title: 'Tone', body: 'x' });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.message).toContain('skill');

    // Prompts aren't skills: /email can't be sent as a skill
    expect((await f.admin.get('/api/skills')).json().skills.some((s: any) => s.id === 'email')).toBe(false);

    const patched = await f.admin.patch(`/api/workspace/prompts/${p.id}`, { title: 'E-mail' });
    expect(patched.json().prompt).toMatchObject({ title: 'E-mail', command: 'email', body: p.body });
  });
});

describe('memory', () => {
  it('is added to chats unless switched off', async () => {
    f = await chatFixture();
    expect((await f.admin.post('/api/me/memories', { content: 'My name is Ada and I write Rust.' })).statusCode).toBe(201);
    const other = await f.newUser('bob@example.com');
    await other.post('/api/me/memories', { content: 'Bob likes tea.' });

    f.mock.push({ text: ['Hi Ada.'] });
    await ask(f, f.admin, 'mock/gpt-test');
    const system = lastStream(f)
      .messages.filter((m: any) => m.role === 'system')
      .map((m: any) => m.content)
      .join('\n');
    expect(system).toContain('My name is Ada and I write Rust.');
    expect(system).not.toContain('Bob likes tea.');

    await f.admin.patch('/api/me/settings', { memory: { enabled: false } });
    f.mock.push({ text: ['Hi.'] });
    await ask(f, f.admin, 'mock/gpt-test');
    expect(JSON.stringify(lastStream(f).messages)).not.toContain('Ada');

    // Editing and deleting are the owner's only
    const list = (await f.admin.get('/api/me/memories')).json().memories;
    expect(list).toHaveLength(1);
    expect((await other.delete(`/api/me/memories/${list[0].id}`)).statusCode).toBe(404);
    expect((await f.admin.patch(`/api/me/memories/${list[0].id}`, { content: 'Ada writes Go now.' })).statusCode).toBe(200);
    expect((await f.admin.delete('/api/me/memories')).statusCode).toBe(200);
    expect((await f.admin.get('/api/me/memories')).json().memories).toEqual([]);
  });
});

describe('usage caps', () => {
  it('refuse new requests once a cap is reached; groups raise caps, overrides win', async () => {
    f = await chatFixture();
    const bob = await f.newUser('bob@example.com');
    const bobId = await userIdOf(bob);
    await f.admin.patch('/api/admin/settings/caps.default', { tokensPerDay: 30, tokensPerMonth: null, costPerDay: null, costPerMonth: null });
    const usage = { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 };

    f.mock.push({ text: ['One.'], usage });
    expect((await ask(f, bob, 'mock/gpt-test')).statusCode).toBe(202);
    f.mock.push({ text: ['Two.'], usage });
    expect((await ask(f, bob, 'mock/gpt-test')).statusCode).toBe(202);
    const capped = await ask(f, bob, 'mock/gpt-test');
    expect(capped.statusCode).toBe(429);
    expect(capped.json().error.code).toBe('usage_cap');
    expect(capped.json().error.message).toContain('40 of 30');
    expect((await bob.post('/api/llm/complete', { model: 'mock/gpt-test', messages: [{ role: 'user', content: 'x' }] })).statusCode).toBe(429);

    const summary = (await bob.get('/api/me/usage')).json().usage;
    expect(summary).toMatchObject({ day: { tokens: 40 }, month: { tokens: 40 }, caps: { tokensPerDay: 30 } });

    // A group with a higher cap lifts it
    const g = (await f.admin.post('/api/admin/groups', { name: 'Heavy', caps: { tokensPerDay: 1000 } })).json().group;
    await f.admin.post(`/api/admin/groups/${g.id}/members`, { userId: bobId });
    f.mock.push({ text: ['Three.'], usage });
    expect((await ask(f, bob, 'mock/gpt-test')).statusCode).toBe(202);

    // An override wins over both
    await f.admin.patch(`/api/admin/users/${bobId}`, { caps: { tokensPerDay: 10 } });
    expect((await ask(f, bob, 'mock/gpt-test')).statusCode).toBe(429);
    const detail = (await f.admin.get(`/api/admin/users/${bobId}/access`)).json();
    expect(detail).toMatchObject({ caps: { tokensPerDay: 10 }, usage: { day: { tokens: 60 } }, groups: [{ name: 'Heavy', source: 'manual' }] });
    await f.admin.patch(`/api/admin/users/${bobId}`, { caps: { tokensPerDay: null } });
    f.mock.push({ text: ['Four.'] });
    expect((await ask(f, bob, 'mock/gpt-test')).statusCode).toBe(202);

    // Admins are never capped
    await f.admin.patch('/api/admin/settings/caps.default', { tokensPerDay: 1, tokensPerMonth: null, costPerDay: null, costPerMonth: null });
    f.mock.push({ text: ['Admin.'], usage });
    expect((await ask(f, f.admin, 'mock/gpt-test')).statusCode).toBe(202);
  });

  it('caps known costs per month', async () => {
    f = await chatFixture();
    const bob = await f.newUser('bob@example.com');
    await f.admin.patch('/api/admin/settings/caps.default', { tokensPerDay: null, tokensPerMonth: null, costPerDay: null, costPerMonth: 0.05 });
    f.mock.push({ text: ['Costly.'], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.06 } as any });
    expect((await ask(f, bob, 'mock/gpt-test')).statusCode).toBe(202);
    const capped = await ask(f, bob, 'mock/gpt-test');
    expect(capped.statusCode).toBe(429);
    expect(capped.json().error.message).toContain('$0.06 of $0.05');
  });
});

/**
 * The Phase 3 permission matrix, table-driven:
 *  1. every permission key × (admin, plain user, user whose group grants it,
 *     pending user) against the route it guards;
 *  2. workspace items (custom models, prompts) × grant × actor × action.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chatFixture, type ChatFixture } from '../test/chat-fixture';
import { TestClient } from '../test/client';
import { PERMISSION_KEYS, type PermissionKey } from '../../shared/access';
import { MEDIA_DEFAULTS } from '../media/config';

let f: ChatFixture;
let admin: TestClient;
let member: TestClient; // in "Team"
let outsider: TestClient; // in no group
let pending: TestClient;
let ids: Record<'member' | 'outsider', string>;
let teamId: string;

const NONE = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, false])) as Record<PermissionKey, boolean>;

beforeAll(async () => {
  // A sandbox origin, so the code interpreter is available
  f = await chatFixture({ env: { CLAUDIA_PUBLIC_URL: 'http://app.example.test', CLAUDIA_SANDBOX_ORIGIN: 'http://sandbox.example.test' } });
  admin = f.admin;
  member = await f.newUser('member@example.com');
  outsider = await f.newUser('outsider@example.com');
  pending = new TestClient(f.app);
  await pending.signup('pending@example.com');
  const users = (await admin.get('/api/admin/users')).json().users as Array<{ id: string; email: string }>;
  ids = {
    member: users.find((u) => u.email === 'member@example.com')!.id,
    outsider: users.find((u) => u.email === 'outsider@example.com')!.id,
  };
  // A search engine is set up (nothing listens there: searching fails inside the run, not the request)
  expect((await admin.put('/api/admin/rag', { webSearch: { engine: 'searxng', baseUrl: 'http://127.0.0.1:9', cx: '', resultCount: 3, fetchPages: false } })).statusCode).toBe(200);
  // Image generation and read-aloud through the mock
  expect(
    (
      await admin.put('/api/admin/media', {
        image: { ...MEDIA_DEFAULTS.image, engine: 'openai', baseUrl: f.mock.url },
        tts: { ...MEDIA_DEFAULTS.tts, engine: 'openai', baseUrl: f.mock.url },
      })
    ).statusCode
  ).toBe(200);
  const team = await admin.post('/api/admin/groups', { name: 'Team' });
  expect(team.statusCode).toBe(201);
  teamId = team.json().group.id;
  expect((await admin.post(`/api/admin/groups/${teamId}/members`, { userId: ids.member })).statusCode).toBe(201);
}, 60_000);

afterAll(async () => {
  await f?.close();
});

/** Set the defaults and what Team grants. */
async function configure(defaults: Partial<Record<PermissionKey, boolean>>, team: Partial<Record<PermissionKey, boolean>>) {
  expect((await admin.patch('/api/admin/settings/permissions.default', { ...NONE, ...defaults })).statusCode).toBe(200);
  expect((await admin.patch(`/api/admin/groups/${teamId}`, { permissions: team })).statusCode).toBe(200);
}

/** One request that the permission guards; returns its status. */
const attempts: Record<PermissionKey, (c: TestClient) => Promise<number>> = {
  'chat.share': async (c) => {
    const chat = await c.post('/api/chats', {});
    if (chat.statusCode !== 201) return chat.statusCode;
    return (await c.post(`/api/chats/${chat.json().chat.id}/share`)).statusCode;
  },
  'chat.export': async (c) => (await c.get('/api/chats/export')).statusCode,
  'chat.temporary': async (c) => (await c.post('/api/chats', { temporary: true })).statusCode,
  'workspace.models': async (c) =>
    (await c.post('/api/workspace/models', { name: `M ${Math.random()}`, baseModelId: 'mock/gpt-test' })).statusCode,
  'workspace.prompts': async (c) =>
    (await c.post('/api/workspace/prompts', { command: `p-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, title: 'P', body: 'x' }))
      .statusCode,
  'workspace.share_public': async (c) => {
    // Prompts are allowed for everyone in this test; sharing one publicly is what's guarded
    const p = await c.post('/api/workspace/prompts', { command: `pub-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, title: 'P', body: 'x' });
    if (p.statusCode !== 201) return p.statusCode;
    return (await c.put(`/api/workspace/prompts/${p.json().prompt.id}/access`, { grants: [{ principalType: 'public', perm: 'read' }] }))
      .statusCode;
  },
  'mcp.user_servers': async (c) =>
    (await c.post('/api/mcp/own', { name: 'Mine', transport: 'streamable-http', url: 'https://mcp.example.com/mcp' })).statusCode,
  'connections.own': async (c) =>
    (await c.post('/api/connections', { name: 'Own', prefix: `own${Math.floor(Math.random() * 1e6)}`, type: 'openai', baseUrl: 'https://api.example.com/v1' }))
      .statusCode,
  'api.keys': async (c) => (await c.post('/api/me/api-keys', { name: 'k' })).statusCode,
  'workspace.knowledge': async (c) => (await c.post('/api/knowledge', { name: `KB ${Math.random()}` })).statusCode,
  'features.web_search': async (c) => {
    const chat = await c.post('/api/chats', {});
    if (chat.statusCode !== 201) return chat.statusCode;
    return (
      await c.post(`/api/chats/${chat.json().chat.id}/completions`, {
        parentId: null,
        content: 'Search this',
        modelIds: ['mock/gpt-test'],
        features: { webSearch: true },
      })
    ).statusCode;
  },
  'features.code': async (c) => completion(c, { code: true }),
  'features.image_gen': async (c) => completion(c, { imageGen: true }),
  'features.voice': async (c) => (await c.post('/api/audio/speech', { text: 'Hi' })).statusCode,
};

async function completion(c: TestClient, features: Record<string, boolean>): Promise<number> {
  const chat = await c.post('/api/chats', {});
  if (chat.statusCode !== 201) return chat.statusCode;
  return (await c.post(`/api/chats/${chat.json().chat.id}/completions`, { parentId: null, content: 'x', modelIds: ['mock/gpt-test'], features })).statusCode;
}

/** What each principal should get: allowed, or refused with 403. */
const ACTORS = [
  { name: 'admin', client: () => admin, inGroup: false, admin: true },
  { name: 'member of a granting group', client: () => member, inGroup: true, admin: false },
  { name: 'user without the permission', client: () => outsider, inGroup: false, admin: false },
  { name: 'pending user', client: () => pending, inGroup: false, admin: false, pending: true },
] as const;

describe('permission matrix: key × actor', () => {
  for (const key of PERMISSION_KEYS) {
    describe(key, () => {
      for (const actor of ACTORS) {
        const allowed = actor.admin || actor.inGroup;
        it(`${actor.name} → ${allowed ? 'allowed' : 'refused'}`, async () => {
          // Off by default; Team grants it (share_public also needs prompts, which everyone has here)
          await configure(key === 'workspace.share_public' ? { 'workspace.prompts': true } : {}, { [key]: true });
          const status = await attempts[key](actor.client());
          if (allowed) expect(status, `${key} for ${actor.name}`).toBeLessThan(300);
          else expect(status, `${key} for ${actor.name}`).toBe(403);
        });
      }

      it('defaults switch it on for every user, not for pending ones', async () => {
        await configure({ ...(key === 'workspace.share_public' ? { 'workspace.prompts': true } : {}), [key]: true }, {});
        expect(await attempts[key](outsider)).toBeLessThan(300);
        expect(await attempts[key](pending)).toBe(403);
      });
    });
  }

  it('reports effective permissions in the session', async () => {
    await configure({ 'chat.share': true }, { 'api.keys': true });
    const perms = async (c: TestClient) => (await c.get('/api/auth/session')).json().permissions;
    expect(await perms(member)).toMatchObject({ 'chat.share': true, 'api.keys': true, 'workspace.models': false });
    expect(await perms(outsider)).toMatchObject({ 'chat.share': true, 'api.keys': false });
    expect(Object.values(await perms(admin)).every(Boolean)).toBe(true);
    expect(Object.values(await perms(pending)).some(Boolean)).toBe(false);
    // Groups only add: a group can't switch off a default
    await admin.patch(`/api/admin/groups/${teamId}`, { permissions: { 'chat.share': false } });
    expect((await perms(member))['chat.share']).toBe(true);
  });
});

// ─── Workspace items ─────────────────────────────────────────────────────────

type Grant =
  | { principalType: 'public'; perm: 'read' }
  | { principalType: 'group' | 'user'; principalId: string; perm: 'read' | 'write' };

interface ItemCase {
  grant: string;
  grants: () => Grant[];
  /** Expected for [member, outsider]: n = none, r = use, w = use and edit. */
  expect: [member: 'n' | 'r' | 'w', outsider: 'n' | 'r' | 'w'];
}

const ITEM_CASES: ItemCase[] = [
  { grant: 'private', grants: () => [], expect: ['n', 'n'] },
  { grant: 'Team can use', grants: () => [{ principalType: 'group', principalId: teamId, perm: 'read' }], expect: ['r', 'n'] },
  { grant: 'Team can edit', grants: () => [{ principalType: 'group', principalId: teamId, perm: 'write' }], expect: ['w', 'n'] },
  { grant: 'outsider can use', grants: () => [{ principalType: 'user', principalId: ids.outsider, perm: 'read' }], expect: ['n', 'r'] },
  { grant: 'outsider can edit', grants: () => [{ principalType: 'user', principalId: ids.outsider, perm: 'write' }], expect: ['n', 'w'] },
  { grant: 'everyone can use', grants: () => [{ principalType: 'public', perm: 'read' }], expect: ['r', 'r'] },
];

const RESOURCES = [
  {
    type: 'model',
    base: '/api/workspace/models',
    create: (c: TestClient, name: string) => c.post('/api/workspace/models', { name, baseModelId: 'mock/gpt-test', systemPrompt: 'Be brief.' }),
    idOf: (res: any) => res.json().model.id as string,
    /** Can the actor use it: in their model list. */
    uses: async (c: TestClient, id: string) =>
      ((await c.get('/api/models')).json().models as Array<{ id: string }>).some((m) => m.id === `custom/${id}`),
    edit: (c: TestClient, id: string) => c.patch(`/api/workspace/models/${id}`, { description: 'edited' }),
  },
  {
    type: 'prompt',
    base: '/api/workspace/prompts',
    create: (c: TestClient, name: string) =>
      c.post('/api/workspace/prompts', { command: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), title: name, body: 'Hi {{who}}' }),
    idOf: (res: any) => res.json().prompt.id as string,
    /** Can the actor use it: in the composer's list. */
    uses: async (c: TestClient, id: string) =>
      ((await c.get('/api/workspace/prompts?scope=usable')).json().prompts as Array<{ id: string }>).some((p) => p.id === id),
    edit: (c: TestClient, id: string) => c.patch(`/api/workspace/prompts/${id}`, { description: 'edited' }),
  },
  {
    type: 'knowledge',
    base: '/api/knowledge',
    create: (c: TestClient, name: string) => c.post('/api/knowledge', { name }),
    idOf: (res: any) => res.json().knowledge.id as string,
    /** Can the actor use it: in their list (what the # menu offers). */
    uses: async (c: TestClient, id: string) =>
      ((await c.get('/api/knowledge')).json().knowledge as Array<{ id: string }>).some((k) => k.id === id),
    edit: (c: TestClient, id: string) => c.patch(`/api/knowledge/${id}`, { description: 'edited' }),
  },
] as const;

describe('permission matrix: workspace item × grant × actor', () => {
  for (const r of RESOURCES) {
    for (const c of ITEM_CASES) {
      it(`${r.type}, ${c.grant}`, async () => {
        await configure({ 'workspace.models': true, 'workspace.prompts': true, 'workspace.knowledge': true }, {});
        // The admin owns it (and may share with everyone)
        const created = await r.create(admin, `${r.type} ${c.grant} ${Date.now()}`);
        expect(created.statusCode).toBe(201);
        const id = r.idOf(created);
        expect((await admin.put(`${r.base}/${id}/access`, { grants: c.grants() })).statusCode).toBe(200);

        for (const [i, client] of [member, outsider].entries()) {
          const who = i === 0 ? 'member' : 'outsider';
          const want = c.expect[i];
          expect(await r.uses(client, id), `${who} uses`).toBe(want !== 'n');
          expect((await client.get(`${r.base}/${id}`)).statusCode, `${who} reads`).toBe(want === 'n' ? 404 : 200);
          const edit = (await r.edit(client, id)).statusCode;
          expect(edit, `${who} edits`).toBe(want === 'w' ? 200 : want === 'r' ? 403 : 404);
          // Only the owner (or an admin) manages access and deletes
          expect((await client.get(`${r.base}/${id}/access`)).statusCode, `${who} sees access`).toBe(want === 'n' ? 404 : 403);
          expect((await client.delete(`${r.base}/${id}`)).statusCode, `${who} deletes`).toBe(want === 'n' ? 404 : 403);
        }
        // Pending accounts reach no workspace at all
        expect((await pending.get(`${r.base}/${id}`)).statusCode).toBe(403);
        expect((await admin.delete(`${r.base}/${id}`)).statusCode).toBe(200);
        // Its grants go with it
        expect((await admin.get(`${r.base}/${id}/access`)).statusCode).toBe(404);
      });
    }

    it(`${r.type}: owners other than admins manage their own`, async () => {
      await configure({ 'workspace.models': true, 'workspace.prompts': true, 'workspace.knowledge': true }, {});
      const created = await r.create(member, `${r.type} by member ${Date.now()}`);
      expect(created.statusCode).toBe(201);
      const id = r.idOf(created);
      expect(await r.uses(outsider, id)).toBe(false);
      // Admins see everything in the workspace view
      expect((await admin.get(`${r.base}/${id}`)).statusCode).toBe(200);
      expect((await member.put(`${r.base}/${id}/access`, { grants: [{ principalType: 'user', principalId: ids.outsider, perm: 'read' }] })).statusCode).toBe(200);
      expect(await r.uses(outsider, id)).toBe(true);
      // Everyone needs workspace.share_public
      const pub = await member.put(`${r.base}/${id}/access`, { grants: [{ principalType: 'public', perm: 'read' }] });
      expect(pub.statusCode).toBe(403);
      expect((await member.delete(`${r.base}/${id}`)).statusCode).toBe(200);
    });
  }

  it('drops grants of a deleted group', async () => {
    await configure({ 'workspace.prompts': true }, {});
    const g = (await admin.post('/api/admin/groups', { name: `Temp ${Date.now()}` })).json().group;
    await admin.post(`/api/admin/groups/${g.id}/members`, { userId: ids.outsider });
    const p = await admin.post('/api/workspace/prompts', { command: `grp-${Date.now()}`, title: 'G', body: 'x' });
    const pid = p.json().prompt.id;
    await admin.put(`/api/workspace/prompts/${pid}/access`, { grants: [{ principalType: 'group', principalId: g.id, perm: 'read' }] });
    expect(await RESOURCES[1].uses(outsider, pid)).toBe(true);
    expect((await admin.delete(`/api/admin/groups/${g.id}`)).statusCode).toBe(200);
    expect(await RESOURCES[1].uses(outsider, pid)).toBe(false);
    expect((await admin.get(`/api/workspace/prompts/${pid}/access`)).json().grants).toEqual([]);
  });
});

describe('model allowlists per group', () => {
  it('adds the group models to the role allowlist', async () => {
    const list = async (c: TestClient) => ((await c.get('/api/models')).json().models as Array<{ id: string }>).map((m) => m.id);
    await admin.patch('/api/admin/settings/models.allowlist', { user: ['mock/gpt-test'] });
    await admin.patch(`/api/admin/groups/${teamId}`, { modelIds: ['mock/gpt-other'] });
    expect(await list(member)).toEqual(expect.arrayContaining(['mock/gpt-test', 'mock/gpt-other']));
    expect(await list(outsider)).not.toContain('mock/gpt-other');

    // And completions follow the same rule
    const chat = (await outsider.post('/api/chats', {})).json().chat.id;
    const refused = await outsider.post(`/api/chats/${chat}/completions`, { parentId: null, content: 'Hi', modelIds: ['mock/gpt-other'] });
    expect(refused.statusCode).toBe(403);
    await admin.patch('/api/admin/settings/models.allowlist', { user: null });
    await admin.patch(`/api/admin/groups/${teamId}`, { modelIds: [] });
  });
});


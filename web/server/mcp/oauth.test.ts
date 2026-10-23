/**
 * Remote MCP servers that sign in with OAuth: discovery, dynamic client
 * registration, PKCE, the callback, refreshing, and signing out (revoking).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { chatFixture, type ChatFixture } from '../test/chat-fixture';
import { startMockOAuthMcp, type MockOAuthMcp } from '../test/mock-oauth-mcp';
import { DEFAULT_PERMISSIONS } from '../../shared/access';
import { mcpOAuth } from '../db/schema';
import type { TestClient } from '../test/client';

let f: ChatFixture | undefined;
let mcp: MockOAuthMcp | undefined;
afterEach(async () => {
  await f?.close();
  await mcp?.close();
  f = undefined;
  mcp = undefined;
});

async function setup() {
  f = await chatFixture();
  mcp = await startMockOAuthMcp();
  await f.admin.patch('/api/admin/settings/permissions.default', { ...DEFAULT_PERMISSIONS, 'mcp.user_servers': true });
  // The mock is on 127.0.0.1, which the SSRF guard blocks unless allowed
  await f.admin.patch('/api/admin/settings/net.allowlist', { hosts: ['127.0.0.1'] });
  return { f, mcp };
}

/** Sign in through the pop-up: Claudia → authorization server → callback. */
async function signIn(client: TestClient, connectPath: string, server: MockOAuthMcp) {
  const start = await client.get(connectPath);
  expect(start.statusCode).toBe(302);
  const location = String(start.headers.location);
  const code = server.approve(location);
  const state = new URL(location).searchParams.get('state')!;
  return { location, code, state, callback: () => client.get(`/api/mcp/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`) };
}

const serverOf = async (client: TestClient, id: string) => (await client.get('/api/mcp/servers')).json().servers.find((s: any) => s.id === id);

async function echoInChat(fx: ChatFixture, client: TestClient, serverId: string, text: string) {
  fx.mock.push({ toolCalls: [{ id: `call_${text}`, name: 'echo', arguments: JSON.stringify({ text }) }] }, { text: ['Done.'] });
  const chat = (await client.post('/api/chats', {})).json().chat.id;
  const run = await client.post(`/api/chats/${chat}/completions`, { parentId: null, content: 'Echo', modelIds: ['mock/gpt-test'], toolIds: [serverId] });
  expect(run.statusCode).toBe(202);
  const events = await fx.readRun(client, run.json().runId);
  return events.find((e) => e.event.type === 'tool.result')?.event as any;
}

describe('MCP OAuth', () => {
  it('connects a server from its URL, refreshes tokens and revokes them on disconnect', async () => {
    const { f: fx, mcp: server } = await setup();
    const bob = await fx.newUser('bob@example.com');
    const carol = await fx.newUser('carol@example.com');
    const created = await bob.post('/api/mcp/own', { name: 'Notes', transport: 'streamable-http', url: server.url, oauth: {} });
    expect(created.statusCode).toBe(201);
    const id = created.json().server.id;
    expect(created.json().server.oauth).toEqual({ connected: false, clientId: null, hasClientSecret: false, scope: null });

    // Waiting for a sign-in: not started, and it says why
    const waiting = await serverOf(bob, id);
    expect(waiting).toMatchObject({ oauth: { connected: false }, error: 'Sign in to use this server.' });
    expect(waiting.status).not.toBe('ready');

    // Discovery, registration and PKCE happen on the way to the authorization server
    const login = await signIn(bob, `/api/mcp/own/${id}/oauth/connect`, server);
    const authorize = new URL(login.location);
    expect(authorize.pathname).toBe('/authorize');
    expect(server.clients).toHaveLength(1);
    expect(server.clients[0].redirect_uris[0]).toMatch(/\/api\/mcp\/oauth\/callback$/);
    expect(authorize.searchParams.get('client_id')).toBe(server.clients[0].client_id);
    expect(authorize.searchParams.get('resource')).toBe(server.url);

    // Only the user who started it can finish it
    const stolen = await carol.get(`/api/mcp/oauth/callback?code=${login.code}&state=${login.state}`);
    expect(stolen.body).toContain('data-mcp-oauth-result="error"');
    const done = await login.callback();
    expect(done.statusCode).toBe(200);
    expect(done.body).toContain('data-mcp-oauth-result="ok"');
    expect(server.grants).toEqual(['authorization_code']);

    const ready = await serverOf(bob, id);
    expect(ready).toMatchObject({ status: 'ready', oauth: { connected: true }, error: null });
    expect(ready.tools.map((t: any) => t.name)).toEqual(['echo']);
    // Tokens are stored encrypted
    const [row] = await fx.db.db.select().from(mcpOAuth).where(eq(mcpOAuth.serverId, id));
    expect(row.cipher).not.toContain('at-');
    expect(row.pendingState).toBeNull();

    // Used in a chat with the bearer token
    expect((await echoInChat(fx, bob, id, 'one')).part.content).toContain('echo: one');
    const firstToken = server.bearers.at(-1);

    // The access token stops working: the transport refreshes it without asking the user
    server.expireAccessTokens();
    const again = await echoInChat(fx, bob, id, 'two');
    expect(again.part.isError).toBeFalsy();
    expect(again.part.content).toContain('echo: two');
    expect(server.grants).toEqual(['authorization_code', 'refresh_token']);
    expect(server.bearers.at(-1)).not.toBe(firstToken);

    // Disconnect: revoked at the authorization server and forgotten here
    const off = await bob.delete(`/api/mcp/own/${id}/oauth`);
    expect(off.json().server.oauth.connected).toBe(false);
    expect(server.revoked.some((t) => t.startsWith('rt-'))).toBe(true);
    expect(server.revoked.some((t) => t.startsWith('at-'))).toBe(true);
    expect(await fx.db.db.select().from(mcpOAuth).where(eq(mcpOAuth.serverId, id))).toEqual([]);
    expect((await serverOf(bob, id)).status).not.toBe('ready');
  });

  it('signs in with a pre-registered client, keeps its secret, and forgets the sign-in when OAuth is switched off', async () => {
    const { f: fx, mcp: server } = await setup();
    const bob = await fx.newUser('bob@example.com');
    const id = (await bob.post('/api/mcp/own', { name: 'Notes', transport: 'streamable-http', url: server.url, oauth: { clientId: 'pre-registered', clientSecret: 's3cret' } })).json().server.id;
    const listed = (await bob.get('/api/mcp/own')).json().servers[0];
    expect(listed.oauth).toEqual({ connected: false, clientId: 'pre-registered', hasClientSecret: true, scope: null });
    expect(JSON.stringify(listed)).not.toContain('s3cret');

    // A pre-registered client doesn't register
    const login = await signIn(bob, `/api/mcp/own/${id}/oauth/connect`, server);
    expect(server.clients).toHaveLength(0);
    expect(new URL(login.location).searchParams.get('client_id')).toBe('pre-registered');

    // Renaming keeps the secret; switching OAuth off forgets the sign-in
    await bob.patch(`/api/mcp/own/${id}`, { name: 'Renamed' });
    expect((await bob.get('/api/mcp/own')).json().servers[0].oauth.hasClientSecret).toBe(true);
    await bob.patch(`/api/mcp/own/${id}`, { oauth: null });
    expect((await bob.get('/api/mcp/own')).json().servers[0].oauth).toBeNull();
    expect(await fx.db.db.select().from(mcpOAuth)).toEqual([]);
    // The stale callback finds nothing
    expect((await login.callback()).body).toContain('data-mcp-oauth-result="error"');
  });

  it('lets an admin connect a global server for everyone', async () => {
    const { f: fx, mcp: server } = await setup();
    const bob = await fx.newUser('bob@example.com');
    const created = await fx.admin.post('/api/admin/mcp-servers', { name: 'Team wiki', transport: 'streamable-http', url: server.url, oauth: {} });
    expect(created.statusCode).toBe(201);
    const id = created.json().server.id;
    expect(created.json().server).toMatchObject({ oauth: { connected: false }, error: 'Sign in to use this server.' });

    expect((await bob.get(`/api/admin/mcp-servers/${id}/oauth/connect`)).statusCode).toBe(403);
    const login = await signIn(fx.admin, `/api/admin/mcp-servers/${id}/oauth/connect`, server);
    expect((await login.callback()).body).toContain('data-mcp-oauth-result="ok"');

    const shared = await serverOf(bob, id);
    expect(shared).toMatchObject({ scope: 'global', status: 'ready', oauth: { connected: true } });
    expect((await echoInChat(fx, bob, id, 'hi')).part.content).toContain('echo: hi');
  });
});

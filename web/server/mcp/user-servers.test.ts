/**
 * User-owned remote MCP servers: need mcp.user_servers, reach the network
 * only through the SSRF guard, keep their headers secret and stay private.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { chatFixture, type ChatFixture } from '../test/chat-fixture';
import { startMockMcp, type MockMcp } from '../test/mock-mcp';
import { DEFAULT_PERMISSIONS } from '../../shared/access';

let f: ChatFixture | undefined;
let mcp: MockMcp | undefined;
afterEach(async () => {
  await f?.close();
  await mcp?.close();
  f = undefined;
  mcp = undefined;
});

describe('own tool servers', () => {
  it('are private, guarded and usable in chats', async () => {
    f = await chatFixture();
    mcp = await startMockMcp();
    const bob = await f.newUser('bob@example.com');
    const carol = await f.newUser('carol@example.com');
    const input = { name: 'Mine', transport: 'streamable-http', url: mcp.url, headers: { Authorization: 'Bearer user-mcp-token' } };

    expect((await bob.post('/api/mcp/own', input)).statusCode).toBe(403);
    await f.admin.patch('/api/admin/settings/permissions.default', { ...DEFAULT_PERMISSIONS, 'mcp.user_servers': true });
    const created = await bob.post('/api/mcp/own', input);
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain('user-mcp-token');
    const id = created.json().server.id;
    expect(created.json().server).toMatchObject({ headerNames: ['Authorization'], url: mcp.url });

    // The mock is on 127.0.0.1: the guard keeps it from starting
    const blocked = (await bob.get('/api/mcp/servers')).json().servers.find((s: any) => s.id === id);
    expect(blocked).toMatchObject({ scope: 'user', enabled: true });
    expect((await bob.post(`/api/mcp/servers/${id}/enable`)).json().server.status).not.toBe('ready');
    expect(mcp.calls).toHaveLength(0);

    // Allowed by the admin: it starts with its headers
    await f.admin.patch('/api/admin/settings/net.allowlist', { hosts: ['127.0.0.1'] });
    const ready = (await bob.post(`/api/mcp/servers/${id}/enable`)).json().server;
    expect(ready.status).toBe('ready');
    expect(ready.tools.map((t: any) => t.name)).toContain('echo');
    expect(mcp.lastHeaders.authorization).toBe('Bearer user-mcp-token');

    // Carol sees nothing of it and can't touch it
    expect((await carol.get('/api/mcp/servers')).json().servers.some((s: any) => s.id === id)).toBe(false);
    expect((await carol.get('/api/mcp/own')).json().servers).toEqual([]);
    expect((await carol.patch(`/api/mcp/own/${id}`, { name: 'Hijack' })).statusCode).toBe(404);
    expect((await carol.delete(`/api/mcp/own/${id}`)).statusCode).toBe(404);
    // ...and the admin's list of shared servers doesn't include it either
    expect((await f.admin.get('/api/admin/mcp-servers')).json().servers.some((s: any) => s.id === id)).toBe(false);

    // Used in a chat
    f.mock.push({ toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"text":"hi"}' }] }, { text: ['Done.'] });
    const chat = (await bob.post('/api/chats', {})).json().chat.id;
    const run = await bob.post(`/api/chats/${chat}/completions`, { parentId: null, content: 'Echo', modelIds: ['mock/gpt-test'], toolIds: [id] });
    expect(run.statusCode).toBe(202);
    await f.readRun(bob, run.json().runId);
    expect(mcp.calls).toEqual([{ tool: 'echo', args: { text: 'hi' } }]);

    // A partial update keeps the headers; without the permission it's gone but deletable
    expect((await bob.patch(`/api/mcp/own/${id}`, { name: 'Renamed' })).json().server).toMatchObject({ name: 'Renamed', headerNames: ['Authorization'] });
    await f.admin.patch('/api/admin/settings/permissions.default', DEFAULT_PERMISSIONS);
    expect((await bob.get('/api/mcp/servers')).json().servers.some((s: any) => s.id === id)).toBe(false);
    expect((await bob.delete(`/api/mcp/own/${id}`)).statusCode).toBe(200);
  });

  it('only take http(s) URLs', async () => {
    f = await chatFixture();
    await f.admin.patch('/api/admin/settings/permissions.default', { ...DEFAULT_PERMISSIONS, 'mcp.user_servers': true });
    for (const url of ['file:///etc/passwd', 'ftp://example.com', 'not a url']) {
      const res = await f.admin.post('/api/mcp/own', { name: 'Bad', transport: 'sse', url });
      expect(res.statusCode, url).toBe(400);
    }
    const stdio = await f.admin.post('/api/mcp/own', { name: 'Cmd', transport: 'stdio', url: 'https://example.com' });
    expect(stdio.statusCode).toBe(400);
  });
});

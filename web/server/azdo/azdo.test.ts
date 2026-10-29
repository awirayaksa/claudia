/**
 * Azure DevOps Server on the web server: each user's token (checked, kept
 * encrypted), requests that stay inside the admin's collection, and tool
 * calls that change work items waiting for the user's approval.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { chatFixture, type ChatFixture } from '../test/chat-fixture';
import type { TestClient } from '../test/client';
import { azdoConnections, messages } from '../db/schema';
import { AzdoService } from './azdo-service';
import type { AzdoServer } from '../../shared/azdo';
import type { AppDeps } from '../app';

const AZDO = 'builtin-azdo-001';
const GOOD = 'good-token-1234567890';

interface Seen {
  method: string;
  url: string;
  auth?: string;
  body: string;
}

/** A tiny collection at /tfs/Coll: accepts GOOD, knows work item 5, creates #42. */
async function startFakeTfs() {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(json));
      };
      const path = new URL(req.url!, 'http://x').pathname;
      if (path === '/tfs/Coll/_apis/redirect') {
        res.writeHead(302, { location: 'http://127.0.0.2/steal' });
        return res.end();
      }
      if (req.headers.authorization !== `Basic ${Buffer.from(`:${GOOD}`).toString('base64')}`) return send(401, { message: 'Unauthorized' });
      const item = (id: number, extra: Record<string, unknown> = {}) => ({
        id,
        fields: { 'System.TeamProject': 'Web', 'System.WorkItemType': 'Task', 'System.Title': `Item ${id}`, 'System.State': 'New', ...extra },
      });
      if (path === '/tfs/Coll/_apis/connectionData') return send(200, { authenticatedUser: { providerDisplayName: 'Jamie Doe', descriptor: 'System.Security.Principal.WindowsIdentity;S-1-5-21' } });
      if (req.method === 'GET' && path === '/tfs/Coll/_apis/wit/workitems/5') return send(200, item(5));
      if (req.method === 'GET' && path === '/tfs/Coll/_apis/wit/workitems/5/updates') return send(200, { value: [] });
      if (req.method === 'POST' && path === '/tfs/Coll/Web/_apis/wit/workitems/$Task') return send(200, item(42, { 'System.Title': 'Fix login' }));
      send(404, { message: `No ${req.method} ${path}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tfs/Coll`;
  return { url, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

let f: ChatFixture | undefined;
let tfs: Awaited<ReturnType<typeof startFakeTfs>> | undefined;
afterEach(async () => {
  await f?.close();
  await tfs?.close();
  f = undefined;
  tfs = undefined;
});

/** The fixture with the fake collection registered and the built-in offered. */
async function setup(orchestrator?: AppDeps['orchestrator']) {
  f = await chatFixture(orchestrator ? { orchestrator } : {});
  tfs = await startFakeTfs();
  const server: AzdoServer = { id: randomUUID(), name: 'Fabrikam', url: tfs.url, apiVersion: '7.0' };
  expect((await f.admin.patch('/api/admin/settings/azdo.servers', { servers: [server] })).statusCode).toBe(200);
  const builtins = (await f.admin.get('/api/admin/settings')).json().settings['mcp.builtins'].enabled as string[];
  await f.admin.patch('/api/admin/settings/mcp.builtins', { enabled: [...builtins, AZDO] });
  return { f, tfs, server };
}

const userId = async (c: TestClient): Promise<string> => (await c.get('/api/me')).json().user.id;
const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, arguments: JSON.stringify(args) });

/** Connect the admin, switch the tools on, and start a reply that calls `toolCalls`. */
async function startRun(s: Awaited<ReturnType<typeof setup>>, toolCalls: ReturnType<typeof call>[]) {
  expect((await s.f.admin.put(`/api/azdo/connections/${s.server.id}`, { pat: GOOD, defaultProject: 'Web' })).statusCode).toBe(200);
  expect((await s.f.admin.post(`/api/mcp/servers/${AZDO}/enable`)).statusCode).toBe(200);
  s.f.mock.push({ toolCalls }, { text: ['Done.'] });
  const chatId = await s.f.newChat(s.f.admin);
  const start = await s.f.admin.post(`/api/chats/${chatId}/completions`, {
    parentId: null,
    modelIds: ['mock/gpt-test'],
    content: 'Make a task',
    toolIds: [AZDO],
  });
  expect(start.statusCode).toBe(202);
  return { runId: start.json().runId as string, messageId: start.json().assistantMessageIds[0] as string };
}

describe('Azure DevOps connections', () => {
  it('check the token, keep it encrypted, and belong to one user', async () => {
    const { f, server } = await setup();
    const bad = await f.admin.put(`/api/azdo/connections/${server.id}`, { pat: 'wrong-token' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/rejected/);

    const ok = await f.admin.put(`/api/azdo/connections/${server.id}`, { pat: GOOD, defaultProject: 'Web' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().connection).toMatchObject({ connected: true, displayName: 'Jamie Doe', defaultProject: 'Web', serverName: 'Fabrikam' });
    const [row] = await f.db.db.select().from(azdoConnections).where(eq(azdoConnections.userId, await userId(f.admin)));
    expect(row.patCipher).not.toContain(GOOD);
    expect(JSON.stringify(ok.json())).not.toContain(GOOD);

    // Only the default project, keeping the token
    const project = await f.admin.put(`/api/azdo/connections/${server.id}`, { defaultProject: 'Api' });
    expect(project.json().connection).toMatchObject({ connected: true, defaultProject: 'Api' });

    const bob = await f.newUser('bob@example.com');
    expect((await bob.get('/api/azdo/connections')).json().connections).toEqual([expect.objectContaining({ serverId: server.id, connected: false })]);
    expect((await bob.put(`/api/azdo/connections/${server.id}`, {})).statusCode).toBe(400);

    expect((await f.admin.delete(`/api/azdo/connections/${server.id}`)).statusCode).toBe(200);
    expect((await f.admin.get('/api/azdo/connections')).json().connections[0].connected).toBe(false);
    expect((await f.admin.put(`/api/azdo/connections/${randomUUID()}`, { pat: GOOD })).statusCode).toBe(404);
  });

  it('send requests only under the collection, and never follow a redirect', async () => {
    const { f, tfs, server } = await setup();
    for (const path of ['../other/_apis/projects', 'http://evil.example/x', '//evil.example/x', 'Web/%2e%2e/x', 'a\\b']) {
      expect(() => AzdoService.urlFor(server, { path }, '7.0'), path).toThrow(/Invalid/);
    }
    expect(AzdoService.urlFor(server, { path: 'Web/_apis/wit/wiql', query: { $top: 5 } }, '7.0').toString()).toBe(`${tfs.url}/Web/_apis/wit/wiql?%24top=5&api-version=7.0`);

    const me = await userId(f.admin);
    await expect(f.app.ctx.azdo.request(me, server.id, { method: 'GET', path: '_apis/projects' })).rejects.toThrow(/Connect Fabrikam/);
    await f.admin.put(`/api/azdo/connections/${server.id}`, { pat: GOOD });
    await expect(f.app.ctx.azdo.request(me, server.id, { method: 'GET', path: '_apis/redirect' })).rejects.toThrow(/rejected your token/);
    expect(tfs.seen.some((s) => s.url.includes('steal'))).toBe(false);
  });
});

describe('Azure DevOps tool approvals', () => {
  it('run read-only tools at once, and changes only once the user approves', async () => {
    const s = await setup();
    const { runId, messageId } = await startRun(s, [
      call('c1', 'azdo_get_work_item', { id: 5 }),
      call('c2', 'azdo_create_work_item', { type: 'Task', title: 'Fix login', parent_id: 5 }),
    ]);
    const until = await s.f.readRun(s.f.admin, runId, 0, (e) => e.event.type === 'tool.approval_request');
    const request = until.at(-1)!.event;
    expect(request).toMatchObject({ type: 'tool.approval_request', runId, messageId, callId: 'c2' });
    // The read already ran; nothing was created yet
    expect(until.some((e) => e.event.type === 'tool.result' && e.event.part.callId === 'c1')).toBe(true);
    expect(s.tfs.seen.some((r) => r.method === 'POST')).toBe(false);

    const bob = await s.f.newUser('bob@example.com');
    expect((await bob.post(`/api/runs/${runId}/approvals`, { callId: 'c2', approved: true })).statusCode).toBe(404);
    expect((await s.f.admin.post(`/api/runs/${runId}/approvals`, { callId: 'nope', approved: true })).statusCode).toBe(404);
    expect((await s.f.admin.post(`/api/runs/${runId}/approvals`, { callId: 'c2', approved: true })).statusCode).toBe(200);
    const rest = await s.f.readRun(s.f.admin, runId, until.at(-1)!.seq);
    expect(rest.find((e) => e.event.type === 'tool.approval_resolved')?.event).toMatchObject({ callId: 'c2', decision: 'approved' });

    const post = s.tfs.seen.find((r) => r.method === 'POST')!;
    expect(post.url).toBe('/tfs/Coll/Web/_apis/wit/workitems/$Task?api-version=7.0');
    expect(JSON.parse(post.body)).toContainEqual({
      op: 'add',
      path: '/relations/-',
      value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${s.tfs.url}/_apis/wit/workItems/5` },
    });
    const [row] = await s.f.db.db.select().from(messages).where(eq(messages.id, messageId));
    const calls = row.parts.filter((p) => p.type === 'tool_call');
    expect(calls.map((p) => (p as { approval?: string }).approval)).toEqual([undefined, 'approved']);
    const created = row.parts.find((p) => p.type === 'tool_result' && p.callId === 'c2') as { content: string };
    expect(JSON.parse(created.content).created).toMatchObject({ id: 42, title: 'Fix login', url: `${s.tfs.url}/Web/_workitems/edit/42` });
  });

  it('skip a change the user rejects, and tell the model', async () => {
    const s = await setup();
    const { runId, messageId } = await startRun(s, [call('c1', 'azdo_add_comment', { id: 5, comment: 'Done' })]);
    const until = await s.f.readRun(s.f.admin, runId, 0, (e) => e.event.type === 'tool.approval_request');
    await s.f.admin.post(`/api/runs/${runId}/approvals`, { callId: 'c1', approved: false });
    await s.f.readRun(s.f.admin, runId, until.at(-1)!.seq);

    expect(s.tfs.seen.some((r) => r.method === 'PATCH')).toBe(false);
    const [row] = await s.f.db.db.select().from(messages).where(eq(messages.id, messageId));
    expect(row.parts.find((p) => p.type === 'tool_call')).toMatchObject({ approval: 'rejected' });
    const toolMessage = s.f.mock.requests.filter((r) => r.stream).at(-1)!.messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMessage.content).toMatch(/declined/);
  });

  it('skip a change nobody approves in time', async () => {
    const s = await setup({ approvalTimeoutMs: 50 });
    const { runId, messageId } = await startRun(s, [call('c1', 'azdo_resolve_work_item', { id: 5 })]);
    const events = await s.f.readRun(s.f.admin, runId);
    expect(events.find((e) => e.event.type === 'tool.approval_resolved')?.event).toMatchObject({ decision: 'expired' });
    const [row] = await s.f.db.db.select().from(messages).where(eq(messages.id, messageId));
    expect(row.parts.find((p) => p.type === 'tool_call')).toMatchObject({ approval: 'expired' });
    expect(s.tfs.seen.some((r) => r.method === 'PATCH')).toBe(false);
  });
});

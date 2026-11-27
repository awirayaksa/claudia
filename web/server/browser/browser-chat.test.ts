/**
 * The Web browser built-in in a chat, end to end: the model's calls run in a
 * real headless Chromium (skipped where none is installed), screenshots are
 * kept as the user's files and shown to the model, clicks wait for the
 * user's approval, and a model that refuses images gets text instead.
 */
import type dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { chromium } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chatFixture, type ChatFixture } from '../test/chat-fixture';
import { messages } from '../db/schema';

const BROWSER = 'builtin-browser-001';

const available = await chromium
  .launch({ headless: true })
  .then(async (b) => {
    await b.close();
    return true;
  })
  .catch(() => false);

const fakeDns = (table: Record<string, string[]>) =>
  ((hostname: string, options: any, cb: any) => {
    const addrs = table[hostname];
    if (!addrs) return cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    const list = addrs.map((address) => ({ address, family: 4 }));
    return options.all ? cb(null, list) : cb(null, list[0].address, list[0].family);
  }) as unknown as typeof dns.lookup;

const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, arguments: JSON.stringify(args) });

describe.skipIf(!available)('Web browser built-in in a chat', () => {
  let site: http.Server;
  let port: number;
  let f: ChatFixture | undefined;

  beforeAll(async () => {
    site = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Tides</title><h1>Tide tables</h1><button>Subscribe</button>');
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    port = (site.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => site.close(() => r())));
  afterEach(async () => {
    await f?.close();
    f = undefined;
  });

  /** The app with the browser offered, site.test allowlisted, and switched on for the admin. */
  async function setup() {
    f = await chatFixture({ browser: { lookup: fakeDns({ 'site.test': ['127.0.0.1'] }), egressPorts: new Set([port]) } });
    const builtins = (await f.admin.get('/api/admin/settings')).json().settings['mcp.builtins'].enabled as string[];
    expect((await f.admin.patch('/api/admin/settings/mcp.builtins', { enabled: [...builtins, BROWSER] })).statusCode).toBe(200);
    expect((await f.admin.patch('/api/admin/settings/net.allowlist', { hosts: ['site.test'] })).statusCode).toBe(200);
    expect((await f.admin.post(`/api/mcp/servers/${BROWSER}/enable`)).statusCode).toBe(200);
    return f;
  }

  async function start(f: ChatFixture) {
    const chatId = await f.newChat(f.admin);
    const res = await f.admin.post(`/api/chats/${chatId}/completions`, {
      parentId: null,
      modelIds: ['mock/gpt-test'],
      content: 'Look at the tide tables',
      toolIds: [BROWSER],
    });
    expect(res.statusCode).toBe(202);
    return { chatId, runId: res.json().runId as string, messageId: res.json().assistantMessageIds[0] as string };
  }

  const url = () => `http://site.test:${port}/`;

  it('browses, keeps the screenshot as a file and shows it to the model', async () => {
    const f = await setup();
    f.mock.push(
      { toolCalls: [call('c1', 'browser_navigate', { url: url() })] },
      { toolCalls: [call('c2', 'browser_screenshot', {})] },
      { text: ['It shows the tide tables.'] }
    );
    const { runId, messageId } = await start(f);
    await f.readRun(f.admin, runId);

    const [row] = await f.db.db.select().from(messages).where(eq(messages.id, messageId));
    expect(row.status).toBe('completed');
    const opened = row.parts.find((p) => p.type === 'tool_result' && p.callId === 'c1') as { content: string };
    expect(opened.content).toMatch(/Tab 1\/1 · Tides · http:\/\/site\.test/);
    expect(opened.content).toMatch(/button "Subscribe" \[ref=e\d+\]/);
    const shot = row.parts.find((p) => p.type === 'tool_result' && p.callId === 'c2') as { images?: Array<{ fileId: string; mime: string }> };
    expect(shot.images).toEqual([{ fileId: expect.any(String), mime: 'image/jpeg' }]);

    // An OpenAI-style request: the tool message is text, the picture follows in a user message
    const last = f.mock.requests.filter((r) => r.stream).at(-1)!;
    const tool = last.messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'c2');
    expect(typeof tool.content).toBe('string');
    const after = last.messages[last.messages.indexOf(tool) + 1];
    expect(after.role).toBe('user');
    expect(after.content.find((p: any) => p.type === 'image_url').image_url.url).toMatch(/^data:image\/jpeg;base64,/);

    // The owner can open the file; nobody else can
    const file = await f.admin.get(`/api/files/${shot.images![0].fileId}/content`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toMatch(/image\/jpeg/);
    const bob = await f.newUser('bob@example.com');
    expect((await bob.get(`/api/files/${shot.images![0].fileId}/content`)).statusCode).toBe(404);

    // The next reply in the chat still sees the screenshot (from history)
    expect(f.app.ctx.browser.status().sessions).toBe(1);
  });

  it('asks before clicking, and skips the click when the user declines', async () => {
    const f = await setup();
    f.mock.push(
      { toolCalls: [call('c1', 'browser_navigate', { url: url() }), call('c2', 'browser_click', { element: 'Subscribe button', ref: 'e3' })] },
      { text: ['OK, I did not subscribe.'] }
    );
    const { runId, messageId } = await start(f);
    const until = await f.readRun(f.admin, runId, 0, (e) => e.event.type === 'tool.approval_request');
    expect(until.at(-1)!.event).toMatchObject({ type: 'tool.approval_request', callId: 'c2' });
    // Opening the page needed no approval
    expect(until.some((e) => e.event.type === 'tool.result' && e.event.part.callId === 'c1')).toBe(true);
    await f.admin.post(`/api/runs/${runId}/approvals`, { callId: 'c2', approved: false });
    await f.readRun(f.admin, runId, until.at(-1)!.seq);
    const [row] = await f.db.db.select().from(messages).where(eq(messages.id, messageId));
    expect(row.parts.find((p) => p.type === 'tool_call' && p.callId === 'c2')).toMatchObject({ approval: 'rejected' });
  });

  it('retries without images when the provider refuses them', async () => {
    const f = await setup();
    f.mock.push(
      { toolCalls: [call('c1', 'browser_navigate', { url: url() })] },
      { toolCalls: [call('c2', 'browser_screenshot', {})] },
      { fail: { status: 400, message: 'This model does not support image input.' } },
      { text: ['I read the page instead.'] }
    );
    const { runId, messageId } = await start(f);
    await f.readRun(f.admin, runId);
    const [row] = await f.db.db.select().from(messages).where(eq(messages.id, messageId));
    expect(row.status).toBe('completed');
    const last = f.mock.requests.filter((r) => r.stream).at(-1)!;
    expect(JSON.stringify(last.messages)).not.toContain('image_url');
    expect(last.messages.find((m: any) => m.tool_call_id === 'c2').content).toMatch(/can't view images/);
  });

  it('closes the chat\'s browser when the chat is deleted', async () => {
    const f = await setup();
    f.mock.push({ toolCalls: [call('c1', 'browser_navigate', { url: url() })] }, { text: ['Opened.'] });
    const { chatId, runId } = await start(f);
    await f.readRun(f.admin, runId);
    expect(f.app.ctx.browser.status().sessions).toBe(1);
    expect((await f.admin.delete(`/api/chats/${chatId}`)).statusCode).toBe(200);
    expect(f.app.ctx.browser.status().sessions).toBe(0);
  });
});

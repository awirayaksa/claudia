/**
 * Tool servers on the web server: built-ins confined to each user's
 * workspace, admin-managed global servers, and MCP-UI action rules.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { chatFixture, type ChatFixture } from '../test/chat-fixture';
import { startMockMcp, type MockMcp } from '../test/mock-mcp';
import type { TestClient } from '../test/client';
import { messages } from '../db/schema';
import { uuidv7 } from '../lib/ids';

const FS = 'builtin-filesystem-001';
const OFFICE = 'builtin-msoffice-001';
const SHEETS = 'builtin-spreadsheet-001';
const SLIDES = 'builtin-presentation-001';
const PDF = 'builtin-pdf-001';

let f: ChatFixture | undefined;
let mcp: MockMcp | undefined;
afterEach(async () => {
  await f?.close();
  await mcp?.close();
  f = undefined;
  mcp = undefined;
});

const userId = async (c: TestClient): Promise<string> => (await c.get('/api/me')).json().user.id;

/** Text of a tool result as returned by MCPClientManager.callTool. */
function resultText(r: unknown): { text: string; isError: boolean } {
  const res = r as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  return { text: (res.content ?? []).map((c) => c.text ?? '').join(''), isError: !!res.isError };
}

describe('built-in tool servers', () => {
  it('are off until the user turns them on, and hidden when the admin disables them', async () => {
    f = await chatFixture();
    const list = (await f.admin.get('/api/mcp/servers')).json().servers;
    expect(list.find((s: any) => s.id === FS)).toMatchObject({ scope: 'builtin', enabled: false, status: 'stopped' });

    const on = await f.admin.post(`/api/mcp/servers/${FS}/enable`);
    expect(on.statusCode).toBe(200);
    expect(on.json().server).toMatchObject({ enabled: true, status: 'ready' });
    expect(on.json().server.tools.map((t: any) => t.name)).toContain('write_file');

    await f.admin.patch('/api/admin/settings/mcp.builtins', { enabled: [OFFICE] });
    const after = (await f.admin.get('/api/mcp/servers')).json().servers.map((s: any) => s.id);
    expect(after).toEqual([OFFICE]);
    expect((await f.admin.post(`/api/mcp/servers/${FS}/enable`)).statusCode).toBe(404);
    await expect(f.app.ctx.mcp.callTool(await userId(f.admin), FS, 'list_allowed_directories', {})).rejects.toThrow(
      /turned off/
    );
  });

  it("confine each user's files to their own workspace", async () => {
    f = await chatFixture();
    const bob = await f.newUser('bob@example.com');
    const [adminId, bobId] = [await userId(f.admin), await userId(bob)];
    const mcpPools = f.app.ctx.mcp;
    const call = (uid: string, tool: string, args: Record<string, unknown>) =>
      mcpPools.callTool(uid, FS, tool, args).then(resultText);

    const written = await call(adminId, 'write_file', { path: 'note.txt', content: 'admin secret' });
    expect(written.isError).toBe(false);
    // Paths are shown relative to the workspace, never the server's layout
    expect(written.text).toContain('note.txt');
    expect(written.text).not.toContain('workspaces');
    expect((await call(adminId, 'list_allowed_directories', {})).text).not.toContain('workspaces');
    const adminWs = path.join(f.dataDir, 'workspaces', adminId);
    const bobWs = path.join(f.dataDir, 'workspaces', bobId);
    expect(fs.readFileSync(path.join(adminWs, 'note.txt'), 'utf-8')).toBe('admin secret');

    // Bob's relative path is his own workspace
    expect((await call(bobId, 'read_file', { path: 'note.txt' })).isError).toBe(true);

    const attempts = [
      path.join(adminWs, 'note.txt'),
      `../${adminId}/note.txt`,
      path.join(bobWs, '..', adminId, 'note.txt'),
      path.join(f.dataDir, 'storage'),
      path.resolve('/'),
    ];
    if (process.platform === 'win32') attempts.push(path.join(adminWs, 'note.txt').toUpperCase());
    for (const p of attempts) {
      const r = await call(bobId, 'read_file', { path: p });
      expect(r.isError, p).toBe(true);
      expect(r.text).not.toContain('admin secret');
    }
    const listing = await call(bobId, 'list_directory', { path: '..' });
    expect(listing.text).not.toContain(adminId);

    // A link inside Bob's workspace to Alice's doesn't get him out
    fs.symlinkSync(adminWs, path.join(bobWs, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const viaLink = await call(bobId, 'read_file', { path: 'escape/note.txt' });
    expect(viaLink.isError).toBe(true);
    expect(viaLink.text).not.toContain('admin secret');
    const writeViaLink = await call(bobId, 'write_file', { path: 'escape/planted.txt', content: 'x' });
    expect(writeViaLink.isError).toBe(true);
    expect(fs.existsSync(path.join(adminWs, 'planted.txt'))).toBe(false);
  });

  it('keep Office documents inside the workspace', async () => {
    f = await chatFixture();
    const id = await userId(f.admin);
    const ws = path.join(f.dataDir, 'workspaces', id);
    const call = (filename: string) => f!.app.ctx.mcp.callTool(id, OFFICE, 'create_document', { filename }).then(resultText);

    expect((await call('report.docx')).isError).toBe(false);
    expect(fs.existsSync(path.join(ws, 'report.docx'))).toBe(true);

    for (const name of ['../escape.docx', path.join(f.dataDir, 'outside.docx')]) {
      expect((await call(name)).isError, name).toBe(true);
    }
    expect(fs.existsSync(path.join(f.dataDir, 'workspaces', 'escape.docx'))).toBe(false);
    expect(fs.existsSync(path.join(f.dataDir, 'outside.docx'))).toBe(false);
  });

  it('run in the chat tool loop', async () => {
    f = await chatFixture();
    await f.admin.post(`/api/mcp/servers/${FS}/enable`);
    f.mock.push(
      { toolCalls: [{ id: 'call_1', name: 'write_file', arguments: JSON.stringify({ path: 'hi.txt', content: 'from the model' }) }] },
      { text: ['Saved.'] }
    );
    const chatId = await f.newChat(f.admin);
    const start = await f.admin.post(`/api/chats/${chatId}/completions`, {
      parentId: null,
      modelIds: ['mock/gpt-test'],
      content: 'Save a file',
      toolIds: [FS],
    });
    expect(start.statusCode).toBe(202);
    await f.readRun(f.admin, start.json().runId);

    const [first] = f.mock.requests.filter((r) => r.stream);
    expect(first.tools.map((t: any) => t.function.name)).toContain('write_file');
    const ws = path.join(f.dataDir, 'workspaces', await userId(f.admin));
    expect(fs.readFileSync(path.join(ws, 'hi.txt'), 'utf-8')).toBe('from the model');

    const [row] = await f.db.db.select().from(messages).where(eq(messages.id, start.json().assistantMessageIds[0]));
    // The written file is linked under the result
    expect(row.parts.map((p) => p.type)).toEqual(['tool_call', 'tool_result', 'workspace_file', 'text']);
    expect(row.parts[0]).toMatchObject({ serverId: FS, tool: 'write_file' });
    expect(row.parts[2]).toEqual({ type: 'workspace_file', path: 'hi.txt', size: 14 });
  });

  it('link each file a reply writes once, at the path the user asked for', async () => {
    f = await chatFixture();
    await f.admin.post(`/api/mcp/servers/${FS}/enable`);
    const write = (id: string, p: string, content: string) => ({ id, name: 'write_file', arguments: JSON.stringify({ path: p, content }) });
    f.mock.push(
      { toolCalls: [write('c1', 'reports/2026/q3.md', '# Q3')] },
      // Written again, then only read: still one link
      { toolCalls: [write('c2', 'reports/2026/q3.md', '# Q3, final'), { id: 'c3', name: 'read_file', arguments: '{"path":"reports/2026/q3.md"}' }] },
      { toolCalls: [{ id: 'c4', name: 'write_file', arguments: '{"path":"../outside.txt","content":"x"}' }] },
      { text: ['Saved to reports/2026/q3.md.'] }
    );
    const chatId = await f.newChat(f.admin);
    const start = await f.admin.post(`/api/chats/${chatId}/completions`, {
      parentId: null,
      modelIds: ['mock/gpt-test'],
      content: 'Write the Q3 report to reports/2026/q3.md',
      toolIds: [FS],
    });
    await f.readRun(f.admin, start.json().runId);

    const [row] = await f.db.db.select().from(messages).where(eq(messages.id, start.json().assistantMessageIds[0]));
    const links = row.parts.filter((p) => p.type === 'workspace_file');
    expect(links).toEqual([{ type: 'workspace_file', path: 'reports/2026/q3.md', size: 4 }]);
    // The link downloads the current file
    const res = await f.admin.get(`/api/workspace-files/content?path=${encodeURIComponent('reports/2026/q3.md')}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('# Q3, final');
  });

  it('make spreadsheets, decks and PDFs in the workspace, linked under the reply', async () => {
    f = await chatFixture();
    for (const id of [SHEETS, SLIDES, PDF]) expect((await f.admin.post(`/api/mcp/servers/${id}/enable`)).statusCode).toBe(200);
    const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, arguments: JSON.stringify(args) });
    f.mock.push(
      {
        toolCalls: [
          call('c1', 'create_workbook', { filename: 'budget.xlsx' }),
          call('c2', 'create_presentation', { filename: 'decks/q3.pptx', slides: [{ layout: 'title', title: 'Q3' }, { title: 'Points', bullets: ['a'] }] }),
          call('c3', 'create_pdf', { filename: 'report.pdf', content: ['# Report', '', '| a | b |', '|---|---|', '| 1 | 2 |'].join('\n') }),
        ],
      },
      { toolCalls: [call('c4', 'write_range', { filename: 'budget.xlsx', sheet: 'Sheet1', rows: [['Total', '=SUM(1,2)']] })] },
      { text: ['Done.'] }
    );
    const chatId = await f.newChat(f.admin);
    const start = await f.admin.post(`/api/chats/${chatId}/completions`, {
      parentId: null,
      modelIds: ['mock/gpt-test'],
      content: 'Make a budget, a deck and a report',
      toolIds: [SHEETS, SLIDES, PDF],
    });
    await f.readRun(f.admin, start.json().runId);

    const ws = path.join(f.dataDir, 'workspaces', await userId(f.admin));
    expect(fs.readFileSync(path.join(ws, 'report.pdf')).subarray(0, 5).toString()).toBe('%PDF-');
    expect(fs.existsSync(path.join(ws, 'decks', 'q3.pptx'))).toBe(true);
    const [row] = await f.db.db.select().from(messages).where(eq(messages.id, start.json().assistantMessageIds[0]));
    // Each file once, though the workbook was written twice
    const links = row.parts.filter((p) => p.type === 'workspace_file').map((p) => (p as { path: string }).path);
    expect(links.sort()).toEqual(['budget.xlsx', 'decks/q3.pptx', 'report.pdf']);
    // Results name workspace paths, never the server's layout
    const results = row.parts.filter((p) => p.type === 'tool_result').map((p) => (p as { content: string }).content);
    expect(results.every((r) => !r.includes('workspaces'))).toBe(true);

    // Confined: no way out of the workspace
    const res = resultText(await f.app.ctx.mcp.callTool(await userId(f.admin), PDF, 'create_pdf', { filename: '../escape.pdf', content: 'x' }));
    expect(res.isError).toBe(true);
    expect(fs.existsSync(path.join(ws, '..', 'escape.pdf'))).toBe(false);
  });

  it('are not offered unless requested and switched on', async () => {
    f = await chatFixture();
    f.mock.push({ text: ['No tools'] });
    const chatId = await f.newChat(f.admin);
    const start = await f.admin.post(`/api/chats/${chatId}/completions`, {
      parentId: null,
      modelIds: ['mock/gpt-test'],
      content: 'Hi',
      toolIds: [FS], // requested but not switched on
    });
    await f.readRun(f.admin, start.json().runId);
    expect(f.mock.requests.find((r) => r.stream)!.tools).toBeUndefined();
  });
});

describe('global tool servers', () => {
  it('are managed by admins, with secrets never sent back', async () => {
    f = await chatFixture();
    mcp = await startMockMcp();
    const bob = await f.newUser('bob@example.com');

    const input = {
      name: 'Mock',
      transport: 'streamable-http',
      url: mcp.url,
      headers: { Authorization: 'Bearer mcp-secret-token' },
    };
    expect((await bob.post('/api/admin/mcp-servers', input)).statusCode).toBe(403);

    const created = await f.admin.post('/api/admin/mcp-servers', input);
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain('mcp-secret-token');
    expect(created.json().server).toMatchObject({ status: 'ready', toolCount: 3, headerNames: ['Authorization'] });
    expect(mcp.lastHeaders.authorization).toBe('Bearer mcp-secret-token');
    const id = created.json().server.id;

    // Renaming keeps the stored headers
    const renamed = await f.admin.patch(`/api/admin/mcp-servers/${id}`, { name: 'Mock 2' });
    expect(renamed.json().server).toMatchObject({ name: 'Mock 2', headerNames: ['Authorization'] });
    expect((await f.admin.get('/api/admin/mcp-servers')).body).not.toContain('mcp-secret-token');

    // On for everyone by default
    const bobView = (await bob.get('/api/mcp/servers')).json().servers.find((s: any) => s.id === id);
    expect(bobView).toMatchObject({ scope: 'global', enabled: true, status: 'ready' });

    expect((await f.admin.delete(`/api/admin/mcp-servers/${id}`)).statusCode).toBe(200);
    expect((await bob.get('/api/mcp/servers')).json().servers.some((s: any) => s.id === id)).toBe(false);
  });

  it('refuses stdio servers unless allowed', async () => {
    f = await chatFixture();
    const res = await f.admin.post('/api/admin/mcp-servers', { name: 'Local', transport: 'stdio', command: 'node' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('stdio_disabled');
  });
});

describe('MCP-UI actions', () => {
  async function setup() {
    f = await chatFixture();
    mcp = await startMockMcp();
    const server = (await f.admin.post('/api/admin/mcp-servers', { name: 'Mock', transport: 'streamable-http', url: mcp.url }))
      .json().server;
    // A reply whose tool result rendered a UI
    const chatId = await f.newChat(f.admin);
    const messageId = uuidv7();
    await f.db.db.insert(messages).values({
      id: messageId,
      chatId,
      parentId: null,
      role: 'assistant',
      status: 'completed',
      parts: [
        { type: 'tool_call', callId: 'call_ui', alias: 'panel', serverId: server.id, tool: 'panel', args: '{}' },
        {
          type: 'tool_result',
          callId: 'call_ui',
          content: 'shown',
          uiResource: { uri: 'ui://mock/panel', mimeType: 'text/html', text: '<p>panel</p>' },
        },
      ],
    });
    return { fx: f, mock: mcp, messageId };
  }

  const action = (c: TestClient, body: Record<string, unknown>) =>
    c.post('/api/tools/ui-action', { uri: 'ui://mock/panel', originalToolCallId: 'call_ui', params: {}, ...body });

  it("runs the producing server's tools and stores the new result", async () => {
    const { fx, mock, messageId } = await setup();
    const res = await action(fx.admin, { toolName: 'echo', params: { text: 'hi' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toMatchObject({ tool_call_id: 'call_ui', name: 'echo', content: 'echo: hi' });
    expect(mock.calls).toEqual([{ tool: 'echo', args: { text: 'hi' } }]);

    const [row] = await fx.db.db.select().from(messages).where(eq(messages.id, messageId));
    expect(row.parts[1]).toMatchObject({ type: 'tool_result', callId: 'call_ui', content: 'echo: hi' });
  });

  it('refuses tools of other servers', async () => {
    const { fx, mock } = await setup();
    const res = await action(fx.admin, { toolName: 'write_file', params: { path: 'x', content: 'y' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ui_action_other_server');
    expect(mock.calls).toEqual([]);
  });

  it('asks before destructive tools', async () => {
    const { fx, mock } = await setup();
    const res = await action(fx.admin, { toolName: 'wipe' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('confirmation_required');
    expect(mock.calls).toEqual([]);

    expect((await action(fx.admin, { toolName: 'wipe', confirmed: true })).statusCode).toBe(200);
    expect(mock.calls.map((c) => c.tool)).toEqual(['wipe']);
  });

  it("can't act on another user's results", async () => {
    const { fx, mock } = await setup();
    const bob = await fx.newUser('bob@example.com');
    const res = await action(bob, { toolName: 'echo', params: { text: 'hi' } });
    expect(res.statusCode).toBe(404);
    expect(mock.calls).toEqual([]);
  });
});

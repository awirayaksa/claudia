/**
 * Agent tasks: the todo tool, task folders, budgets, code runs in the task
 * folder, and the sweep of replies left streaming by a vanished run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { chatFixture, types, type ChatFixture } from '../test/chat-fixture';
import { startMockDocker, type MockDocker } from '../test/mock-docker';
import type { TestClient } from '../test/client';
import { messages } from '../db/schema';
import { uuidv7 } from '../lib/ids';
import { overBudget, parseTodos, resolveTaskFolder, taskFolderName, writeTaskFiles } from './agent';
import { workspacePaths } from '../code/sandbox';
import { STALE_MESSAGE, StaleReplySweep } from './stale-sweep';

const AGENT_ON = { enabled: true, maxSteps: 20, maxMinutes: 30, maxTokens: 1_000_000 };

let f: ChatFixture | undefined;
let docker: MockDocker | undefined;
afterEach(async () => {
  await f?.close();
  await docker?.close();
  f = undefined;
  docker = undefined;
});

const userId = async (c: TestClient): Promise<string> => (await c.get('/api/me')).json().user.id;
const todo = (id: string, todos: Array<[string, string]>) => ({
  id,
  name: 'todo_write',
  arguments: JSON.stringify({ todos: todos.map(([content, status]) => ({ content, status })) }),
});

describe('agent helpers', () => {
  it('checks the plan the model writes', () => {
    expect(parseTodos('{"todos":[{"content":" Read ","status":"in_progress"},{"content":"Write","status":"odd"}]}')).toEqual({
      items: [
        { content: 'Read', status: 'in_progress' },
        { content: 'Write', status: 'pending' },
      ],
    });
    expect(parseTodos('nope')).toHaveProperty('error');
    expect(parseTodos('{"todos":[{"status":"pending"}]}')).toHaveProperty('error');
    expect(parseTodos(JSON.stringify({ todos: Array.from({ length: 31 }, () => ({ content: 'x', status: 'pending' })) }))).toHaveProperty('error');
  });

  it('names task folders by date and first words, uniquely, inside the workspace', async () => {
    const now = new Date('2026-11-15T10:00:00Z');
    expect(taskFolderName('Organise these receipts into a spreadsheet, please!', now)).toBe('2026-11-15-organise-these-receipts-into-a');
    expect(taskFolderName('¿Qué?', now)).toBe('2026-11-15-que');
    expect(taskFolderName('!!!', now)).toBe('2026-11-15-task');

    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'claudia-agent-'));
    try {
      const a = await resolveTaskFolder(ws, { text: 'Sort receipts', now });
      const b = await resolveTaskFolder(ws, { text: 'Sort receipts', now });
      expect([a, b]).toEqual(['tasks/2026-11-15-sort-receipts', 'tasks/2026-11-15-sort-receipts-2']);
      expect(fs.statSync(path.join(ws, a)).isDirectory()).toBe(true);
      // An existing folder can be chosen; nothing outside the workspace, nor a missing one
      fs.mkdirSync(path.join(ws, 'receipts'));
      expect(await resolveTaskFolder(ws, { requested: 'receipts/', text: '' })).toBe('receipts');
      await expect(resolveTaskFolder(ws, { requested: '../elsewhere', text: '' })).rejects.toThrow();
      await expect(resolveTaskFolder(ws, { requested: 'missing', text: '' })).rejects.toThrow(/no folder/);
      await expect(resolveTaskFolder(ws, { requested: '.', text: '' })).rejects.toThrow();

      // What code writes goes back into the folder only
      const written = await writeTaskFiles(ws, 'receipts', [
        { path: 'out/sum.csv', data: Buffer.from('a,b') },
        { path: '../../escape.txt', data: Buffer.from('x') },
      ]);
      expect(written).toEqual([{ path: 'receipts/out/sum.csv', size: 3 }]);
      expect(fs.existsSync(path.join(ws, '..', 'escape.txt'))).toBe(false);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('keeps relative paths for a code run, without leaving the working folder', () => {
    expect(workspacePaths(['a/b.txt', 'a\\c.txt', '../../etc/passwd', '.claudia/main.py', 'a/b.txt'])).toEqual({
      paths: ['a/b.txt', 'a/c.txt', 'etc/passwd', '_.claudia/main.py', 'a/b.txt (2)'],
      dirs: ['a', 'etc', '_.claudia'],
    });
  });

  it('stops at the first budget it reaches', () => {
    const budget = { maxSteps: 3, maxMinutes: 1, maxTokens: 1000 };
    const now = 1_000_000;
    expect(overBudget(budget, { steps: 2, startedAt: now, tokens: 10 }, now)).toBeNull();
    expect(overBudget(budget, { steps: 3, startedAt: now, tokens: 10 }, now)).toMatch(/3 steps/);
    expect(overBudget(budget, { steps: 1, startedAt: now - 61_000, tokens: 10 }, now)).toMatch(/1 minutes/);
    expect(overBudget(budget, { steps: 1, startedAt: now, tokens: 1000 }, now)).toMatch(/1,000 tokens/);
  });
});

describe('agent tasks', () => {
  async function task(fx: ChatFixture, body: Record<string, unknown> = {}, chatId?: string) {
    const id = chatId ?? (await fx.newChat(fx.admin));
    const res = await fx.admin.post(`/api/chats/${id}/completions`, {
      parentId: null,
      modelIds: ['mock/gpt-test'],
      content: 'Sort the receipts',
      features: { agent: true },
      ...body,
    });
    return { chatId: id, res };
  }

  it('are refused until an admin switches them on, and need a single model', async () => {
    f = await chatFixture();
    expect((await f.admin.get('/api/auth/session')).json().features.agent).toBe(false);
    const off = await task(f);
    expect(off.res.json().error.code).toBe('agent_off');

    await f.admin.patch('/api/admin/settings/agent', AGENT_ON);
    expect((await f.admin.get('/api/auth/session')).json().features.agent).toBe(true);
    const two = await task(f, { modelIds: ['mock/gpt-test', 'mock/gpt-other'] });
    expect(two.res.json().error.code).toBe('agent_one_model');
  });

  it('plan with a live checklist, work in their own folder and list the files they made', async () => {
    f = await chatFixture();
    await f.admin.patch('/api/admin/settings/agent', AGENT_ON);
    const ws = path.join(f.dataDir, 'workspaces', await userId(f.admin));
    const folder = `tasks/${new Date().toISOString().slice(0, 10)}-sort-the-receipts`;
    f.mock.push(
      { toolCalls: [todo('t1', [['Read the receipts', 'in_progress'], ['Write the summary', 'pending']])] },
      {
        toolCalls: [
          { id: 'w1', name: 'write_file', arguments: JSON.stringify({ path: `${folder}/summary.md`, content: '# Receipts' }) },
          todo('t2', [['Read the receipts', 'completed'], ['Write the summary', 'completed']]),
        ],
      },
      { text: [`Done: ${folder}/summary.md`] }
    );
    const { chatId, res } = await task(f);
    expect(res.statusCode, res.body).toBe(202);
    const events = await f.readRun(f.admin, res.json().runId);
    expect(types(events).filter((t) => t === 'message.todo')).toHaveLength(2);

    // The model had the task's tools without the user switching any on, and its instructions
    const [first] = f.mock.requests.filter((r) => r.stream);
    const names = first.tools.map((t: any) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['todo_write', 'write_file']));
    expect(first.messages.some((m: any) => m.role === 'system' && String(m.content).includes(`Your task folder is "${folder}"`))).toBe(true);
    expect(fs.readFileSync(path.join(ws, folder, 'summary.md'), 'utf-8')).toBe('# Receipts');

    const [reply] = await f.db.db.select().from(messages).where(eq(messages.id, res.json().assistantMessageIds[0]));
    expect(reply.status).toBe('completed');
    // The checklist leads the reply, as last written
    expect(reply.parts[0]).toEqual({
      type: 'todo',
      items: [
        { content: 'Read the receipts', status: 'completed' },
        { content: 'Write the summary', status: 'completed' },
      ],
    });
    expect(reply.parts.filter((p) => p.type === 'workspace_file')).toEqual([{ type: 'workspace_file', path: `${folder}/summary.md`, size: 10 }]);

    // The turn and the chat remember the folder; the next task in the chat stays in it
    const chat = (await f.admin.get(`/api/chats/${chatId}`)).json().chat;
    expect(chat.messages.find((m: any) => m.role === 'user').task).toEqual({ folder });
    expect(chat.params.taskFolder).toBe(folder);
    f.mock.push({ text: ['Again.'] });
    const again = await task(f, { parentId: res.json().assistantMessageIds[0], content: 'Now in French' }, chatId);
    await f.readRun(f.admin, again.res.json().runId);
    const [turn] = await f.db.db.select().from(messages).where(eq(messages.id, again.res.json().userMessageId));
    expect(turn.meta.agent).toEqual({ folder });
  });

  it('go on past the tool-round limit, and stop at their step budget', async () => {
    f = await chatFixture();
    await f.admin.patch('/api/admin/settings/limits', { completionsPerMinute: 30, concurrentRuns: 3, maxToolIterations: 2 });
    await f.admin.patch('/api/admin/settings/agent', { ...AGENT_ON, maxSteps: 4 });
    for (let i = 0; i < 6; i++) f.mock.push({ toolCalls: [todo(`t${i}`, [[`Step ${i}`, 'in_progress']])] });
    const { res } = await task(f);
    await f.readRun(f.admin, res.json().runId);
    expect(f.mock.requests.filter((r) => r.stream)).toHaveLength(4);
    const [reply] = await f.db.db.select().from(messages).where(eq(messages.id, res.json().assistantMessageIds[0]));
    expect(reply.status).toBe('error');
    expect(reply.error).toMatch(/budget of 4 steps/);
  });

  it('run code on their folder and keep what it writes there', async () => {
    docker = await startMockDocker();
    f = await chatFixture({ env: { CLAUDIA_CODE_DOCKER: docker.endpoint } });
    await f.admin.patch('/api/admin/settings/code', {
      engine: 'server',
      pythonImage: 'python:3.12-slim',
      nodeImage: 'node:22-slim',
      memoryMb: 256,
      cpus: 0.5,
      timeoutSeconds: 5,
      network: false,
      runtime: null,
    });
    await f.admin.patch('/api/admin/settings/agent', AGENT_ON);
    const ws = path.join(f.dataDir, 'workspaces', await userId(f.admin));
    fs.mkdirSync(path.join(ws, 'receipts', 'march'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'receipts', 'march', 'r1.txt'), '12.50');

    docker.push({ stdout: ['total 12.50\n'], writes: { 'summary.csv': 'total,12.50' } });
    f.mock.push({ toolCalls: [{ id: 'c1', name: 'run_code', arguments: JSON.stringify({ code: 'print(1)' }) }] }, { text: ['Done.'] });
    const { res } = await task(f, { task: { folder: 'receipts' } });
    expect(res.statusCode, res.body).toBe(202);
    await f.readRun(f.admin, res.json().runId);

    // The folder went in with its subfolders; the new file came back into it
    expect(docker.uploads[0].map((x) => x.path)).toEqual(['workspace/.claudia/main.py', 'workspace/march/r1.txt']);
    expect(fs.readFileSync(path.join(ws, 'receipts', 'summary.csv'), 'utf-8')).toBe('total,12.50');
    const [reply] = await f.db.db.select().from(messages).where(eq(messages.id, res.json().assistantMessageIds[0]));
    expect(reply.parts.filter((p) => p.type === 'workspace_file')).toEqual([{ type: 'workspace_file', path: 'receipts/summary.csv', size: 11 }]);
    expect(reply.parts.some((p) => p.type === 'file')).toBe(false);
  });
});

describe('stale reply sweep', () => {
  it('fails replies whose run is gone, and leaves live ones alone', async () => {
    f = await chatFixture();
    const owner = await userId(f.admin);
    const chatId = await f.newChat(f.admin);
    const liveChatId = await f.newChat(f.admin);
    const old = new Date(Date.now() - 60 * 60_000);
    const insert = (id: string, chat: string, updatedAt: Date) =>
      f!.db.db.insert(messages).values({ id, chatId: chat, parentId: null, role: 'assistant', parts: [], status: 'streaming', createdAt: updatedAt, updatedAt });
    const [orphan, recent, live] = [uuidv7(), uuidv7(), uuidv7()];
    await insert(orphan, chatId, old);
    await insert(recent, chatId, new Date());
    await insert(live, liveChatId, old);
    const run = await f.app.ctx.runs.start({ userId: owner, chatId: liveChatId, lockKey: `${liveChatId}:root`, maxConcurrent: 5 });

    const sweep = new StaleReplySweep({ db: f.db.db, runs: f.app.ctx.runs, log: f.app.log });
    expect(await sweep.sweep()).toBe(1);
    const status = async (id: string) => (await f!.db.db.select().from(messages).where(eq(messages.id, id)))[0];
    expect(await status(orphan)).toMatchObject({ status: 'error', error: STALE_MESSAGE });
    expect((await status(recent)).status).toBe('streaming');
    expect((await status(live)).status).toBe('streaming');
    f.app.ctx.runs.finish(run, 'completed');
  });
});

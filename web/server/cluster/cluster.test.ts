/**
 * Two app instances sharing one database, one data directory and one Redis
 * (TEST_REDIS_URL): a reply started on one streams, stops and takes browser
 * tool answers on the other; branch locks, WebSocket events, settings, the
 * login backoff and rate limits are shared. With TEST_DATABASE_URL the
 * instances also wake each other's job workers through LISTEN/NOTIFY.
 */
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, openTestDatabase } from '../test/helpers';
import { TestClient } from '../test/client';
import { chatFixture, readRunFrom, types, type ChatFixture } from '../test/chat-fixture';
import { Cluster, LocalBus } from './cluster';
import { RunHub } from '../llm/run-hub';
import type { RunEventEnvelope } from '../../shared/run-events';

const REDIS = process.env.TEST_REDIS_URL;
const silent = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as never;

describe('one instance (no Redis)', () => {
  it('the local bus delivers to this process only, and signals go nowhere', async () => {
    const bus = new LocalBus();
    const got: string[] = [];
    const unsub = await bus.subscribe('c', (m) => got.push(m));
    await bus.publish('c', 'one');
    await new Promise((r) => setTimeout(r, 0));
    unsub();
    await bus.publish('c', 'two');
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual(['one']);

    const cluster = await Cluster.open({ log: silent });
    expect(cluster.distributed).toBe(false);
    cluster.signal('anything');
    await cluster.ping();
    await cluster.close();
  });
});

describe.skipIf(!REDIS)('two instances sharing Redis and the database', () => {
  const SANDBOX = { CLAUDIA_PUBLIC_URL: 'http://app.example.test', CLAUDIA_SANDBOX_ORIGIN: 'http://sandbox.example.test' };
  let a: ChatFixture;
  let b: FastifyInstance;
  let baseB: string;
  /** The admin, signed in on instance B (same session cookie). */
  let adminB: TestClient;

  const onB = (client: TestClient) => {
    const c = new TestClient(b);
    for (const [k, v] of client.cookies) c.cookies.set(k, v);
    return c;
  };
  const start = async (client: TestClient, chatId: string, body: Record<string, unknown> = {}) =>
    client.post(`/api/chats/${chatId}/completions`, { parentId: null, content: 'Hi', modelIds: ['mock/gpt-test'], ...body });
  const text = (events: RunEventEnvelope[]) =>
    events.map((e) => (e.event.type === 'message.delta' ? e.event.text : '')).join('');

  beforeAll(async () => {
    // A prefix of its own, so runs of this file never meet other tests' keys
    const env = { ...SANDBOX, REDIS_URL: REDIS!, REDIS_PREFIX: `claudia-test-${randomUUID().slice(0, 8)}:` };
    a = await chatFixture({ env });
    const second = await buildTestApp({ db: a.db, migrate: false, env: { ...env, DATA_DIR: a.dataDir } });
    b = second.app;
    await b.listen({ port: 0, host: '127.0.0.1' });
    baseB = `http://127.0.0.1:${(b.server.address() as AddressInfo).port}`;
    adminB = onB(a.admin);
  });

  afterAll(async () => {
    await b?.close();
    await a?.close();
  });

  it('both report Redis in /readyz', async () => {
    for (const app of [a.app, b]) {
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.json()).toMatchObject({ status: 'ready', redis: 'ok' });
    }
  });

  it('a reply started on one instance streams, resumes and shows as active on the other', async () => {
    a.mock.push({ text: ['Hel', 'lo', ' from', ' A'], delayMs: 150 });
    const chatId = await a.newChat(a.admin);
    const res = await start(a.admin, chatId);
    expect(res.statusCode).toBe(202);
    const { runId } = res.json();

    // While it runs, B lists it for the chat
    const detail = (await adminB.get(`/api/chats/${chatId}`)).json().chat;
    expect(detail.activeRuns.map((r: { runId: string }) => r.runId)).toEqual([runId]);

    const events = await readRunFrom(baseB, adminB, runId);
    expect(types(events)[0]).toBe('run.started');
    expect(types(events).at(-1)).toBe('run.completed');
    expect(events.at(-1)!.event).toMatchObject({ status: 'completed' });
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(text(events)).toBe('Hello from A');

    // Resuming on B after event 3 replays only what came later
    const resumed = await readRunFrom(baseB, adminB, runId, 3);
    expect(resumed.map((e) => e.seq)).toEqual(events.slice(3).map((e) => e.seq));

    // And the reply was saved once, by A
    const saved = (await adminB.get(`/api/chats/${chatId}`)).json().chat;
    expect(saved.activeRuns).toEqual([]);
    expect(saved.messages.find((m: { role: string }) => m.role === 'assistant').parts).toEqual([{ type: 'text', text: 'Hello from A' }]);
  });

  it('a run is found only by its owner, on either instance', async () => {
    a.mock.push({ text: ['private'] });
    const chatId = await a.newChat(a.admin);
    const { runId } = (await start(a.admin, chatId)).json();
    const bob = onB(await a.newUser('bob-cluster@example.com'));
    expect((await bob.get(`/api/runs/${runId}/events`)).statusCode).toBe(404);
    expect((await bob.post(`/api/runs/${runId}/stop`)).statusCode).toBe(404);
    await readRunFrom(baseB, adminB, runId);
  });

  it('stopping on the other instance stops the run where it executes', async () => {
    a.mock.push({ text: Array.from({ length: 40 }, (_, i) => `w${i} `), delayMs: 100 });
    const chatId = await a.newChat(a.admin);
    const { runId } = (await start(a.admin, chatId)).json();
    const first = await readRunFrom(baseB, adminB, runId, 0, (e) => e.event.type === 'message.delta');
    expect((await adminB.post(`/api/runs/${runId}/stop`)).statusCode).toBe(200);
    const rest = await readRunFrom(baseB, adminB, runId, first.at(-1)!.seq);
    expect(rest.at(-1)!.event).toMatchObject({ type: 'run.completed', status: 'stopped' });
    expect(text([...first, ...rest]).split(' ').length).toBeLessThan(40);
  });

  it('a branch point locked on one instance is locked on the other, and freed when the run ends', async () => {
    a.mock.push({ text: ['slow', ' one'], delayMs: 200 });
    const chatId = await a.newChat(a.admin);
    const { runId } = (await start(a.admin, chatId)).json();
    const second = await start(adminB, chatId);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('run_in_progress');
    await readRunFrom(baseB, adminB, runId);
    a.mock.push({ text: ['now B'] });
    const again = await start(adminB, chatId, { content: 'Again' });
    expect(again.statusCode).toBe(202);
    const events = await readRunFrom(a.base, a.admin, again.json().runId);
    expect(text(events)).toBe('now B');
  });

  it("a browser tool's answer posted to the other instance reaches the run, once", async () => {
    a.mock.push({ toolCalls: [{ id: 'call_x', name: 'run_python', arguments: '{"code":"6*7"}' }] }, { text: ['It is 42.'] });
    const chatId = await a.newChat(a.admin);
    const { runId } = (await start(a.admin, chatId, { features: { code: true } })).json();
    const seen = await readRunFrom(baseB, adminB, runId, 0, (e) => e.event.type === 'tool.client_request');
    const answer = { callId: 'call_x', content: '{"result":"42"}' };
    expect((await adminB.post(`/api/runs/${runId}/tool-results`, answer)).statusCode).toBe(200);
    expect((await a.admin.post(`/api/runs/${runId}/tool-results`, answer)).statusCode).toBe(404);
    const rest = await readRunFrom(baseB, adminB, runId, seen.at(-1)!.seq);
    expect(text(rest)).toBe('It is 42.');
    const followUp = a.mock.requests.filter((r) => r.stream).at(-1);
    expect(followUp.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_x', content: '{"result":"42"}' });
  });

  it('WebSocket events published on one instance reach sockets on the other', async () => {
    b.ctx.events.guard('test', async () => true);
    const sent: string[] = [];
    const socket = { readyState: 1, OPEN: 1, send: (d: string) => sent.push(d) } as never;
    const user = { id: 'u', role: 'user' } as never;
    expect(await b.ctx.events.subscribe(socket, user, 'test:1')).toBe(true);
    a.app.ctx.events.publish('test:1', { hello: 'from A' });
    await vi.waitFor(() => expect(sent).toEqual([JSON.stringify({ topic: 'test:1', event: { hello: 'from A' } })]));
    b.ctx.events.unsubscribe(socket);
  });

  it('a settings change on one instance is seen by the other', async () => {
    const before = await b.ctx.settings.get('limits');
    const res = await a.admin.patch('/api/admin/settings/limits', { ...before, maxToolIterations: before.maxToolIterations + 1 });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(async () => expect((await b.ctx.settings.get('limits')).maxToolIterations).toBe(before.maxToolIterations + 1));
  });

  it('the login backoff and the per-IP limit count across instances', async () => {
    const onA = new TestClient(a.app);
    const viaB = new TestClient(b);
    await onA.get('/api/auth/session');
    await viaB.get('/api/auth/session');
    for (let i = 0; i < 6; i++) await onA.post('/api/auth/login', { email: 'admin@example.com', password: 'wrong-password' });
    const locked = await viaB.post('/api/auth/login', { email: 'admin@example.com', password: 'wrong-password' });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('login_locked');
    // 7 so far; the tenth in the minute is the last one allowed for this IP, on any instance
    for (let i = 0; i < 3; i++) await onA.post('/api/auth/login', { email: 'nobody@example.com', password: 'x' });
    const limited = await viaB.post('/api/auth/login', { email: 'nobody@example.com', password: 'x' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).not.toBe('login_locked');
  });

  it("a tool approval answered on the other instance reaches the run, once", async () => {
    const prefix = `claudia-test-${randomUUID().slice(0, 8)}:`;
    const owner = await Cluster.open({ redisUrl: REDIS, prefix, log: silent });
    const follower = await Cluster.open({ redisUrl: REDIS, prefix, log: silent });
    const hubA = new RunHub({ cluster: owner });
    const hubB = new RunHub({ cluster: follower });
    try {
      const run = await hubA.start({ userId: 'u', chatId: 'c', lockKey: 'c:approval', maxConcurrent: 3 });
      const decision = hubA.awaitApproval(run, 'call_a', 5_000);
      await vi.waitFor(async () => expect((await hubB.find(run.id, 'u')).id).toBe(run.id), { timeout: 2000 });
      await vi.waitFor(async () => expect(await owner.redis!.sismember(owner.key('run', run.id, 'pending'), 'call_a')).toBe(1), { timeout: 2000 });
      expect(await hubB.submitApproval({ id: run.id }, 'call_a', true)).toBe(true);
      expect(await hubA.submitApproval(run, 'call_a', false)).toBe(false);
      expect(await decision).toBe('approved');
    } finally {
      hubA.close();
      hubB.close();
      await owner.close();
      await follower.close();
    }
  });

  it('a run whose instance died is reported failed to its followers', async () => {
    // A hub that starts a run and then goes silent, like a crashed process
    const prefix = `claudia-test-${randomUUID().slice(0, 8)}:`;
    const owner = await Cluster.open({ redisUrl: REDIS, prefix, log: silent });
    const follower = await Cluster.open({ redisUrl: REDIS, prefix, log: silent });
    const hubA = new RunHub({ cluster: owner });
    const hubB = new RunHub({ cluster: follower });
    const run = await hubA.start({ userId: 'u', chatId: 'c', lockKey: 'c:root', maxConcurrent: 3 });
    hubA.emit(run, { type: 'message.delta', messageId: 'm', text: 'partial' });
    await expect(hubB.start({ userId: 'u', chatId: 'c', lockKey: 'c:root', maxConcurrent: 3 })).rejects.toThrow(/already being written/);

    vi.useFakeTimers({ toFake: ['setInterval'] });
    try {
      const got: RunEventEnvelope[] = [];
      await vi.waitFor(async () => expect((await hubB.find(run.id, 'u')).lastSeq).toBe(1), { timeout: 2000 });
      await hubB.subscribe({ id: run.id }, 0, (e) => got.push(e));
      expect(got.map((e) => e.event.type)).toEqual(['message.delta']);
      // The owner's keys expire
      await owner.redis!.del(owner.key('run', run.id));
      vi.advanceTimersByTime(16_000);
      await vi.waitFor(() => expect(got.at(-1)?.event).toMatchObject({ type: 'run.completed', status: 'error' }), { timeout: 2000 });
    } finally {
      vi.useRealTimers();
      hubA.close();
      hubB.close();
      await owner.close();
      await follower.close();
    }
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('jobs across instances (PostgreSQL)', () => {
  it('NOTIFY from one connection reaches a LISTEN on another', async () => {
    const db = await openTestDatabase();
    try {
      const got: string[] = [];
      const unlisten = await db.listen!('claudia_test_channel', (p) => got.push(p));
      await db.notify!('claudia_test_channel', 'wake');
      await vi.waitFor(() => expect(got).toEqual(['wake']));
      await unlisten();
    } finally {
      await db.close();
    }
  });
});

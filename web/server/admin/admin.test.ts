/**
 * Phase 6 admin: signed webhooks (signature checks and real deliveries to a
 * local receiver), the audit log, usage analytics, banners and default
 * settings.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { chatFixture, DIAGRAMS, type ChatFixture } from '../test/chat-fixture';
import { jobs, usageEvents, users } from '../db/schema';
import { uuidv7 } from '../lib/ids';
import { newWebhookSecret, signWebhook, verifyWebhook } from './webhooks';
import { redact } from './audit';
import { WEBHOOK_HEADERS, type WebhookPayload } from '../../shared/admin';

let f: ChatFixture | undefined;
let receiver: Receiver | undefined;
afterEach(async () => {
  await f?.close();
  await receiver?.close();
  f = undefined;
  receiver = undefined;
});

interface Delivery {
  headers: http.IncomingHttpHeaders;
  body: string;
}
interface Receiver {
  url: string;
  got: Delivery[];
  /** Status to answer with (default 204). */
  status: number;
  close(): Promise<void>;
}

async function startReceiver(): Promise<Receiver> {
  const r = { got: [] as Delivery[], status: 204 } as Receiver;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      r.got.push({ headers: req.headers, body });
      res.writeHead(r.status).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  r.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  r.close = () => new Promise((resolve) => server.close(() => resolve()));
  return r;
}

const events = (r: Receiver) => r.got.map((d) => (JSON.parse(d.body) as WebhookPayload).event);

describe('webhook signatures', () => {
  const secret = newWebhookSecret();
  const body = JSON.stringify({ id: '1', event: 'user.created', createdAt: '2026-01-01T00:00:00Z', data: {} });
  const now = Date.parse('2026-10-18T12:00:00Z');
  const ts = Math.floor(now / 1000);
  const headers = (sig: string, t = ts) => ({ [WEBHOOK_HEADERS.timestamp]: String(t), [WEBHOOK_HEADERS.signature]: sig });

  it('signs "<timestamp>.<body>" with HMAC-SHA256 and verifies it', () => {
    const sig = signWebhook(secret, ts, body);
    expect(sig).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(verifyWebhook(secret, headers(sig), body, { now })).toBe(true);
    // Known vector, so receivers in other languages can check their code
    // (Python: hmac.new(b'whsec_test', b'1700000000.{"a":1}', hashlib.sha256).hexdigest())
    expect(signWebhook('whsec_test', 1700000000, '{"a":1}')).toBe('v1=38877139021993b830af32feea6e18a8da83eb2f6e49ee50bd9e4cf4ca4d3789');
  });

  it('rejects a changed body, another secret, a changed timestamp, a replay and missing headers', () => {
    const sig = signWebhook(secret, ts, body);
    expect(verifyWebhook(secret, headers(sig), body.replace('user', 'admin'), { now })).toBe(false);
    expect(verifyWebhook(newWebhookSecret(), headers(sig), body, { now })).toBe(false);
    expect(verifyWebhook(secret, headers(sig, ts + 1), body, { now })).toBe(false);
    // Signed six minutes before it arrived
    expect(verifyWebhook(secret, headers(sig), body, { now: now + 6 * 60_000 })).toBe(false);
    expect(verifyWebhook(secret, {}, body, { now })).toBe(false);
    expect(verifyWebhook(secret, headers('v1=short'), body, { now })).toBe(false);
  });

  it('accepts any one of several signatures (secret rotation)', () => {
    const good = signWebhook(secret, ts, body);
    expect(verifyWebhook(secret, headers(`v1=${'0'.repeat(64)}, ${good}`), body, { now })).toBe(true);
  });
});

describe('webhook deliveries', () => {
  it('delivers signed events, never shows the secret again, and follows a rotation', async () => {
    receiver = await startReceiver();
    f = await chatFixture();
    const created = await f.admin.post('/api/admin/webhooks', { name: 'Ops', url: receiver.url, events: ['user.created', 'run.completed'] });
    expect(created.statusCode).toBe(201);
    const { webhook, secret } = created.json();
    expect(secret).toMatch(/^whsec_/);
    const listed = await f.admin.get('/api/admin/webhooks');
    expect(listed.body).not.toContain(secret);
    expect(listed.body).not.toContain('whsec_');

    await f.newUser('carol@example.com');
    f.mock.push({ text: ['Hi'], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
    const chatId = await f.newChat(f.admin);
    const { runId } = (await f.admin.post(`/api/chats/${chatId}/completions`, { parentId: null, content: 'Hello', modelIds: ['mock/gpt-test'] })).json();
    await f.readRun(f.admin, runId);
    await vi.waitFor(async () => {
      await f!.app.ctx.jobs.idle();
      expect(events(receiver!)).toEqual(expect.arrayContaining(['user.created', 'run.completed']));
    });

    for (const d of receiver.got) {
      expect(verifyWebhook(secret, d.headers as Record<string, string>, d.body)).toBe(true);
      expect(d.headers['content-type']).toBe('application/json');
      expect(d.headers[WEBHOOK_HEADERS.delivery]).toBe(JSON.parse(d.body).id);
      expect(d.headers[WEBHOOK_HEADERS.event]).toBe(JSON.parse(d.body).event);
    }
    const userEvent = receiver.got.map((d) => JSON.parse(d.body)).find((p) => p.event === 'user.created');
    expect(userEvent.data).toMatchObject({ user: { email: 'carol@example.com', role: 'user' }, source: 'admin' });
    expect(JSON.stringify(userEvent)).not.toContain('password');
    const runEvent = receiver.got.map((d) => JSON.parse(d.body)).find((p) => p.event === 'run.completed');
    expect(runEvent.data).toMatchObject({ runId, chatId, status: 'completed', models: ['mock/gpt-test'], usage: { promptTokens: 7, completionTokens: 3 } });
    // Replies' text never goes out
    expect(JSON.stringify(runEvent)).not.toContain('Hello');

    // A new secret signs from now on; the old one no longer verifies
    const rotated = (await f.admin.post(`/api/admin/webhooks/${webhook.id}/rotate-secret`)).json().secret;
    expect(rotated).not.toBe(secret);
    receiver.got.length = 0;
    await f.newUser('dave@example.com');
    await vi.waitFor(async () => {
      await f!.app.ctx.jobs.idle();
      expect(receiver!.got).toHaveLength(1);
    });
    expect(verifyWebhook(rotated, receiver.got[0].headers as Record<string, string>, receiver.got[0].body)).toBe(true);
    expect(verifyWebhook(secret, receiver.got[0].headers as Record<string, string>, receiver.got[0].body)).toBe(false);
  });

  it('only sends subscribed events to enabled webhooks', async () => {
    receiver = await startReceiver();
    f = await chatFixture();
    const { webhook } = (await f.admin.post('/api/admin/webhooks', { name: 'Runs only', url: receiver.url, events: ['run.completed'] })).json();
    await f.newUser('erin@example.com');
    await f.app.ctx.jobs.idle();
    expect(receiver.got).toEqual([]);

    await f.admin.patch(`/api/admin/webhooks/${webhook.id}`, { events: ['*'], enabled: false });
    await f.newUser('frank@example.com');
    await f.app.ctx.jobs.idle();
    expect(receiver.got).toEqual([]);

    await f.admin.patch(`/api/admin/webhooks/${webhook.id}`, { enabled: true });
    await f.newUser('gina@example.com');
    await vi.waitFor(async () => {
      await f!.app.ctx.jobs.idle();
      expect(events(receiver!)).toContain('user.created');
    });
    // "*" includes the audit trail (the PATCH above, for one)
    expect(events(receiver)).toContain('audit.recorded');
  });

  it('retries server errors, gives up on client errors, and records the outcome', async () => {
    receiver = await startReceiver();
    f = await chatFixture();
    const { webhook } = (await f.admin.post('/api/admin/webhooks', { name: 'Flaky', url: receiver.url, events: ['user.created'] })).json();

    receiver.status = 503;
    await f.newUser('henry@example.com');
    await vi.waitFor(async () => {
      const [job] = await f!.db.db.select().from(jobs).where(eq(jobs.type, 'webhook.deliver'));
      expect(job).toMatchObject({ status: 'queued', attempts: 1 });
    });
    const after503 = (await f.admin.get('/api/admin/webhooks')).json().webhooks[0];
    expect(after503).toMatchObject({ lastStatus: 503, lastError: 'The receiver answered 503.' });
    await f.db.db.delete(jobs);

    receiver.status = 410;
    await f.newUser('iris@example.com');
    await vi.waitFor(async () => {
      const [job] = await f!.db.db.select().from(jobs).where(eq(jobs.type, 'webhook.deliver'));
      expect(job).toMatchObject({ status: 'failed', attempts: 1 });
    });

    // The test button answers at once
    receiver.status = 200;
    const test = (await f.admin.post(`/api/admin/webhooks/${webhook.id}/test`)).json().result;
    expect(test).toMatchObject({ ok: true, status: 200, error: null });
    expect(events(receiver).at(-1)).toBe('webhook.test');
    await receiver.close();
    const down = (await f.admin.post(`/api/admin/webhooks/${webhook.id}/test`)).json().result;
    expect(down.ok).toBe(false);
    expect(down.error).toMatch(/Could not reach the receiver/);
    receiver = undefined;
  });

  it('is admin only, and validates the address', async () => {
    f = await chatFixture();
    const user = await f.newUser('jo@example.com');
    expect((await user.get('/api/admin/webhooks')).statusCode).toBe(403);
    expect((await f.admin.post('/api/admin/webhooks', { name: 'x', url: 'ftp://example.com', events: ['*'] })).statusCode).toBe(400);
    expect((await f.admin.post('/api/admin/webhooks', { name: 'x', url: 'https://example.com', events: ['nope'] })).statusCode).toBe(400);
  });
});

describe('audit log', () => {
  it('records sign-ins, failures, API keys and admin changes, without secrets', async () => {
    f = await chatFixture();
    const user = await f.newUser('kim@example.com');
    await user.post('/api/auth/login', { email: 'kim@example.com', password: 'wrong-password' });
    await f.admin.patch('/api/admin/settings/limits', { completionsPerMinute: 20, concurrentRuns: 2, maxToolIterations: 5 });
    await f.admin.post('/api/admin/connections', { name: 'Other', prefix: 'other', type: 'openai', baseUrl: f.mock.url, apiKey: 'sk-very-secret-value-9999' });
    const key = (await f.admin.post('/api/me/api-keys', { name: 'cli' })).json();

    let page: any;
    await vi.waitFor(async () => {
      page = (await f!.admin.get('/api/admin/audit')).json();
      expect(page.entries.map((e: any) => e.action)).toEqual(
        expect.arrayContaining(['auth.signup', 'auth.login', 'auth.login_failed', 'admin.request', 'api_key.created'])
      );
      expect(page.entries.map((e: any) => e.route)).toEqual(expect.arrayContaining(['PATCH /api/admin/settings/:key']));
      expect(page.entries.filter((e: any) => e.route === 'POST /api/admin/connections')).toHaveLength(2);
    });
    const failed = page.entries.find((e: any) => e.action === 'auth.login_failed');
    expect(failed).toMatchObject({ actorId: null, details: { method: 'password', email: 'kim@example.com' } });
    expect(failed.ip).toBeTruthy();
    const settings = page.entries.find((e: any) => e.route === 'PATCH /api/admin/settings/:key');
    expect(settings).toMatchObject({ actorEmail: 'admin@example.com', targetType: 'settings', targetId: 'limits', status: 200 });
    expect(settings.details.body).toMatchObject({ completionsPerMinute: 20 });
    const conn = page.entries.find((e: any) => e.route === 'POST /api/admin/connections');
    expect(conn.details.body.apiKey).toBe('[redacted]');
    expect(JSON.stringify(page)).not.toContain('sk-very-secret-value-9999');
    expect(JSON.stringify(page)).not.toContain(key.secret);

    // Filters, pages and CSV
    const onlyFailed = (await f.admin.get('/api/admin/audit?action=auth.login_failed')).json();
    expect(onlyFailed.entries).toHaveLength(1);
    const authOnes = (await f.admin.get('/api/admin/audit?action=auth.*')).json();
    expect(authOnes.entries.every((e: any) => e.action.startsWith('auth.'))).toBe(true);
    const byKim = (await f.admin.get('/api/admin/audit?actor=KIM')).json();
    expect(byKim.entries.length).toBeGreaterThan(0);
    expect(byKim.entries.every((e: any) => e.actorEmail === 'kim@example.com')).toBe(true);
    const first = (await f.admin.get('/api/admin/audit?limit=2')).json();
    expect(first.entries).toHaveLength(2);
    const second = (await f.admin.get(`/api/admin/audit?limit=2&before=${first.next}`)).json();
    expect(second.entries[0].id < first.entries[1].id).toBe(true);
    const csv = await f.admin.get('/api/admin/audit/export.csv');
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\r\n')[0]).toBe('time,actor,action,route,target_type,target_id,status,ip,details');
    expect(csv.body).not.toContain('sk-very-secret-value-9999');

    expect((await user.get('/api/admin/audit')).statusCode).toBe(403);
  });

  it('removes entries past the retention period', async () => {
    f = await chatFixture();
    await f.admin.patch('/api/admin/settings/audit', { retentionDays: 30 });
    const audit = f.app.ctx.audit;
    // Entries are written just after each response: the sign-up, the fixture's connection and this PATCH
    await vi.waitFor(async () =>
      expect((await audit.list({})).entries.map((e) => e.route ?? e.action).sort()).toEqual([
        'PATCH /api/admin/settings/:key',
        'POST /api/admin/connections',
        'auth.signup',
      ])
    );
    const before = await audit.count();
    expect(await audit.purge(new Date(Date.now() + 29 * 86_400_000))).toBe(0);
    expect(await audit.purge(new Date(Date.now() + 31 * 86_400_000))).toBe(before);
  });

  it('redacts secrets by key name, cuts long text and bounds depth', () => {
    expect(
      redact({ password: 'p', apiKey: 'k', authValue: 'v', headers: { Authorization: 'Bearer x' }, keep: 'ok', cleared: '', n: 1 })
    ).toEqual({ password: '[redacted]', apiKey: '[redacted]', authValue: '[redacted]', headers: { Authorization: '[redacted]' }, keep: 'ok', cleared: '', n: 1 });
    expect((redact('x'.repeat(600)) as string).length).toBe(501);
    expect(redact({ a: { b: { c: { d: { e: 1 } } } } })).toEqual({ a: { b: { c: { d: '[…]' } } } });
  });
});

describe('usage analytics', () => {
  it('totals tokens, cost and requests by day, model, user and kind', async () => {
    f = await chatFixture();
    const bob = await f.newUser('bob@example.com');
    const [admin] = await f.db.db.select().from(users).where(eq(users.email, 'admin@example.com'));
    const [bobRow] = await f.db.db.select().from(users).where(eq(users.email, 'bob@example.com'));
    const day = (n: number) => new Date(Date.now() - n * 86_400_000);
    const ev = (userId: string, modelId: string, p: number, c: number, cost: number | null, at: Date, kind = 'chat') => ({
      id: uuidv7(),
      userId,
      modelId,
      kind,
      promptTokens: p,
      completionTokens: c,
      cost,
      createdAt: at,
    });
    await f.db.db.insert(usageEvents).values([
      ev(admin.id, 'mock/gpt-test', 100, 50, 0.01, day(0)),
      ev(bobRow.id, 'mock/gpt-test', 1000, 500, 0.1, day(0)),
      ev(bobRow.id, 'mock/gpt-other', 10, 5, null, day(2), 'title'),
      // Outside a 7-day window
      ev(bobRow.id, 'mock/gpt-other', 99999, 1, 5, day(20)),
    ]);
    const res = await f.admin.get('/api/admin/analytics?days=7');
    expect(res.statusCode).toBe(200);
    const a = res.json();
    expect(a.totals).toMatchObject({ promptTokens: 1110, completionTokens: 555, requests: 3, activeUsers: 2 });
    expect(a.totals.cost).toBeCloseTo(0.11);
    expect(a.byDay).toHaveLength(7);
    expect(a.byDay.at(-1)).toMatchObject({ requests: 2, activeUsers: 2, promptTokens: 1100 });
    expect(a.byDay.at(-3)).toMatchObject({ requests: 1 });
    expect(a.byDay[0]).toMatchObject({ requests: 0, promptTokens: 0 });
    expect(a.byModel.map((m: any) => m.modelId)).toEqual(['mock/gpt-test', 'mock/gpt-other']);
    expect(a.byUser[0]).toMatchObject({ email: 'bob@example.com', requests: 2 });
    expect(a.byKind.map((k: any) => k.kind).sort()).toEqual(['chat', 'title']);

    const csv = await f.admin.get('/api/admin/analytics/export.csv?days=7');
    expect(csv.body.split('\r\n')).toHaveLength(9);
    expect((await bob.get('/api/admin/analytics')).statusCode).toBe(403);
  });
});

describe('banners and default settings', () => {
  it('shows only banners in their time window', async () => {
    f = await chatFixture();
    const hour = 3_600_000;
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    const saved = await f.admin.patch('/api/admin/settings/ui.banners', {
      items: [
        { id: 'now', type: 'warning', content: 'Maintenance tonight at 22:00', dismissible: true },
        { id: 'later', type: 'info', content: 'Soon', dismissible: false, startsAt: at(hour) },
        { id: 'over', type: 'error', content: 'Past', dismissible: false, endsAt: at(-hour) },
        { id: 'window', type: 'success', content: 'Live', dismissible: false, startsAt: at(-hour), endsAt: at(hour) },
      ],
    });
    expect(saved.statusCode).toBe(200);
    const user = await f.newUser('lee@example.com');
    const shown = (await user.get('/api/banners')).json().banners.map((b: any) => b.id);
    expect(shown).toEqual(['now', 'window']);
    expect((await user.patch('/api/admin/settings/ui.banners', { items: [] })).statusCode).toBe(403);
  });

  it("applies the admin's defaults until a user changes them, in settings and in replies", async () => {
    f = await chatFixture();
    await f.admin.patch('/api/admin/settings/users.defaults', {
      appearance: { theme: 'dark' },
      preferences: { systemPrompt: 'Answer in one sentence.', showStatistics: true },
    });
    const user = await f.newUser('max@example.com');
    expect((await user.get('/api/me/settings')).json().settings).toMatchObject({
      appearance: { theme: 'dark' },
      preferences: { systemPrompt: 'Answer in one sentence.', showStatistics: true },
    });
    await user.patch('/api/me/settings', { appearance: { theme: 'light' } });
    expect((await user.get('/api/me/settings')).json().settings.appearance.theme).toBe('light');
    // The language menu: a language code, or null to follow the browser
    await user.patch('/api/me/settings', { language: 'ar' });
    expect((await user.get('/api/me/settings')).json().settings).toMatchObject({ language: 'ar', appearance: { theme: 'light' } });
    await user.patch('/api/me/settings', { language: null });
    expect((await user.get('/api/me/settings')).json().settings.language).toBeNull();
    expect((await user.patch('/api/me/settings', { language: '<b>ar</b>' })).statusCode).toBe(400);

    f.mock.push({ text: ['Ok.'] });
    const chatId = await f.newChat(user);
    const { runId } = (await user.post(`/api/chats/${chatId}/completions`, { parentId: null, content: 'Hi', modelIds: ['mock/gpt-test'] })).json();
    await f.readRun(user, runId);
    const sent = f.mock.requests.filter((r) => r.stream).at(-1);
    expect(sent.messages.slice(0, 2)).toEqual([DIAGRAMS, { role: 'system', content: 'Answer in one sentence.' }]);
  });
});

import type { AddressInfo } from 'node:net';
import { buildTestApp } from './helpers';
import { TestClient } from './client';
import { startMockOpenAI } from './mock-openai';
import type { AppDeps } from '../app';
import type { RunEventEnvelope } from '../../shared/run-events';

/**
 * An app with an admin, a connection to the mock OpenAI endpoint and a
 * listening port (SSE is read over real HTTP).
 */
export async function chatFixture(
  opts: { orchestrator?: AppDeps['orchestrator']; env?: Record<string, string>; youtubeOrigin?: string; cloudEndpoints?: AppDeps['cloudEndpoints'] } = {}
) {
  const mock = await startMockOpenAI();
  const t = await buildTestApp({ orchestrator: opts.orchestrator, env: opts.env, youtubeOrigin: opts.youtubeOrigin, cloudEndpoints: opts.cloudEndpoints });
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;

  const admin = new TestClient(t.app);
  await admin.signup('admin@example.com');
  const conn = await admin.post('/api/admin/connections', {
    name: 'Mock',
    prefix: 'mock',
    type: 'openai',
    baseUrl: mock.url,
    apiKey: 'sk-mock-secret-key-1234',
  });
  if (conn.statusCode !== 201) throw new Error(`connection: ${conn.body}`);

  /** A signed-in regular user. */
  async function newUser(email: string): Promise<TestClient> {
    const created = await admin.post('/api/admin/users', { email, name: email.split('@')[0], password: 'user-password-1' });
    if (created.statusCode !== 201) throw new Error(`user: ${created.body}`);
    const client = new TestClient(t.app);
    const login = await client.login(email, 'user-password-1');
    if (login.statusCode !== 200) throw new Error(`login: ${login.body}`);
    return client;
  }

  async function newChat(client: TestClient): Promise<string> {
    const res = await client.post('/api/chats', {});
    return res.json().chat.id;
  }

  /** Read a run's SSE stream to the end (or until `until` returns true). */
  const readRun = (client: TestClient, runId: string, after = 0, until?: (e: RunEventEnvelope) => boolean) =>
    readRunFrom(base, client, runId, after, until);

  return {
    ...t,
    mock,
    admin,
    base,
    newUser,
    newChat,
    readRun,
    async close() {
      await t.close();
      await mock.close();
    },
  } as const;
}

/** Read a run's SSE stream from the app at `base` (another instance, say) with `client`'s cookies. */
export async function readRunFrom(
  base: string,
  client: TestClient,
  runId: string,
  after = 0,
  until?: (e: RunEventEnvelope) => boolean
): Promise<RunEventEnvelope[]> {
  const cookie = [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const controller = new AbortController();
  const res = await fetch(`${base}/api/runs/${runId}/events?after=${after}`, { headers: { cookie }, signal: controller.signal });
  if (!res.ok) throw new Error(`events: ${res.status} ${await res.text()}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const out: RunEventEnvelope[] = [];
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!data) continue;
      const env = JSON.parse(data.slice(6)) as RunEventEnvelope;
      out.push(env);
      if (until?.(env)) {
        controller.abort();
        return out;
      }
    }
  }
  return out;
}

export type ChatFixture = Awaited<ReturnType<typeof chatFixture>>;

export const types = (events: RunEventEnvelope[]) => events.map((e) => e.event.type);

/**
 * Admin connections to an endpoint with a self-signed certificate: refused
 * until "skip TLS certificate verification" is on, then the models list
 * (axios) and replies stream (fetch). Users can't turn it on for their own.
 */
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';
import { chatFixture, types, type ChatFixture } from '../../test/chat-fixture';
import { SELF_SIGNED_CERT, SELF_SIGNED_KEY } from '../../test/self-signed-tls';
import { DEFAULT_PERMISSIONS } from '../../../shared/access';

/** TLS with the self-signed certificate in front of the mock endpoint. */
async function tlsProxy(target: string) {
  const to = new URL(target);
  const server = https.createServer({ key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT }, (req, res) => {
    const upstream = http.request(
      { host: to.hostname, port: to.port, path: req.url, method: req.method, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      }
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `https://127.0.0.1:${(server.address() as AddressInfo).port}${to.pathname}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

let f: ChatFixture | undefined;
let proxy: Awaited<ReturnType<typeof tlsProxy>> | undefined;
afterEach(async () => {
  await proxy?.close();
  await f?.close();
  proxy = undefined;
  f = undefined;
});

describe('skipping TLS certificate verification', () => {
  it('refuses a self-signed endpoint until it is on, then lists models and streams replies', async () => {
    f = await chatFixture();
    proxy = await tlsProxy(f.mock.url);
    const created = await f.admin.post('/api/admin/connections', {
      name: 'Internal',
      prefix: 'internal',
      type: 'openai',
      baseUrl: proxy.url,
      apiKey: 'sk-internal-key-1234',
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().connection.id;

    const refused = (await f.admin.post(`/api/admin/connections/${id}/test`, {})).json();
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/certificate/i);

    const patched = await f.admin.patch(`/api/admin/connections/${id}`, { quirks: { insecureTls: true } });
    expect(patched.json().connection.quirks).toEqual({ insecureTls: true });
    const ok = (await f.admin.post(`/api/admin/connections/${id}/test`, {})).json();
    expect(ok).toMatchObject({ ok: true, error: null });
    expect(ok.models).toContain('internal/gpt-test');

    // A reply streams over the same untrusted connection
    f.mock.push({ text: ['Hello', ' over TLS'] });
    const chatId = await f.newChat(f.admin);
    const start = await f.admin.post(`/api/chats/${chatId}/completions`, {
      parentId: null,
      modelIds: ['internal/gpt-test'],
      content: 'hi',
    });
    expect(start.statusCode).toBe(202);
    const events = await f.readRun(f.admin, start.json().runId);
    expect(types(events)).toContain('message.completed');
    const text = events.map((e) => (e.event.type === 'message.delta' ? e.event.text : '')).join('');
    expect(text).toBe('Hello over TLS');

    // Turned off again, the certificate is checked again
    await f.admin.patch(`/api/admin/connections/${id}`, { quirks: {} });
    expect((await f.admin.post(`/api/admin/connections/${id}/test`, {})).json().ok).toBe(false);
  });

  it("can't be turned on for a user's own connection", async () => {
    f = await chatFixture();
    await f.admin.patch('/api/admin/settings/permissions.default', { ...DEFAULT_PERMISSIONS, 'connections.own': true });
    const bob = await f.newUser('bob@example.com');
    const created = await bob.post('/api/connections', {
      name: 'Mine',
      prefix: 'mine',
      type: 'openai',
      baseUrl: 'https://llm.example.com/v1',
      apiKey: 'sk-personal-key-9876',
      quirks: { insecureTls: true },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().connection.quirks.insecureTls).toBeUndefined();

    const id = created.json().connection.id;
    const patched = await bob.patch(`/api/connections/${id}`, { quirks: { insecureTls: true } });
    expect(patched.json().connection.quirks.insecureTls).toBeUndefined();
  });
});

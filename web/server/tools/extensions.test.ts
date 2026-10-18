/**
 * OpenAPI tool servers (operations become tools in chats) and ESM plugins
 * (upload, enable, serve, and the CSP that lets their import map run).
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';
import { chatFixture, type ChatFixture } from '../test/chat-fixture';
import type { TestClient } from '../test/client';
import { operationsOf, parseSpec } from './openapi';
import { PLUGIN_IMPORT_MAP } from '../../shared/plugins';

let f: ChatFixture | undefined;
let api: http.Server | undefined;
afterEach(async () => {
  await f?.close();
  await new Promise<void>((r) => (api ? api.close(() => r()) : r()));
  f = undefined;
  api = undefined;
});

const SPEC = {
  openapi: '3.0.3',
  info: { title: 'Weather', version: '1' },
  servers: [{ url: '/v2' }],
  paths: {
    '/weather/{city}': {
      parameters: [{ name: 'city', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        operationId: 'getWeather',
        summary: 'Current weather',
        parameters: [{ name: 'units', in: 'query', schema: { type: 'string', enum: ['metric', 'imperial'] } }],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/notes': {
      post: {
        operationId: 'add note!',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Note' } } } },
        responses: { '201': { description: 'created' } },
      },
    },
  },
  components: { schemas: { Note: { type: 'object', properties: { text: { type: 'string' }, tags: { type: 'array', items: { $ref: '#/components/schemas/Tag' } } } }, Tag: { type: 'string' } } },
};

async function startApi(): Promise<{ url: string; calls: Array<{ method: string; url: string; auth?: string; body: string }> }> {
  const calls: Array<{ method: string; url: string; auth?: string; body: string }> = [];
  api = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    if (req.url === '/openapi.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(SPEC));
    }
    calls.push({ method: req.method!, url: req.url!, auth: req.headers['x-api-key'] as string | undefined, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ city: 'Oslo', temperature: 7 }));
  });
  await new Promise<void>((r) => api!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, calls };
}

describe('OpenAPI tool servers', () => {
  it('turn a spec into tools and call the API from chats', async () => {
    const web = await startApi();
    f = await chatFixture();
    const created = await f.admin.post('/api/admin/tool-servers', {
      name: 'Weather',
      specUrl: `${web.url}/openapi.json`,
      authHeader: 'X-API-Key',
      authValue: 'secret-key',
    });
    expect(created.statusCode, created.body).toBe(201);
    const server = created.json().server;
    expect(server).toMatchObject({ baseUrl: `${web.url}/v2`, hasAuth: true, authHeader: 'X-API-Key' });
    expect(server.operations.map((o: any) => o.name)).toEqual(['getWeather', 'add_note']);
    expect(created.body).not.toContain('secret-key');

    // Users see it as a shared tool server, on by default
    const bob = await f.newUser('bob@example.com');
    const listed = (await bob.get('/api/mcp/servers')).json().servers.find((s: any) => s.id === server.id);
    expect(listed).toMatchObject({ transport: 'openapi', status: 'ready', enabled: true });
    expect(listed.tools[0].inputSchema).toMatchObject({ required: ['city'], properties: { units: { enum: ['metric', 'imperial'] } } });

    f.mock.push({ toolCalls: [{ id: 'c1', name: 'getWeather', arguments: '{"city":"Oslo / Vest","units":"metric"}' }] }, { text: ['7 degrees.'] });
    const chat = (await bob.post('/api/chats', {})).json().chat.id;
    const run = await bob.post(`/api/chats/${chat}/completions`, { parentId: null, content: 'Weather?', modelIds: ['mock/gpt-test'], toolIds: [server.id] });
    expect(run.statusCode).toBe(202);
    await f.readRun(bob, run.json().runId);
    expect(web.calls.at(-1)).toMatchObject({ method: 'GET', url: '/v2/weather/Oslo%20%2F%20Vest?units=metric', auth: 'secret-key' });
    expect(f.mock.requests.filter((r) => r.stream)[1].messages.at(-1).content).toContain('"temperature":7');

    // Switched off by a user: not offered to the model
    await bob.post(`/api/mcp/servers/${server.id}/disable`);
    f.mock.push({ text: ['ok'] });
    const again = await bob.post(`/api/chats/${chat}/completions`, { parentId: null, content: 'x', modelIds: ['mock/gpt-test'], toolIds: [server.id] });
    await f.readRun(bob, again.json().runId);
    expect(f.mock.requests.at(-1).tools).toBeUndefined();

    // Admin only
    expect((await bob.post('/api/admin/tool-servers', { name: 'X', specUrl: `${web.url}/openapi.json` })).statusCode).toBe(403);
    expect((await f.admin.delete(`/api/admin/tool-servers/${server.id}`)).statusCode).toBe(200);
  });

  it('reads YAML, resolves references and refuses Swagger 2', () => {
    const yaml = `openapi: 3.1.0
info: {title: t, version: '1'}
paths:
  /items:
    post:
      requestBody:
        content:
          application/json:
            schema: {$ref: '#/components/schemas/Item'}
      responses: {'200': {description: ok}}
components:
  schemas:
    Item: {type: object, properties: {child: {$ref: '#/components/schemas/Item'}}}
`;
    const ops = operationsOf(parseSpec(yaml));
    expect(ops[0]).toMatchObject({ name: 'post_items', method: 'POST', hasBody: true });
    // The self-reference is cut instead of recursing forever
    expect((ops[0].inputSchema as any).properties.body.properties.child).toMatchObject({ type: 'object' });
    expect(() => parseSpec('{"swagger":"2.0","paths":{}}')).toThrow(/Swagger 2/);
    expect(() => parseSpec('not: [valid')).toThrow();
  });
});

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function uploadPlugin(c: TestClient, manifest: object, bundle: string) {
  const form = new FormData();
  form.append('manifest', JSON.stringify(manifest));
  form.append('bundle', new Blob([bundle], { type: 'text/javascript' }), 'index.mjs');
  const req = new Request('http://localhost/', { method: 'POST', body: form });
  return c.request({
    method: 'POST',
    url: '/api/admin/plugins',
    headers: { 'content-type': req.headers.get('content-type')! },
    payload: Buffer.from(await req.arrayBuffer()),
  });
}

describe('ESM plugins', () => {
  it('are uploaded by admins, served when enabled, and replaced on upgrade', async () => {
    f = await chatFixture();
    const bob = await f.newUser('bob@example.com');
    const manifest = { id: 'wave', name: 'Wave', version: '1.0.0', type: 'renderer-extension' };
    const bundle = "export default { manifest: { id: 'wave' }, preProcess: (c) => c.replaceAll(':wave:', '👋') };";

    expect((await uploadPlugin(bob, manifest, bundle)).statusCode).toBe(403);
    const created = await uploadPlugin(f.admin, manifest, bundle);
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().plugin).toMatchObject({ id: 'wave', enabled: false, url: '/plugins/wave/1.0.0/index.mjs' });

    // Off until enabled
    expect((await bob.get('/api/plugins')).json().plugins).toEqual([]);
    expect((await bob.get('/plugins/wave/1.0.0/index.mjs')).statusCode).toBe(404);
    await f.admin.patch('/api/admin/plugins/wave', { enabled: true });
    expect((await bob.get('/api/plugins')).json().plugins.map((p: any) => p.url)).toEqual(['/plugins/wave/1.0.0/index.mjs']);
    const served = await bob.get('/plugins/wave/1.0.0/index.mjs');
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toContain('text/javascript');
    expect(served.headers['cache-control']).toContain('immutable');
    expect(served.body).toBe(bundle);

    // Upgrade: a new URL, the old one is gone
    const upgraded = await uploadPlugin(f.admin, { ...manifest, version: '1.1.0' }, bundle.replace('👋', '🌊'));
    expect(upgraded.statusCode).toBe(200);
    expect((await bob.get('/plugins/wave/1.0.0/index.mjs')).statusCode).toBe(404);
    expect((await bob.get('/plugins/wave/1.1.0/index.mjs')).body).toContain('🌊');

    // Signed out: nothing
    const anon = new (bob.constructor as any)(f.app) as TestClient;
    expect((await anon.get('/plugins/wave/1.1.0/index.mjs')).statusCode).toBe(401);

    // CommonJS and bad manifests are refused
    expect((await uploadPlugin(f.admin, { ...manifest, id: 'cjs' }, 'module.exports = require("x");')).statusCode).toBe(400);
    expect((await uploadPlugin(f.admin, { ...manifest, id: '../evil' }, bundle)).statusCode).toBe(400);
    expect((await f.admin.delete('/api/admin/plugins/wave')).statusCode).toBe(200);
  });

  it("allow exactly the page's import map in the CSP", async () => {
    f = await chatFixture();
    const res = await f.admin.get('/api/auth/session');
    const hash = createHash('sha256').update(PLUGIN_IMPORT_MAP).digest('base64');
    expect(res.headers['content-security-policy']).toContain(`script-src 'self' 'sha256-${hash}'`);
    const index = fs.readFileSync(path.join(HERE, '..', '..', 'index.html'), 'utf-8');
    expect(index).toContain(`<script type="importmap">${PLUGIN_IMPORT_MAP}</script>`);
    // The import map comes before the app's module script
    expect(index.indexOf('importmap')).toBeLessThan(index.indexOf('type="module"'));
  });
});

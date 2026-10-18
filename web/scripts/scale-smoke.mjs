// The Phase 6 exit test against compose.scale.yml: two instances, Redis, PostgreSQL and S3.
//   node scripts/scale-smoke.mjs
// Env: APP1 (http://localhost:8081), APP2 (http://localhost:8082), LB (http://localhost:8080),
//      ADMIN_EMAIL, ADMIN_PASSWORD (the bootstrapped admin),
//      MOCK_HOST (how the containers reach this machine: host.docker.internal).
// It runs a mock model server and a webhook receiver here, then checks:
// - a reply started on one instance streams in full, in order, from the other;
// - a stop sent to one instance stops the run on the other;
// - a branch point locked on one instance is locked on the other;
// - a file uploaded through one instance downloads from the other (S3);
// - a webhook fired by one instance arrives signed with the right HMAC;
// - both report Redis and S3 ready, and the load balancer serves the app.
import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const APP1 = process.env.APP1 ?? 'http://localhost:8081';
const APP2 = process.env.APP2 ?? 'http://localhost:8082';
const LB = process.env.LB ?? 'http://localhost:8080';
const EMAIL = process.env.ADMIN_EMAIL ?? 'admin@ci.test';
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'ci-admin-password';
const MOCK_HOST = process.env.MOCK_HOST ?? 'host.docker.internal';
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 18080);
const HOOK_PORT = Number(process.env.HOOK_PORT ?? 18081);

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

// ─── Mock model: streams "Hello from the other instance" word by word ────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mock = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (req.method === 'GET' && req.url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'scale-test', object: 'model' }] }));
  }
  const json = body ? JSON.parse(body) : {};
  if (!json.stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'Scale test' }, finish_reason: 'stop' }] }));
  }
  const prompt = String(json.messages?.at(-1)?.content ?? '');
  const words = prompt.includes('long') ? Array.from({ length: 60 }, (_, i) => `w${i} `) : ['Hello ', 'from ', 'the ', 'other ', 'instance'];
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const w of words) {
    if (res.destroyed) return;
    res.write(`data: ${JSON.stringify({ id: 'c', choices: [{ index: 0, delta: { content: w }, finish_reason: null }] })}\n\n`);
    await sleep(prompt.includes('long') ? 150 : 60);
  }
  res.write(`data: ${JSON.stringify({ id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
});

// ─── Webhook receiver ────────────────────────────────────────────────────────
const hooks = [];
const receiver = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  hooks.push({ headers: req.headers, body });
  res.writeHead(204).end();
});

// ─── A browser-like client: cookies and the CSRF header ──────────────────────
class Client {
  cookies = new Map();
  async request(base, method, path, body, { raw = false, form } = {}) {
    const headers = { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
    if (method !== 'GET' && this.cookies.has('claudia_csrf')) headers['x-claudia-csrf'] = decodeURIComponent(this.cookies.get('claudia_csrf'));
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    if (raw) return res;
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text };
  }
}

async function readRun(client, base, runId, until) {
  const res = await client.request(base, 'GET', `/api/runs/${runId}/events`, undefined, { raw: true });
  if (!res.ok) throw new Error(`events ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return events;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!data) continue;
      const env = JSON.parse(data.slice(6));
      events.push(env);
      if (until?.(env)) {
        await reader.cancel();
        return events;
      }
    }
  }
}

const text = (events) => events.map((e) => (e.event.type === 'message.delta' ? e.event.text : '')).join('');

async function main() {
  await new Promise((r) => mock.listen(MOCK_PORT, '0.0.0.0', r));
  await new Promise((r) => receiver.listen(HOOK_PORT, '0.0.0.0', r));

  for (const [name, base] of [['app1', APP1], ['app2', APP2]]) {
    const ready = await (await fetch(`${base}/readyz`)).json();
    check(ready.status === 'ready' && ready.redis === 'ok' && ready.storage === 's3' && ready.database === 'postgres', `${name} ready with PostgreSQL, Redis and S3 (${JSON.stringify(ready)})`);
  }
  const page = await fetch(`${LB}/`, { headers: { accept: 'text/html' } });
  check(page.ok && (await page.text()).includes('<div id="root">'), 'the load balancer serves the app');

  const admin = new Client();
  await admin.request(APP1, 'GET', '/api/auth/session');
  const login = await admin.request(APP1, 'POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
  check(login.status === 200, `signed in on app1 (${login.status})`);

  const conns = await admin.request(APP1, 'GET', '/api/admin/connections');
  if (!conns.json?.connections?.some((c) => c.prefix === 'scale')) {
    const created = await admin.request(APP1, 'POST', '/api/admin/connections', {
      name: 'Scale mock',
      prefix: 'scale',
      type: 'openai',
      baseUrl: `http://${MOCK_HOST}:${MOCK_PORT}/v1`,
      apiKey: 'sk-scale-test-0000',
    });
    check(created.status === 201, `connection created (${created.status} ${created.text.slice(0, 200)})`);
  }
  const start = async (base, chatId, content) =>
    admin.request(base, 'POST', `/api/chats/${chatId}/completions`, { parentId: null, content, modelIds: ['scale/scale-test'] });

  // 1. Started on app1, followed from app2
  const chat1 = (await admin.request(APP1, 'POST', '/api/chats', {})).json.chat.id;
  const started = await start(APP1, chat1, 'hello');
  check(started.status === 202, `reply started on app1 (${started.status} ${started.text.slice(0, 200)})`);
  const events = await readRun(admin, APP2, started.json.runId);
  check(events.at(-1)?.event.type === 'run.completed' && events.at(-1).event.status === 'completed', 'app2 streamed the run to its end');
  check(events.every((e, i) => e.seq === i + 1), 'events arrived complete and in order');
  check(text(events) === 'Hello from the other instance', `app2 got the whole reply ("${text(events)}")`);

  // 2. Locked across instances, stopped across instances
  const chat2 = (await admin.request(APP2, 'POST', '/api/chats', {})).json.chat.id;
  const long = await start(APP2, chat2, 'a long one');
  const locked = await start(APP1, chat2, 'again');
  check(locked.status === 409, `the branch point is locked on app1 too (${locked.status})`);
  const first = await readRun(admin, APP1, long.json.runId, (e) => e.event.type === 'message.delta');
  const stop = await admin.request(APP1, 'POST', `/api/runs/${long.json.runId}/stop`);
  check(stop.status === 200, 'stop accepted by app1');
  const rest = await readRun(admin, APP1, long.json.runId);
  check(rest.at(-1)?.event.status === 'stopped', `the run on app2 stopped (${rest.at(-1)?.event.status})`);
  check(text([...first, ...rest]).split(' ').length < 60, 'it stopped before the end');

  // 3. Files: up through app1, down through app2
  const form = new FormData();
  form.append('file', new Blob(['shared through S3'], { type: 'text/plain' }), 'scale.txt');
  const up = await admin.request(APP1, 'POST', '/api/files', undefined, { form });
  check(up.status === 201, `file uploaded through app1 (${up.status})`);
  const down = await admin.request(APP2, 'GET', `/api/files/${up.json.file.id}/content`);
  check(down.status === 200 && down.text === 'shared through S3', 'and downloaded through app2');

  // 4. A webhook from the other instance, signed
  const hook = await admin.request(APP1, 'POST', '/api/admin/webhooks', {
    name: 'Scale test',
    url: `http://${MOCK_HOST}:${HOOK_PORT}/hook`,
    events: ['user.created'],
  });
  check(hook.status === 201, `webhook created on app1 (${hook.status})`);
  const email = `scale-${Date.now()}@ci.test`;
  const user = await admin.request(APP2, 'POST', '/api/admin/users', { email, name: 'Scale', password: 'scale-password-1' });
  check(user.status === 201, `user created on app2 (${user.status})`);
  for (let i = 0; i < 100 && !hooks.some((h) => h.body.includes(email)); i++) await sleep(100);
  const delivery = hooks.find((h) => h.body.includes(email));
  check(!!delivery, 'the webhook was delivered');
  if (delivery) {
    const ts = delivery.headers['x-claudia-timestamp'];
    const expected = `v1=${createHmac('sha256', hook.json.secret).update(`${ts}.${delivery.body}`).digest('hex')}`;
    const given = String(delivery.headers['x-claudia-signature']);
    check(given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected)), 'its HMAC signature verifies');
    check(Math.abs(Date.now() / 1000 - Number(ts)) < 300, 'its timestamp is current');
  }
  await admin.request(APP1, 'DELETE', `/api/admin/webhooks/${hook.json.webhook.id}`);
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(() => {
    mock.close();
    receiver.close();
    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
  });

import type dns from 'node:dns';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EgressProxy, parseAuthority, type EgressSession } from './egress-proxy';
import type { BrowserNetPolicy } from './policy';

/** Fake DNS: name → addresses. */
const fakeDns = (table: Record<string, string[]>) =>
  ((hostname: string, options: any, cb: any) => {
    const addrs = table[hostname];
    if (!addrs) return cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    const list = addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    return options.all ? cb(null, list) : cb(null, list[0].address, list[0].family);
  }) as unknown as typeof dns.lookup;

describe('EgressProxy', () => {
  let upstream: http.Server;
  let upstreamPort: number;
  let proxy: EgressProxy;
  let proxyPort: number;
  let session: EgressSession;
  const policy: BrowserNetPolicy = { net: { allow: ['ok.test'] }, allowedDomains: [], blockedDomains: ['blocked.test'] };

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`hello ${req.headers.host} ${req.url}`);
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    upstreamPort = (upstream.address() as AddressInfo).port;
    proxy = new EgressProxy({
      policy: () => policy,
      lookup: fakeDns({ 'ok.test': ['127.0.0.1'], 'blocked.test': ['127.0.0.1'], 'mixed.test': ['93.184.216.34', '10.0.0.1'], 'meta.test': ['169.254.169.254'] }),
      ports: new Set([80, 443, upstreamPort]),
    });
    proxyPort = (await proxy.listen()).port;
    session = proxy.register();
  });
  afterAll(async () => {
    await proxy.close();
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  const auth = (s: Pick<EgressSession, 'username' | 'password'>) => `Basic ${Buffer.from(`${s.username}:${s.password}`).toString('base64')}`;

  /** Send CONNECT and return the status line (and the open socket). */
  const connect = (authority: string, authorization?: string): Promise<{ status: string; socket: net.Socket }> =>
    new Promise((resolve, reject) => {
      const socket = net.connect(proxyPort, '127.0.0.1', () => {
        socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorization ? `Proxy-Authorization: ${authorization}\r\n` : ''}\r\n`);
      });
      let buf = '';
      const onData = (chunk: Buffer) => {
        buf += chunk.toString('latin1');
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        socket.off('data', onData);
        resolve({ status: buf.split('\r\n', 1)[0], socket });
      };
      socket.on('data', onData);
      socket.on('error', reject);
    });

  /** A plain-http request through the proxy. */
  const get = (url: string, authorization?: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: url, headers: authorization ? { 'Proxy-Authorization': authorization } : {} }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });

  it('parses authorities', () => {
    expect(parseAuthority('example.com:443')).toEqual({ host: 'example.com', port: 443 });
    expect(parseAuthority('[::1]:8080')).toEqual({ host: '::1', port: 8080 });
    expect(parseAuthority('example.com')).toBeNull();
    expect(parseAuthority('example.com:99999')).toBeNull();
  });

  it('asks for credentials, and refuses wrong ones', async () => {
    const plain = await get(`http://ok.test:${upstreamPort}/`);
    expect(plain.status).toBe(407);
    expect(plain.headers['proxy-authenticate']).toMatch(/^Basic/);
    expect((await connect(`ok.test:${upstreamPort}`)).status).toMatch(/407/);
    expect((await connect(`ok.test:${upstreamPort}`, auth({ username: session.username, password: 'nope' }))).status).toMatch(/407/);
  });

  it('forwards plain http to the address it checked', async () => {
    const res = await get(`http://ok.test:${upstreamPort}/page?q=1`, auth(session));
    expect(res.status).toBe(200);
    expect(res.body).toBe(`hello ok.test:${upstreamPort} /page?q=1`);
  });

  it('tunnels CONNECT to an allowed host', async () => {
    const { status, socket } = await connect(`ok.test:${upstreamPort}`, auth(session));
    expect(status).toMatch(/200/);
    const reply = await new Promise<string>((resolve) => {
      let buf = '';
      socket.on('data', (c) => (buf += c.toString()));
      socket.on('end', () => resolve(buf));
      socket.write(`GET /tunnel HTTP/1.1\r\nHost: ok.test\r\nConnection: close\r\n\r\n`);
    });
    expect(reply).toContain('hello ok.test /tunnel');
    expect(session.bytes).toBeGreaterThan(0);
  });

  it.each([
    ['a loopback literal', `127.0.0.1:${'PORT'}`],
    ['cloud metadata', '169.254.169.254:80'],
    ['an IPv4-mapped private address', '[::ffff:10.0.0.1]:443'],
    ['a name resolving to metadata', 'meta.test:80'],
    ['a name with a private address among public ones', 'mixed.test:443'],
    ['a blocked domain', 'blocked.test:443'],
  ])('refuses %s', async (_what, authority) => {
    const { status, socket } = await connect(authority.replace('PORT', String(upstreamPort)), auth(session));
    socket.destroy();
    expect(status).toMatch(/403/);
  });

  it('refuses ports that are not allowed, and remembers why', async () => {
    const { status, socket } = await connect('ok.test:22', auth(session));
    socket.destroy();
    expect(status).toMatch(/403/);
    expect(session.blocked.at(-1)).toMatch(/Port 22/);
  });

  it('refuses plain http to private hosts with the reason', async () => {
    const res = await get('http://169.254.169.254/latest/meta-data/', auth(session));
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/not a public address/);
  });

  it('stops working for a session once it is unregistered', async () => {
    const s = proxy.register();
    proxy.unregister(s);
    expect((await get(`http://ok.test:${upstreamPort}/`, auth(s))).status).toBe(407);
  });
});

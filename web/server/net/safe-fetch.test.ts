import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type dns from 'node:dns';
import { BlockedRequestError, isBlockedAddress, readBodyLimited, safeFetch, unmapIPv4 } from './safe-fetch';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::127.0.0.1', '64:ff9b::a00:1', '2002:a00:1::',
    'not-an-ip',
  ])('blocks %s', (addr) => {
    expect(isBlockedAddress(addr)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (addr) => {
    expect(isBlockedAddress(addr)).toBe(false);
  });

  it('unmaps IPv4-mapped IPv6 in both notations', () => {
    expect(unmapIPv4('::ffff:192.168.0.1')).toBe('192.168.0.1');
    expect(unmapIPv4('::FFFF:c0a8:1')).toBe('192.168.0.1');
    expect(unmapIPv4('0:0:0:0:0:ffff:a00:1')).toBe('10.0.0.1');
    expect(unmapIPv4('2001:db8::1')).toBe('2001:db8::1');
  });
});

describe('safeFetch', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const u = new URL(req.url!, 'http://x');
      if (u.pathname === '/redirect') {
        res.writeHead(302, { Location: u.searchParams.get('to')! });
        return res.end();
      }
      if (u.pathname === '/big') {
        res.writeHead(200);
        return res.end('x'.repeat(2048));
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`hello ${req.method}`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  /** Fake DNS: name → addresses. */
  const fakeDns = (table: Record<string, string[]>) =>
    ((hostname: string, options: any, cb: any) => {
      const addrs = table[hostname];
      if (!addrs) return cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
      const list = addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
      return options.all ? cb(null, list) : cb(null, list[0].address, list[0].family);
    }) as unknown as typeof dns.lookup;

  it('refuses non-http schemes and credentials', async () => {
    await expect(safeFetch('file:///etc/passwd')).rejects.toThrow(BlockedRequestError);
    await expect(safeFetch('ftp://example.com/')).rejects.toThrow(/Only http and https/);
    await expect(safeFetch('http://user:pw@example.com/')).rejects.toThrow(/credentials/);
  });

  it('refuses private IP literals, including IPv4-mapped IPv6', async () => {
    await expect(safeFetch(`http://127.0.0.1:${port}/`)).rejects.toThrow(BlockedRequestError);
    await expect(safeFetch(`http://[::ffff:127.0.0.1]:${port}/`)).rejects.toThrow(BlockedRequestError);
    await expect(safeFetch('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(BlockedRequestError);
    await expect(safeFetch(`http://[::1]:${port}/`)).rejects.toThrow(BlockedRequestError);
  });

  it('refuses hostnames that resolve to private addresses', async () => {
    const lookup = fakeDns({ 'internal.test': ['10.0.0.7'] });
    await expect(safeFetch('http://internal.test/', { lookup })).rejects.toThrow(/non-public address \(10\.0\.0\.7\)/);
  });

  it('refuses a name with any private address among public ones (rebinding)', async () => {
    const lookup = fakeDns({ 'mixed.test': ['93.184.216.34', '127.0.0.1'] });
    await expect(safeFetch(`http://mixed.test:${port}/`, { lookup })).rejects.toThrow(BlockedRequestError);
  });

  it('connects to the address it checked, not a second lookup', async () => {
    // Allowed host resolving to our local server: the request reaches it
    const lookup = fakeDns({ 'ok.test': ['127.0.0.1'] });
    const res = await safeFetch(`http://ok.test:${port}/`, { lookup, policy: { allow: ['ok.test'] } });
    expect(await res.text()).toBe('hello GET');
  });

  it('re-checks every redirect hop', async () => {
    const lookup = fakeDns({ 'ok.test': ['127.0.0.1'], 'evil.test': ['192.168.1.10'] });
    const policy = { allow: ['ok.test'] };
    await expect(
      safeFetch(`http://ok.test:${port}/redirect?to=http://169.254.169.254/`, { lookup, policy })
    ).rejects.toThrow(/not a public address/);
    await expect(
      safeFetch(`http://ok.test:${port}/redirect?to=http://evil.test:${port}/`, { lookup, policy })
    ).rejects.toThrow(/non-public address/);
    // A redirect that stays on allowed ground is followed
    const ok = await safeFetch(`http://ok.test:${port}/redirect?to=/final`, { lookup, policy });
    expect(await ok.text()).toBe('hello GET');
  });

  it('limits the number of redirects', async () => {
    const lookup = fakeDns({ 'ok.test': ['127.0.0.1'] });
    const loop = `http://ok.test:${port}/redirect?to=` + encodeURIComponent(`http://ok.test:${port}/redirect?to=/x`);
    await expect(
      safeFetch(loop, { lookup, policy: { allow: ['ok.test'] }, maxRedirects: 1 })
    ).rejects.toThrow(/Too many redirects/);
  });

  it('allows admin-listed CIDRs', async () => {
    const res = await safeFetch(`http://127.0.0.1:${port}/`, { policy: { allow: ['127.0.0.0/8'] } });
    expect(res.status).toBe(200);
  });

  it('caps the body size', async () => {
    const res = await safeFetch(`http://127.0.0.1:${port}/big`, { policy: { allow: ['127.0.0.1'] } });
    await expect(readBodyLimited(res, 1000)).rejects.toThrow(/larger than 1000 bytes/);
  });
});

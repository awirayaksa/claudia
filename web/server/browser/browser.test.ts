/**
 * The browser service against a real headless Chromium (skipped where none
 * is installed: `npx playwright install chromium`). Pages come from a local
 * server, reached by name through fake DNS and the egress proxy.
 */
import type dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_SETTING_DEFAULTS } from '../modules/settings/app-settings';
import { BrowserService, type BrowserSettings } from './browser-service';

const available = await chromium
  .launch({ headless: true })
  .then(async (b) => {
    await b.close();
    return true;
  })
  .catch(() => false);

const fakeDns = (table: Record<string, string[]>) =>
  ((hostname: string, options: any, cb: any) => {
    const addrs = table[hostname];
    if (!addrs) return cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    const list = addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    return options.all ? cb(null, list) : cb(null, list[0].address, list[0].family);
  }) as unknown as typeof dns.lookup;

const PAGES: Record<string, string> = {
  '/': `<title>Home</title><h1>Welcome</h1>
    <label>Search <input name="q" id="q"></label>
    <button onclick="document.getElementById('out').textContent = 'You searched ' + document.getElementById('q').value">Go</button>
    <p id="out"></p>
    <select id="s" onchange="document.getElementById('out').textContent = 'Chose ' + this.value"><option value="a">Apple</option><option value="b">Banana</option></select>
    <a href="/second">Second page</a>
    <a href="/second" target="_blank">Open in a new tab</a>
    <button onclick="alert('hello')">Alert</button>`,
  '/second': '<title>Second</title><p>The second page</p>',
  '/leak': '<title>Leak</title><img src="http://169.254.169.254/latest/meta-data/">',
};

describe.skipIf(!available)('BrowserService (headless Chromium)', () => {
  let server: http.Server;
  let port: number;
  let browser: BrowserService;
  const settings: BrowserSettings = { ...APP_SETTING_DEFAULTS.browser, maxSessionsPerUser: 2, maxSessions: 3, blockedDomains: ['blocked.test'] };
  const user = '00000000-0000-4000-8000-000000000001';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/redirect-internal') {
        res.writeHead(302, { Location: 'http://internal.test/' }).end();
        return;
      }
      const body = PAGES[path];
      res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' }).end(body ?? 'not found');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    browser = new BrowserService({
      settings: async () => settings,
      peekSettings: () => settings,
      // site.test is private (127.0.0.1) but allowlisted, like an intranet host the admin allows
      netPolicy: () => ({ allow: ['site.test', 'blocked.test'] }),
      lookup: fakeDns({ 'site.test': ['127.0.0.1'], 'blocked.test': ['127.0.0.1'], 'internal.test': ['10.0.0.5'] }),
      egressPorts: new Set([port]),
      log: pino({ level: 'silent' }),
    });
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => server?.close(() => r()));
  });

  const url = (path: string, host = 'site.test') => `http://${host}:${port}${path}`;
  const refOf = (text: string, pattern: RegExp) => {
    const line = text.split('\n').find((l) => pattern.test(l));
    const m = line && /\[ref=([a-z0-9]+)\]/i.exec(line);
    if (!m) throw new Error(`No element matching ${pattern} in:\n${text}`);
    return m[1];
  };

  it('opens a page and lists its elements with refs', async () => {
    const r = await browser.run(user, 'chat-1', { type: 'navigate', url: url('/') });
    expect(r.isError).toBeFalsy();
    expect(r.text.split('\n')[0]).toMatch(/^Opened .*Tab 1\/1 · Home · http:\/\/site\.test/);
    expect(r.text).toContain('heading "Welcome"');
    expect(r.text).toMatch(/button "Go" \[ref=e\d+\]/);
    expect(r.text).toContain('--- Page content');
  });

  it('types, clicks and chooses', async () => {
    const page = await browser.run(user, 'chat-1', { type: 'snapshot' });
    await browser.run(user, 'chat-1', { type: 'type', ref: refOf(page.text, /textbox "Search"/), element: 'Search box', text: 'tides' });
    const clicked = await browser.run(user, 'chat-1', { type: 'click', ref: refOf(page.text, /button "Go"/), element: 'Go button' });
    expect(clicked.text).toContain('You searched tides');
    const chose = await browser.run(user, 'chat-1', { type: 'select', ref: refOf(clicked.text, /combobox/), element: 'Fruit', values: ['Banana'] });
    expect(chose.text).toContain('Chose b');
  });

  it('dismisses dialogs and says so', async () => {
    const page = await browser.run(user, 'chat-1', { type: 'snapshot' });
    const r = await browser.run(user, 'chat-1', { type: 'click', ref: refOf(page.text, /button "Alert"/), element: 'Alert button' });
    expect(r.text).toMatch(/alert dialog \("hello"\), which was dismissed/);
  });

  it('takes a screenshot as a JPEG', async () => {
    const r = await browser.run(user, 'chat-1', { type: 'screenshot' });
    expect(r.image?.mime).toBe('image/jpeg');
    const bytes = Buffer.from(r.image!.data, 'base64');
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
  });

  it('adopts a new window as a tab', async () => {
    const page = await browser.run(user, 'chat-1', { type: 'navigate', url: url('/') });
    const r = await browser.run(user, 'chat-1', { type: 'click', ref: refOf(page.text, /link "Open in a new tab"/), element: 'new tab link' });
    expect(r.text).toMatch(/A new tab opened/);
    const tabs = await browser.run(user, 'chat-1', { type: 'tabs', action: 'list' });
    expect(tabs.text).toMatch(/2\. Second .*← current/);
    await browser.run(user, 'chat-1', { type: 'tabs', action: 'close', index: 2 });
  });

  it('says when a ref is stale', async () => {
    const r = await browser.run(user, 'chat-1', { type: 'click', ref: 'e999', element: 'nothing' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/take a new snapshot/);
  }, 30_000);

  it('refuses file:, private addresses and blocked sites', async () => {
    expect((await browser.run(user, 'chat-1', { type: 'navigate', url: 'file:///etc/passwd' })).text).toMatch(/Only http and https/);
    expect((await browser.run(user, 'chat-1', { type: 'navigate', url: 'http://169.254.169.254/' })).text).toMatch(/not a public address/);
    expect((await browser.run(user, 'chat-1', { type: 'navigate', url: url('/', 'blocked.test') })).text).toMatch(/blocked by the administrator/);
  });

  it('blocks a redirect to a private host', async () => {
    const r = await browser.run(user, 'chat-1', { type: 'navigate', url: url('/redirect-internal') });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Blocked: internal\.test resolves to a non-public address/);
  });

  it('keeps chats apart, and makes room at the per-user cap', async () => {
    await browser.run(user, 'chat-2', { type: 'navigate', url: url('/second') });
    expect(browser.status().sessions).toBe(2);
    // A third chat of the same user closes the least recently used idle one (chat-1)
    await browser.run(user, 'chat-3', { type: 'navigate', url: url('/') });
    expect(browser.status().sessions).toBe(2);
    const again = await browser.run(user, 'chat-1', { type: 'snapshot' });
    expect(again.text).toContain('about:blank');
  });

  it('closes a chat\'s session', async () => {
    await browser.closeChat(user, 'chat-2');
    await browser.closeUser(user);
    expect(browser.status().sessions).toBe(0);
  });
});

describe.skipIf(!available)('BrowserService with a remote browser (CLAUDIA_BROWSER_WS)', () => {
  it('drives a browser server and still goes out through the egress proxy', async () => {
    const site = http.createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Remote</title><p>Hello from far away</p>'));
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    const port = (site.address() as AddressInfo).port;
    // A free port for the proxy, known before the browser server starts (it points every context at it)
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const proxyPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));

    const server = await chromium.launchServer({ headless: true, wsPath: '/secret-path-for-tests-123456', proxy: { server: `http://127.0.0.1:${proxyPort}` } });
    const settings: BrowserSettings = { ...APP_SETTING_DEFAULTS.browser };
    const remote = new BrowserService({
      settings: async () => settings,
      peekSettings: () => settings,
      netPolicy: () => ({ allow: ['site.test'] }),
      wsEndpoint: server.wsEndpoint(),
      egressListen: { host: '127.0.0.1', port: proxyPort },
      egressUrl: `http://127.0.0.1:${proxyPort}`,
      lookup: fakeDns({ 'site.test': ['127.0.0.1'], 'internal.test': ['10.0.0.9'] }),
      egressPorts: new Set([port]),
      log: pino({ level: 'silent' }),
    });
    try {
      expect(remote.status().engine).toBe('remote');
      const r = await remote.run(user(), 'c', { type: 'navigate', url: `http://site.test:${port}/` });
      expect(r.text).toContain('Hello from far away');
      const blocked = await remote.run(user(), 'c', { type: 'navigate', url: `http://internal.test:${port}/` });
      expect(blocked.text).toMatch(/^Blocked: internal\.test resolves to a non-public address/);
      expect((await remote.test()).ok).toBe(true);
    } finally {
      await remote.close();
      await server.close();
      await new Promise<void>((r) => site.close(() => r()));
    }
  }, 60_000);
});

function user() {
  return '00000000-0000-4000-8000-000000000002';
}

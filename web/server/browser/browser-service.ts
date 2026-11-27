/**
 * The built-in browser: one headless Chromium (launched here, or a remote
 * one at CLAUDIA_BROWSER_WS), and one private browser context per chat.
 *
 * - Every context goes out through the egress proxy with its own
 *   credentials, so pages reach public sites only (and the admin's domain
 *   rules apply to every request, redirects and scripts included).
 * - Contexts keep nothing on disk; downloads, uploads, service workers and
 *   permission prompts are off; dialogs are dismissed and reported.
 * - A chat's calls run one at a time; sessions close when idle, when too
 *   old, when the chat or user goes, and the least recently used idle one
 *   makes room when the caps are reached.
 *
 * Sessions live in this instance's memory: with several instances, a chat
 * whose next reply lands elsewhere starts a fresh browser (every result
 * says which page it is on, so the model notices).
 */
import type { FastifyBaseLogger } from 'fastify';
import type dns from 'node:dns';
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Response } from 'playwright-core';
import type { BrowserAction, BrowserHost, BrowserReply } from '../../../electron/services/builtin-mcp/browser.server';
import type { AppSettingValue } from '../modules/settings/app-settings';
import { BlockedRequestError, type SafeFetchPolicy } from '../net/safe-fetch';
import { BLOCKED_HEADER, EgressProxy, type EgressSession } from './egress-proxy';
import { checkNavigation, requestRefusal, type BrowserNetPolicy } from './policy';
import { pageText } from './snapshot';

export type BrowserSettings = AppSettingValue<'browser'>;

export interface BrowserServiceOptions {
  settings: () => Promise<BrowserSettings>;
  /** The same, without waiting (the proxy checks every connection with it). */
  peekSettings: () => BrowserSettings;
  /** net.allowlist: private hosts users' URLs may reach. */
  netPolicy: () => SafeFetchPolicy;
  /** A remote browser (`playwright launch-server`); without it Chromium starts here. */
  wsEndpoint?: string | null;
  /** Where the egress proxy listens, and the address the browser reaches it at (remote browser). */
  egressListen?: { host: string; port: number };
  egressUrl?: string | null;
  log: FastifyBaseLogger;
  /** Tests: resolve names without real DNS. */
  lookup?: typeof dns.lookup;
  /** Tests: extra egress ports (a local test server). */
  egressPorts?: Set<number>;
}

interface Session {
  key: string;
  userId: string;
  context: BrowserContext;
  egress: EgressSession;
  pages: Page[];
  active: number;
  createdAt: number;
  lastUsed: number;
  busy: number;
  queue: Promise<unknown>;
  /** Said once in the next result (dialogs, blocked requests, new tabs). */
  notices: string[];
}

const VIEWPORT = { width: 1280, height: 800 };
/** Full-page screenshots stop here. */
const MAX_SHOT_HEIGHT = 8000;
const SCREENSHOT_QUALITY = 60;

/** Chromium flags: nothing may go around the proxy, nothing runs in the background. */
const CHROMIUM_ARGS = [
  '--disable-quic',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--dns-prefetch-disable',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-domain-reliability',
  '--disable-sync',
  '--disable-extensions',
  '--no-first-run',
  '--disable-dev-shm-usage',
  '--metrics-recording-only',
];

export class BrowserUnavailableError extends Error {}

/** The first line of a Playwright error, without its call log. */
function cleanError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n')[0].replace(/^(locator|page|frame)\.\w+:\s*/i, '').slice(0, 500);
}

export class BrowserService {
  private browser: Promise<Browser> | null = null;
  private proxy: EgressProxy | null = null;
  private proxyUrl: string | null = null;
  private readonly sessions = new Map<string, Session>();
  /** Keys whose session was lost when the browser went away (said once). */
  private readonly lost = new Set<string>();
  private readonly reaper: NodeJS.Timeout;
  private lastError: string | null = null;
  private closed = false;

  constructor(private readonly opts: BrowserServiceOptions) {
    this.reaper = setInterval(() => void this.reap().catch(() => {}), 60_000);
    this.reaper.unref();
  }

  /** Where the browser runs, for the admin page. */
  status(): { engine: 'remote' | 'local'; sessions: number; error: string | null } {
    return { engine: this.opts.wsEndpoint ? 'remote' : 'local', sessions: this.sessions.size, error: this.lastError };
  }

  /** Start (or reach) the browser and open a blank page, for the admin's test button. */
  async test(): Promise<{ ok: boolean; error: string | null; version: string | null }> {
    try {
      const browser = await this.ensureBrowser();
      const context = await browser.newContext();
      await (await context.newPage()).goto('about:blank');
      await context.close();
      return { ok: true, error: null, version: browser.version() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), version: null };
    }
  }

  /** The host the browser built-in calls, for one user. */
  hostFor(userId: string): BrowserHost {
    return { run: (sessionKey, action) => this.run(userId, sessionKey, action) };
  }

  // ─── Browser and proxy ─────────────────────────────────────────────────────

  private async policy(): Promise<BrowserNetPolicy> {
    const s = await this.opts.settings();
    return { net: this.opts.netPolicy(), allowedDomains: s.allowedDomains, blockedDomains: s.blockedDomains };
  }

  private async ensureProxy(): Promise<string> {
    if (this.proxyUrl) return this.proxyUrl;
    // The proxy reads the rules on every connection (cached settings: no database round trip)
    this.proxy = new EgressProxy({
      policy: () => {
        const s = this.opts.peekSettings();
        return { net: this.opts.netPolicy(), allowedDomains: s.allowedDomains, blockedDomains: s.blockedDomains };
      },
      lookup: this.opts.lookup,
      ...(this.opts.egressPorts ? { ports: new Set([80, 443, 8080, 8443, ...this.opts.egressPorts]) } : {}),
    });
    const listen = this.opts.egressListen ?? { host: '127.0.0.1', port: 0 };
    const addr = await this.proxy.listen(listen.host, listen.port);
    this.proxyUrl = this.opts.egressUrl || `http://${addr.host.includes(':') ? `[${addr.host}]` : addr.host}:${addr.port}`;
    this.opts.log.info({ proxy: this.proxyUrl }, 'browser egress proxy listening');
    return this.proxyUrl;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.closed) throw new BrowserUnavailableError('The browser is shutting down.');
    if (!this.browser) {
      const proxy = await this.ensureProxy();
      const starting = (async () => {
        const browser = this.opts.wsEndpoint
          ? await chromium.connect(this.opts.wsEndpoint, { timeout: 30_000 })
          : await chromium.launch({ headless: true, args: CHROMIUM_ARGS, proxy: { server: proxy }, timeout: 60_000 });
        browser.on('disconnected', () => this.dropAll());
        this.lastError = null;
        return browser;
      })();
      this.browser = starting;
      starting.catch((err) => {
        this.lastError = cleanError(err);
        this.opts.log.warn({ err: this.lastError }, 'the browser failed to start');
        if (this.browser === starting) this.browser = null;
      });
    }
    try {
      return await this.browser;
    } catch (err) {
      throw new BrowserUnavailableError(
        this.opts.wsEndpoint
          ? `The browser service can't be reached (${cleanError(err)}).`
          : `The browser can't start on this server (${cleanError(err)}). An administrator can install Chromium or set CLAUDIA_BROWSER_WS.`
      );
    }
  }

  /** The browser went away (crashed, remote restarted): every session with it. */
  private dropAll(): void {
    this.browser = null;
    for (const s of this.sessions.values()) {
      this.lost.add(s.key);
      this.proxy?.unregister(s.egress);
    }
    this.sessions.clear();
  }

  // ─── Sessions ──────────────────────────────────────────────────────────────

  private mapKey(userId: string, sessionKey: string): string {
    return `${userId}:${sessionKey}`;
  }

  private async closeSession(session: Session): Promise<void> {
    if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
    this.proxy?.unregister(session.egress);
    await session.context.close().catch(() => {});
  }

  /** Make room for one more session of `userId`, closing the least recently used idle one if needed. */
  private async makeRoom(userId: string, settings: BrowserSettings): Promise<void> {
    const idle = (list: Session[]) => list.filter((s) => s.busy === 0).sort((a, b) => a.lastUsed - b.lastUsed)[0];
    const mine = [...this.sessions.values()].filter((s) => s.userId === userId);
    if (mine.length >= settings.maxSessionsPerUser) {
      const victim = idle(mine);
      if (!victim) throw new BrowserUnavailableError('Your other chats are using the browser right now. Try again shortly.');
      await this.closeSession(victim);
    }
    if (this.sessions.size >= settings.maxSessions) {
      const victim = idle([...this.sessions.values()]);
      if (!victim) throw new BrowserUnavailableError('The browser is busy. Try again shortly.');
      await this.closeSession(victim);
    }
  }

  private async session(userId: string, sessionKey: string, settings: BrowserSettings): Promise<Session> {
    const key = this.mapKey(userId, sessionKey);
    const existing = this.sessions.get(key);
    if (existing) return existing;
    await this.makeRoom(userId, settings);
    const browser = await this.ensureBrowser();
    const proxyUrl = await this.ensureProxy();
    const egress = this.proxy!.register();
    let context: BrowserContext;
    try {
      context = await browser.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        acceptDownloads: false,
        serviceWorkers: 'block',
        permissions: [],
        ignoreHTTPSErrors: false,
        proxy: { server: proxyUrl, username: egress.username, password: egress.password },
      });
    } catch (err) {
      this.proxy!.unregister(egress);
      throw err;
    }
    context.setDefaultTimeout(settings.actionTimeoutSeconds * 1000);
    context.setDefaultNavigationTimeout(settings.navigationTimeoutSeconds * 1000);

    const session: Session = {
      key,
      userId,
      context,
      egress,
      pages: [],
      active: 0,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      busy: 0,
      queue: Promise.resolve(),
      notices: this.lost.delete(key) ? ['The browser restarted, so earlier pages are gone.'] : [],
    };
    const notice = (text: string) => {
      if (session.notices.length < 10 && !session.notices.includes(text)) session.notices.push(text);
    };

    // Every request a page makes (frames, scripts, fetches, redirects) is checked; the proxy enforces it again
    await context.route('**/*', async (route) => {
      const reason = requestRefusal(route.request().url(), await this.policy());
      if (reason) {
        if (route.request().isNavigationRequest()) notice(`Blocked: ${reason}`);
        await route.abort('blockedbyclient').catch(() => {});
      } else {
        await route.fallback().catch(() => {});
      }
    });
    await context.routeWebSocket(/.*/, async (ws) => {
      const reason = requestRefusal(ws.url(), await this.policy());
      if (reason) await ws.close({ code: 1008, reason: 'Blocked' }).catch(() => {});
      else ws.connectToServer();
    });

    context.on('page', (page) => {
      if (session.pages.includes(page)) return;
      if (session.pages.length >= settings.maxTabs) {
        notice(`A page tried to open another tab; only ${settings.maxTabs} are allowed.`);
        void page.close().catch(() => {});
        return;
      }
      this.watchPage(session, page, notice);
      session.pages.push(page);
      session.active = session.pages.length - 1;
      notice('A new tab opened and is now the current tab (browser_tabs lists them).');
    });
    const first = await context.newPage();
    if (!session.pages.includes(first)) {
      this.watchPage(session, first, notice);
      session.pages.push(first);
    }
    session.active = 0;
    session.notices = session.notices.filter((n) => !n.startsWith('A new tab opened'));
    this.sessions.set(key, session);
    return session;
  }

  private watchPage(session: Session, page: Page, notice: (text: string) => void): void {
    page.on('dialog', (dialog) => {
      notice(`The page showed a ${dialog.type()} dialog ("${dialog.message().slice(0, 200)}"), which was dismissed.`);
      void dialog.dismiss().catch(() => {});
    });
    page.on('filechooser', () => notice('The page asked for a file to upload; uploads are not supported.'));
    page.on('download', (d) => notice(`The page started a download (${d.suggestedFilename()}); downloads are not supported.`));
    page.on('close', () => {
      const i = session.pages.indexOf(page);
      if (i < 0) return;
      session.pages.splice(i, 1);
      if (session.active >= session.pages.length) session.active = Math.max(0, session.pages.length - 1);
    });
  }

  private async reap(): Promise<void> {
    const s = await this.opts.settings();
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (session.busy > 0) continue;
      if (now - session.lastUsed > s.idleMinutes * 60_000 || now - session.createdAt > s.maxSessionMinutes * 60_000) {
        await this.closeSession(session);
      }
    }
  }

  /** Close every session of a chat (the chat was deleted). */
  async closeChat(userId: string, chatId: string): Promise<void> {
    const prefix = this.mapKey(userId, chatId);
    for (const s of [...this.sessions.values()]) {
      if (s.key === prefix || s.key.startsWith(`${prefix}:`)) await this.closeSession(s);
    }
  }

  /** Close every session of a user (signed out everywhere, disabled, deleted). */
  async closeUser(userId: string): Promise<void> {
    for (const s of [...this.sessions.values()]) {
      if (s.userId === userId) await this.closeSession(s);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.reaper);
    for (const s of [...this.sessions.values()]) await this.closeSession(s);
    const browser = await this.browser?.catch(() => null);
    this.browser = null;
    await browser?.close().catch(() => {});
    await this.proxy?.close();
  }

  // ─── Actions ───────────────────────────────────────────────────────────────

  /** Run one action in the chat's session (one at a time per chat). */
  async run(userId: string, sessionKey: string, action: BrowserAction): Promise<BrowserReply> {
    const settings = await this.opts.settings();
    if (action.type === 'close') {
      const s = this.sessions.get(this.mapKey(userId, sessionKey));
      if (s) await this.closeSession(s);
      return { text: 'The browser is closed.' };
    }
    let session: Session;
    try {
      session = await this.session(userId, sessionKey, settings);
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), isError: true };
    }
    session.busy++;
    const job = session.queue.then(() => this.act(session, action, settings));
    session.queue = job.catch(() => {});
    try {
      return await job;
    } finally {
      session.busy--;
      session.lastUsed = Date.now();
    }
  }

  private page(session: Session): Page {
    const page = session.pages[session.active];
    if (!page) throw new Error('No tab is open. Use browser_navigate to open a page.');
    return page;
  }

  /** The element a ref names, or an error at once when it's gone (no waiting for the action timeout). */
  private async locator(session: Session, ref: string): Promise<Locator> {
    const target = this.page(session).getByRef(ref);
    if ((await target.count().catch(() => 0)) === 0) {
      throw new Error(`There is no element ${ref} on the page now.`);
    }
    return target;
  }

  /** The tab as the model reads it: a header, notices, then the page's elements. */
  private async describe(session: Session, outcome: string, settings: BrowserSettings): Promise<string> {
    const page = this.page(session);
    const notices = session.notices.splice(0);
    const blocked = session.egress.blocked.splice(0).map((b) => `Blocked: ${b}`);
    return pageText({
      outcome,
      tab: session.active + 1,
      tabs: session.pages.length,
      title: await page.title().catch(() => ''),
      url: page.url(),
      notices: [...new Set([...notices, ...blocked])],
      snapshot: await page.ariaSnapshot({ mode: 'ai', timeout: settings.actionTimeoutSeconds * 1000 }).catch((err) => `(The page couldn't be read: ${cleanError(err)})`),
      maxChars: settings.snapshotMaxChars,
    });
  }

  /** A navigation the egress proxy refused (plain http: it answers itself), as an error result. */
  private refusal(session: Session, res: Response | null): BrowserReply | null {
    if (!res?.headers()[BLOCKED_HEADER]) return null;
    const reason = session.egress.blocked.at(-1) ?? 'The address is not allowed.';
    session.egress.blocked.length = 0;
    return { text: `Blocked: ${reason} (${res.url()})`, isError: true };
  }

  /** Give a page a moment to react (navigation, scripts) after an action. */
  private async settle(page: Page): Promise<void> {
    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(400).catch(() => {});
  }

  private async act(session: Session, action: BrowserAction, settings: BrowserSettings): Promise<BrowserReply> {
    try {
      switch (action.type) {
        case 'navigate': {
          const url = checkNavigation(action.url, await this.policy());
          const page = session.pages[session.active] ?? (await session.context.newPage());
          const res = await page.goto(url.href, { waitUntil: 'domcontentloaded' });
          const refused = this.refusal(session, res);
          if (refused) return refused;
          await page.waitForLoadState('load', { timeout: 3_000 }).catch(() => {});
          const status = res && res.status() >= 400 ? ` The site answered ${res.status()}.` : '';
          return { text: await this.describe(session, `Opened ${page.url()}.${status}`, settings) };
        }
        case 'snapshot':
          return { text: await this.describe(session, 'The current page.', settings) };
        case 'click': {
          await (await this.locator(session, action.ref)).click({ button: action.button ?? 'left', clickCount: action.doubleClick ? 2 : 1 });
          await this.settle(this.page(session));
          return { text: await this.describe(session, `Clicked ${action.element}.`, settings) };
        }
        case 'type': {
          const target = await this.locator(session, action.ref);
          if (action.slowly) {
            await target.fill('');
            await target.pressSequentially(action.text, { delay: 30 });
          } else {
            await target.fill(action.text);
          }
          if (action.submit) await target.press('Enter');
          await this.settle(this.page(session));
          return { text: await this.describe(session, `Typed into ${action.element}${action.submit ? ' and pressed Enter' : ''}.`, settings) };
        }
        case 'select': {
          const chosen = await (await this.locator(session, action.ref)).selectOption(action.values);
          await this.settle(this.page(session));
          return { text: await this.describe(session, `Chose ${chosen.join(', ') || 'nothing'} in ${action.element}.`, settings) };
        }
        case 'press_key': {
          if (action.ref) await (await this.locator(session, action.ref)).press(action.key);
          else await this.page(session).keyboard.press(action.key);
          await this.settle(this.page(session));
          return { text: await this.describe(session, `Pressed ${action.key}${action.element ? ` in ${action.element}` : ''}.`, settings) };
        }
        case 'scroll': {
          const page = this.page(session);
          if (action.ref) await (await this.locator(session, action.ref)).scrollIntoViewIfNeeded();
          else await page.mouse.wheel(0, (action.direction === 'up' ? -1 : 1) * VIEWPORT.height * (action.pages ?? 1));
          await page.waitForTimeout(300);
          return { text: await this.describe(session, action.ref ? 'Scrolled the element into view.' : `Scrolled ${action.direction}.`, settings) };
        }
        case 'screenshot': {
          if (!settings.screenshots) return { text: 'Screenshots are turned off on this server; use browser_snapshot.', isError: true };
          const page = this.page(session);
          const opts = { type: 'jpeg' as const, quality: SCREENSHOT_QUALITY };
          let data: Buffer;
          if (action.ref) data = await (await this.locator(session, action.ref)).screenshot(opts);
          else if (action.fullPage) {
            const height = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => VIEWPORT.height);
            data =
              height > MAX_SHOT_HEIGHT
                ? await page.screenshot({ ...opts, fullPage: true, clip: { x: 0, y: 0, width: VIEWPORT.width, height: MAX_SHOT_HEIGHT } })
                : await page.screenshot({ ...opts, fullPage: true });
          } else data = await page.screenshot(opts);
          const title = await page.title().catch(() => '');
          return {
            text: `Screenshot of tab ${session.active + 1} · ${title || '(no title)'} · ${page.url()}${action.fullPage ? ' (whole page)' : ''}`,
            image: { mime: 'image/jpeg', data: data.toString('base64') },
          };
        }
        case 'back': {
          const page = this.page(session);
          const res = await page.goBack({ waitUntil: 'domcontentloaded' });
          const refused = this.refusal(session, res);
          if (refused) return refused;
          return { text: await this.describe(session, res ? 'Went back.' : 'There is no earlier page in this tab.', settings) };
        }
        case 'tabs':
          return await this.tabs(session, action, settings);
        case 'wait': {
          const page = this.page(session);
          if (action.text) {
            await page.getByText(action.text).first().waitFor({ state: 'visible', timeout: 10_000 });
          } else {
            await page.waitForTimeout(Math.min(10, action.seconds ?? 2) * 1000);
          }
          return { text: await this.describe(session, action.text ? `"${action.text}" is on the page.` : 'Waited.', settings) };
        }
        case 'close':
          return { text: 'The browser is closed.' };
      }
    } catch (err) {
      const message = err instanceof BlockedRequestError ? err.message : cleanError(err);
      const ref = 'ref' in action && action.ref ? action.ref : null;
      const blocked = session.egress.blocked.at(-1);
      const hint = /net::ERR_(TUNNEL_CONNECTION_FAILED|PROXY|BLOCKED_BY_CLIENT|FAILED)/.test(message) && blocked
        ? ` ${blocked}`
        : ref && /timeout|not found|no element|resolved to|strict mode/i.test(message)
          ? ` The element ${ref} wasn't found or can't be used right now; take a new snapshot and use a current ref.`
          : '';
      const page = session.pages[session.active];
      const where = page ? ` (tab ${session.active + 1}: ${page.url()})` : '';
      return { text: `${message}${hint}${where}`, isError: true };
    }
  }

  private async tabs(session: Session, action: Extract<BrowserAction, { type: 'tabs' }>, settings: BrowserSettings): Promise<BrowserReply> {
    const list = async () => {
      const lines = await Promise.all(
        session.pages.map(async (p, i) => `${i + 1}. ${(await p.title().catch(() => '')) || '(no title)'} · ${p.url()}${i === session.active ? '  ← current' : ''}`)
      );
      return lines.join('\n') || 'No tabs are open.';
    };
    const index = (action.index ?? session.active + 1) - 1;
    switch (action.action) {
      case 'list':
        return { text: `Open tabs:\n${await list()}` };
      case 'select': {
        if (!session.pages[index]) return { text: `There is no tab ${index + 1}.\n${await list()}`, isError: true };
        session.active = index;
        await session.pages[index].bringToFront().catch(() => {});
        return { text: await this.describe(session, `Switched to tab ${index + 1}.`, settings) };
      }
      case 'new': {
        if (session.pages.length >= settings.maxTabs) return { text: `Only ${settings.maxTabs} tabs may be open; close one first.`, isError: true };
        const url = action.url ? checkNavigation(action.url, await this.policy()) : null;
        const page = await session.context.newPage();
        if (!session.pages.includes(page)) session.pages.push(page);
        session.active = session.pages.indexOf(page);
        session.notices = session.notices.filter((n) => !n.startsWith('A new tab opened'));
        if (url) {
          const refused = this.refusal(session, await page.goto(url.href, { waitUntil: 'domcontentloaded' }));
          if (refused) return refused;
        }
        return { text: await this.describe(session, `Opened tab ${session.active + 1}.`, settings) };
      }
      case 'close': {
        const page = session.pages[index];
        if (!page) return { text: `There is no tab ${index + 1}.\n${await list()}`, isError: true };
        await page.close();
        if (session.pages.length === 0) {
          await this.closeSession(session);
          return { text: 'Closed the last tab; the browser is closed.' };
        }
        return { text: await this.describe(session, `Closed tab ${index + 1}.`, settings) };
      }
    }
  }
}

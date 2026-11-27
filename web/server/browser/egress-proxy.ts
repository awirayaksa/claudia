/**
 * The built-in browser's only way out: an HTTP proxy (CONNECT for https and
 * WebSockets, absolute-URI requests for plain http) that every browser
 * context is pointed at, with its own credentials.
 *
 * For every connection it checks the host against the domain rules,
 * resolves it once through the SSRF guard and connects to exactly the
 * address it checked. With a proxy set, Chromium doesn't resolve names
 * itself, so a page can't reach a private address by redirecting, by DNS
 * rebinding or from a script: everything goes through here.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { resolvePublic } from '../net/safe-fetch';
import { domainRefusal, type BrowserNetPolicy } from './policy';

const DEFAULT_PORTS = new Set([80, 443, 8080, 8443]);
/** Hop-by-hop headers (RFC 9110) plus the proxy's own, never forwarded. */
const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface EgressSession {
  readonly username: string;
  readonly password: string;
  /** Bytes in and out so far. */
  bytes: number;
  readonly sockets: Set<Duplex>;
  /** Recent refusals, newest last, for the next tool result. */
  readonly blocked: string[];
}

export interface EgressProxyOptions {
  policy: () => BrowserNetPolicy;
  /** Test hook: resolve names without real DNS. */
  lookup?: typeof dns.lookup;
  /** Per session, in and out (default 500 MB). */
  maxBytes?: number;
  /** Open connections per session (default 64). */
  maxSockets?: number;
  /** Ports pages may connect to (default 80, 443, 8080, 8443). */
  ports?: Set<number>;
  connectTimeoutMs?: number;
}

const REALM = 'Basic realm="claudia-browser"';
/** On the proxy's own refusals (plain http), so the browser tells them from a site's 403. */
export const BLOCKED_HEADER = 'x-claudia-blocked';

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** "example.com:443", "[::1]:443" → host and port. */
export function parseAuthority(authority: string): { host: string; port: number } | null {
  const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(authority.trim());
  if (!m) return null;
  const port = Number(m[2]);
  if (!port || port > 65_535) return null;
  return { host: m[1].replace(/^\[|\]$/g, ''), port };
}

export class EgressProxy {
  private readonly server: http.Server;
  private readonly sessions = new Map<string, EgressSession>();
  private readonly maxBytes: number;
  private readonly maxSockets: number;
  private readonly ports: Set<number>;
  private readonly connectTimeoutMs: number;

  constructor(private readonly opts: EgressProxyOptions) {
    this.maxBytes = opts.maxBytes ?? 500 * 1024 * 1024;
    this.maxSockets = opts.maxSockets ?? 64;
    this.ports = opts.ports ?? DEFAULT_PORTS;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 15_000;
    this.server = http.createServer((req, res) => void this.onRequest(req, res));
    this.server.on('connect', (req, socket, head) => void this.onConnect(req, socket, head));
    // Clients that misbehave just lose their connection
    this.server.on('clientError', (_err, socket) => socket.destroy());
  }

  /** Start listening (default: loopback, a free port). */
  listen(host = '127.0.0.1', port = 0): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        const addr = this.server.address() as net.AddressInfo;
        resolve({ host: addr.address, port: addr.port });
      });
    });
  }

  /** New credentials for one browser context. */
  register(): EgressSession {
    const session: EgressSession = {
      username: `s${randomBytes(9).toString('hex')}`,
      password: randomBytes(18).toString('base64url'),
      bytes: 0,
      sockets: new Set(),
      blocked: [],
    };
    this.sessions.set(session.username, session);
    return session;
  }

  /** Forget a session and cut its connections. */
  unregister(session: EgressSession): void {
    this.sessions.delete(session.username);
    for (const s of session.sockets) s.destroy();
    session.sockets.clear();
  }

  async close(): Promise<void> {
    for (const s of this.sessions.values()) this.unregister(s);
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // ─── Checks ────────────────────────────────────────────────────────────────

  private authenticate(header: string | undefined): EgressSession | null {
    const m = /^Basic\s+(.+)$/i.exec(header ?? '');
    if (!m) return null;
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    const session = this.sessions.get(decoded.slice(0, colon));
    return session && safeEqual(session.password, decoded.slice(colon + 1)) ? session : null;
  }

  private refuse(session: EgressSession, reason: string): string {
    session.blocked.push(reason);
    if (session.blocked.length > 20) session.blocked.shift();
    return reason;
  }

  /** The address to connect to, or why not. */
  private async target(session: EgressSession, host: string, port: number): Promise<{ address: string } | { error: string; status: number }> {
    if (!this.ports.has(port)) return { error: this.refuse(session, `Port ${port} is not allowed (${host}).`), status: 403 };
    if (session.sockets.size >= this.maxSockets * 2) return { error: 'Too many open connections.', status: 503 };
    if (session.bytes > this.maxBytes) return { error: this.refuse(session, 'This browser session has used its data allowance.'), status: 403 };
    const policy = this.opts.policy();
    const refusal = domainRefusal(host, policy);
    if (refusal) return { error: this.refuse(session, refusal), status: 403 };
    try {
      const { address } = await resolvePublic(host, policy.net, this.opts.lookup);
      return { address };
    } catch (err) {
      return { error: this.refuse(session, err instanceof Error ? err.message : String(err)), status: 403 };
    }
  }

  /** Count traffic on a socket against the session, and forget it once closed. */
  private track(session: EgressSession, socket: Duplex): void {
    session.sockets.add(socket);
    socket.on('data', (chunk: Buffer) => {
      session.bytes += chunk.length;
      if (session.bytes > this.maxBytes) socket.destroy();
    });
    socket.once('close', () => session.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  }

  // ─── CONNECT (https, wss) ──────────────────────────────────────────────────

  private async onConnect(req: http.IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    client.on('error', () => client.destroy());
    const reply = (status: string, extra = ''): void => {
      client.end(`HTTP/1.1 ${status}\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`);
    };
    const session = this.authenticate(req.headers['proxy-authorization']);
    if (!session) return reply('407 Proxy Authentication Required', `Proxy-Authenticate: ${REALM}\r\n`);
    const authority = parseAuthority(req.url ?? '');
    if (!authority) return reply('400 Bad Request');
    const target = await this.target(session, authority.host, authority.port);
    if ('error' in target) return reply(target.status === 503 ? '503 Service Unavailable' : '403 Forbidden');

    this.track(session, client);
    const upstream = net.connect({ host: target.address, port: authority.port });
    upstream.setTimeout(this.connectTimeoutMs, () => upstream.destroy());
    this.track(session, upstream);
    upstream.once('connect', () => {
      upstream.setTimeout(0);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once('error', () => {
      if (!client.destroyed) reply('502 Bad Gateway');
    });
    upstream.once('close', () => client.destroy());
    client.once('close', () => upstream.destroy());
  }

  // ─── Plain http (absolute-URI requests) ────────────────────────────────────

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const session = this.authenticate(req.headers['proxy-authorization']);
    if (!session) {
      res.writeHead(407, { 'Proxy-Authenticate': REALM, 'Content-Length': '0' }).end();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (url.protocol !== 'http:') {
      res.writeHead(400).end();
      return;
    }
    const port = Number(url.port || 80);
    const target = await this.target(session, url.hostname, port);
    if ('error' in target) {
      res.writeHead(target.status, { 'Content-Type': 'text/plain; charset=utf-8', [BLOCKED_HEADER]: '1' }).end(target.error);
      return;
    }

    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!HOP_HEADERS.has(name) && value !== undefined) headers[name] = value;
    }
    headers.host = url.host;
    const upstream = http.request({
      host: target.address,
      port,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers,
      setHost: false,
      timeout: this.connectTimeoutMs,
      // A connection per request: never one shared with another session
      agent: false,
    });
    upstream.on('socket', (s) => this.track(session, s));
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
    upstream.on('response', (up) => {
      const out: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(up.headers)) {
        if (!HOP_HEADERS.has(name) && value !== undefined) out[name] = value;
      }
      res.writeHead(up.statusCode ?? 502, out);
      up.pipe(res);
    });
    req.pipe(upstream);
  }
}

/**
 * SSRF guard for every request to a user-controlled URL.
 *
 * - http(s) only;
 * - every address the host resolves to must be public (no loopback, private,
 *   link-local, CGNAT, multicast, unspecified — IPv4-mapped IPv6 included);
 * - the connection goes to the address that was checked (custom lookup), so
 *   DNS rebinding can't swap it;
 * - redirects are followed by hand (max 5) and every hop is checked again;
 * - response size and time are capped.
 *
 * Admin-configured global connections don't go through this (they may target
 * an internal Ollama). For user URLs the only exception is the admin allowlist.
 */
import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit, type Response as UndiciResponse } from 'undici';

export class BlockedRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedRequestError';
  }
}

// ─── Address classification ──────────────────────────────────────────────────

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], // "this network", unspecified
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata lives here)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  blocked.addSubnet(addr, prefix, 'ipv4');
}
for (const [addr, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64 (embeds IPv4)
  ['64:ff9b:1::', 48],
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds IPv4)
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(addr, prefix, 'ipv6');
}

/** "::ffff:10.0.0.1" / "::ffff:a00:1" → "10.0.0.1"; anything else unchanged. */
export function unmapIPv4(address: string): string {
  const lower = address.toLowerCase();
  const dotted = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return address;
}

/** True when the address is not on the public internet. */
export function isBlockedAddress(address: string): boolean {
  const plain = unmapIPv4(address.replace(/^\[|\]$/g, '').split('%')[0]);
  const family = net.isIP(plain);
  if (family === 4) return blocked.check(plain, 'ipv4');
  if (family === 6) {
    // IPv4-compatible (::a.b.c.d) addresses carry an IPv4 address too
    const compat = /^::(\d+\.\d+\.\d+\.\d+)$/.exec(plain);
    if (compat) return blocked.check(compat[1], 'ipv4');
    return blocked.check(plain, 'ipv6');
  }
  return true; // not an IP at all: refuse
}

// ─── Allowlist ───────────────────────────────────────────────────────────────

export interface SafeFetchPolicy {
  /** Hostnames (exact, or "*.example.com") and CIDRs users may reach although private. */
  allow?: string[];
}

function hostAllowed(hostname: string, policy: SafeFetchPolicy): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return (policy.allow ?? []).some((entry) => {
    const e = entry.toLowerCase().trim();
    if (e.startsWith('*.')) return host.endsWith(e.slice(1));
    return host === e;
  });
}

function addressAllowed(address: string, policy: SafeFetchPolicy): boolean {
  const plain = unmapIPv4(address);
  for (const entry of policy.allow ?? []) {
    const [base, bits] = entry.split('/');
    if (!bits) {
      if (net.isIP(base) && base === plain) return true;
      continue;
    }
    const family = net.isIP(base);
    if (!family || net.isIP(plain) !== family) continue;
    const list = new net.BlockList();
    list.addSubnet(base, Number(bits), family === 4 ? 'ipv4' : 'ipv6');
    if (list.check(plain, family === 4 ? 'ipv4' : 'ipv6')) return true;
  }
  return false;
}

// ─── Fetch ───────────────────────────────────────────────────────────────────

export interface SafeFetchOptions extends Omit<UndiciRequestInit, 'redirect' | 'dispatcher'> {
  policy?: SafeFetchPolicy;
  /** Default 5. */
  maxRedirects?: number;
  /** Whole request, including redirects. Default 30 s. */
  timeoutMs?: number;
  /** Larger bodies fail while being read with readBodyLimited. Default 10 MB. */
  maxBytes?: number;
  /** Test hook: resolve names without real DNS. */
  lookup?: typeof dns.lookup;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

function guardedLookup(policy: SafeFetchPolicy, base: typeof dns.lookup) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback) => {
    base(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const list = addresses as dns.LookupAddress[];
      if (list.length === 0) return callback(new BlockedRequestError(`${hostname} did not resolve`), []);
      const allowed = hostAllowed(hostname, policy);
      // Every address must pass: a mixed answer could hand us a private one later
      const bad = list.find((a) => isBlockedAddress(a.address) && !allowed && !addressAllowed(a.address, policy));
      if (bad) {
        return callback(new BlockedRequestError(`${hostname} resolves to a non-public address (${bad.address})`), []);
      }
      if (options.all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };
}

function checkUrl(url: URL, policy: SafeFetchPolicy): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedRequestError(`Only http and https URLs are allowed (got ${url.protocol})`);
  }
  if (url.username || url.password) {
    throw new BlockedRequestError('URLs with credentials are not allowed');
  }
  // IP literals never reach the resolver, so check them here
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(unmapIPv4(host)) || net.isIP(host)) {
    if (isBlockedAddress(host) && !addressAllowed(host, policy) && !hostAllowed(host, policy)) {
      throw new BlockedRequestError(`${host} is not a public address`);
    }
  }
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * fetch() for user-controlled URLs. Throws BlockedRequestError when the URL
 * or any redirect hop points somewhere it shouldn't.
 */
export async function safeFetch(input: string | URL, opts: SafeFetchOptions = {}): Promise<UndiciResponse> {
  const { policy = {}, maxRedirects = 5, timeoutMs = 30_000, lookup = dns.lookup, maxBytes: _maxBytes, ...init } = opts;
  const agent = new Agent({ connect: { lookup: guardedLookup(policy, lookup) as never } });
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal as AbortSignal, timeout]) : timeout;

  let url = new URL(input);
  let method = (init.method ?? 'GET').toUpperCase();
  let body = init.body;
  try {
    for (let hop = 0; ; hop++) {
      checkUrl(url, policy);
      const res = await undiciFetch(url, { ...init, method, body, signal, redirect: 'manual', dispatcher: agent });
      if (!REDIRECT_CODES.has(res.status)) return res;

      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!location) return res;
      if (hop >= maxRedirects) throw new BlockedRequestError(`Too many redirects (more than ${maxRedirects})`);
      url = new URL(location, url);
      // 303, and 301/302 after POST, continue as GET without a body (browser behaviour)
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
    }
  } catch (err) {
    // undici wraps connect errors; surface our own reason
    const cause = (err as { cause?: unknown })?.cause;
    if (cause instanceof BlockedRequestError) throw cause;
    throw err;
  }
}

/** Read a response body, failing once it grows past `maxBytes`. */
export async function readBodyLimited(res: UndiciResponse, maxBytes = 10 * 1024 * 1024): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new BlockedRequestError(`Response is larger than ${maxBytes} bytes`);
  const chunks: Buffer[] = [];
  let total = 0;
  if (!res.body) return Buffer.alloc(0);
  for await (const chunk of res.body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      await res.body.cancel().catch(() => {});
      throw new BlockedRequestError(`Response is larger than ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

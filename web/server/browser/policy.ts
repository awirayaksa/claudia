/**
 * Where the built-in browser may go: the admin's allowed and blocked sites
 * on top of the SSRF guard (public addresses only, unless net.allowlist).
 */
import { BlockedRequestError, checkUserUrl, type SafeFetchPolicy } from '../net/safe-fetch';

export interface BrowserNetPolicy {
  /** The SSRF guard's allowlist (net.allowlist). */
  net: SafeFetchPolicy;
  /** Empty = any site. */
  allowedDomains: string[];
  blockedDomains: string[];
}

/** "example.com" matches it and its subdomains; "*.example.com" only the subdomains. */
export function domainMatches(host: string, rule: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  const r = rule.toLowerCase().trim().replace(/\.$/, '');
  if (!r) return false;
  if (r.startsWith('*.')) return h.endsWith(r.slice(1));
  return h === r || h.endsWith(`.${r}`);
}

/** Why the browser may not open this host, or null when it may (domain rules only). */
export function domainRefusal(host: string, policy: Pick<BrowserNetPolicy, 'allowedDomains' | 'blockedDomains'>): string | null {
  if (policy.blockedDomains.some((r) => domainMatches(host, r))) return `${host} is blocked by the administrator.`;
  if (policy.allowedDomains.length > 0 && !policy.allowedDomains.some((r) => domainMatches(host, r))) {
    return `${host} is not on the list of sites the browser may open.`;
  }
  return null;
}

/** Schemes a page may load besides http(s): its own inline content. */
const INLINE_SCHEMES = new Set(['data:', 'blob:', 'about:']);

/**
 * Check a URL the model asked to open: http(s) only (about:blank too), no
 * credentials, no private IP literal, within the domain rules. Throws
 * BlockedRequestError with the reason.
 */
export function checkNavigation(input: string, policy: BrowserNetPolicy): URL {
  if (input.trim() === 'about:blank') return new URL('about:blank');
  const url = checkUserUrl(input, policy.net);
  const refusal = domainRefusal(url.hostname, policy);
  if (refusal) throw new BlockedRequestError(refusal);
  return url;
}

/**
 * Check a request a page makes (scripts, images, frames, fetches): inline
 * content is fine, http(s) within the rules, anything else (file:, chrome:,
 * ftp:, ...) is refused. Null when allowed, else the reason.
 */
export function requestRefusal(input: string, policy: BrowserNetPolicy): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return 'Not a valid URL.';
  }
  if (INLINE_SCHEMES.has(url.protocol)) return null;
  if (url.protocol === 'ws:' || url.protocol === 'wss:') url = new URL(input.replace(/^ws/, 'http'));
  try {
    checkUserUrl(url, policy.net);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return domainRefusal(url.hostname, policy);
}

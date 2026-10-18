/**
 * Transport for admin connections set to skip TLS certificate verification:
 * endpoints with a self-signed certificate or one from an internal CA that
 * this server doesn't trust. The connection is still encrypted, but the
 * server's identity isn't checked, so anyone who can intercept the traffic
 * can impersonate the endpoint (and read the API key).
 *
 * User-owned connections never use this: they go through the SSRF guard.
 */
import http from 'node:http';
import https from 'node:https';
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';
import type { ProviderHttp } from '../../../src/types/api.types';

let transport: Required<ProviderHttp> | undefined;

export function insecureTlsTransport(): Required<ProviderHttp> {
  if (!transport) {
    const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    const insecureFetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' || input instanceof URL ? input : input.url;
      return undiciFetch(url, { ...(init as UndiciRequestInit), dispatcher });
    };
    transport = {
      fetch: insecureFetch as unknown as typeof fetch,
      httpAgent: new http.Agent({ keepAlive: true }),
      httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false }),
    };
  }
  return transport;
}

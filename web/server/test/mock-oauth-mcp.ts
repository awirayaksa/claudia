/**
 * An MCP server behind OAuth, on localhost, for tests: protected-resource
 * and authorization-server metadata, dynamic client registration, PKCE
 * (S256), the code and refresh grants, token revocation, and a stateless
 * streamable-HTTP MCP endpoint (one `echo` tool) that wants a bearer token.
 *
 * There is no login page: `approve(authorizeUrl)` stands for the user
 * signing in, and returns the code the browser would bring back.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export interface MockOAuthMcp {
  /** The MCP endpoint. */
  url: string;
  /** Clients registered dynamically. */
  clients: Array<{ client_id: string; redirect_uris: string[] }>;
  /** Grant types of the token requests, in order. */
  grants: string[];
  /** Bearer tokens the MCP endpoint received. */
  bearers: string[];
  /** Tokens revoked. */
  revoked: string[];
  echoes: string[];
  /** The user signs in: the code for an authorization URL Claudia sent the browser to. */
  approve(authorizeUrl: string): string;
  /** Make every access token so far invalid (as if it expired). */
  expireAccessTokens(): void;
  close(): Promise<void>;
}

const b64url = (buf: Buffer) => buf.toString('base64url');

export async function startMockOAuthMcp(): Promise<MockOAuthMcp> {
  const clients: MockOAuthMcp['clients'] = [];
  const grants: string[] = [];
  const bearers: string[] = [];
  const revoked: string[] = [];
  const echoes: string[] = [];
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>();
  const access = new Set<string>();
  const refresh = new Set<string>();
  let base = '';

  const issue = () => {
    const at = `at-${crypto.randomBytes(8).toString('hex')}`;
    const rt = `rt-${crypto.randomBytes(8).toString('hex')}`;
    access.add(at);
    refresh.add(rt);
    return { access_token: at, token_type: 'Bearer', expires_in: 3600, refresh_token: rt };
  };

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const mcpServer = () => {
    const server = new McpServer({ name: 'oauth-mock', version: '1.0.0' });
    server.registerTool('echo', { description: 'Echo text back', inputSchema: { text: z.string() } }, async (args) => {
      echoes.push(args.text);
      return { content: [{ type: 'text' as const, text: `echo: ${args.text}` }] };
    });
    return server;
  };

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf-8');

    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'] });
    }
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server') || url.pathname.startsWith('/.well-known/openid-configuration')) {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        revocation_endpoint: `${base}/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      });
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      const meta = JSON.parse(raw);
      const client = { ...meta, client_id: `client-${clients.length + 1}`, client_id_issued_at: Math.floor(Date.now() / 1000) };
      clients.push(client);
      return json(res, 201, client);
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const p = new URLSearchParams(raw);
      const grant = p.get('grant_type') ?? '';
      grants.push(grant);
      if (grant === 'authorization_code') {
        const code = codes.get(p.get('code') ?? '');
        codes.delete(p.get('code') ?? '');
        const verifier = p.get('code_verifier') ?? '';
        const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
        if (!code || code.challenge !== challenge || code.redirectUri !== p.get('redirect_uri') || code.clientId !== p.get('client_id')) {
          return json(res, 400, { error: 'invalid_grant' });
        }
        return json(res, 200, issue());
      }
      if (grant === 'refresh_token') {
        const rt = p.get('refresh_token') ?? '';
        if (!refresh.has(rt)) return json(res, 400, { error: 'invalid_grant' });
        refresh.delete(rt);
        return json(res, 200, issue());
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === '/revoke' && req.method === 'POST') {
      const token = new URLSearchParams(raw).get('token') ?? '';
      revoked.push(token);
      access.delete(token);
      refresh.delete(token);
      res.writeHead(200);
      return res.end();
    }
    if (url.pathname === '/mcp') {
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (bearer) bearers.push(bearer);
      if (!bearer || !access.has(bearer)) {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        });
        return res.end(JSON.stringify({ error: 'invalid_token' }));
      }
      const server = mcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      return transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

  return {
    url: `${base}/mcp`,
    clients,
    grants,
    bearers,
    revoked,
    echoes,
    approve(authorizeUrl) {
      const u = new URL(authorizeUrl);
      if (u.searchParams.get('code_challenge_method') !== 'S256') throw new Error('PKCE S256 expected');
      const code = `code-${crypto.randomBytes(6).toString('hex')}`;
      codes.set(code, {
        challenge: u.searchParams.get('code_challenge') ?? '',
        redirectUri: u.searchParams.get('redirect_uri') ?? '',
        clientId: u.searchParams.get('client_id') ?? '',
      });
      return code;
    },
    expireAccessTokens() {
      access.clear();
    },
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}

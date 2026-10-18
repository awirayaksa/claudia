/**
 * A tiny OpenID Connect provider for tests: discovery, JWKS, an authorize
 * endpoint that signs in `nextUser` at once, a token endpoint that checks
 * the client secret and PKCE, and userinfo. Tests can tamper with the ID
 * token (`idTokenOverrides`) to check the relying party's validation.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

export interface FakeUser {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  groups?: string[];
}

export interface FakeOidc {
  issuer: string;
  clientId: string;
  clientSecret: string;
  nextUser: FakeUser;
  /** Claims merged into the next ID token (e.g. { aud: 'other' }). */
  idTokenOverrides: Record<string, unknown>;
  /** Sign the next ID token with a key not in the JWKS. */
  useRogueKey: boolean;
  /** Token requests received (form fields and auth header). */
  tokenRequests: Array<{ form: Record<string, string>; authorization?: string }>;
  close(): Promise<void>;
}

export async function startFakeOidc(): Promise<FakeOidc> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const rogue = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { user: FakeUser; nonce: string; challenge: string; redirectUri: string }>();

  const fake = {
    clientId: 'claudia-test',
    clientSecret: 'fake-oidc-secret',
    nextUser: { sub: 'u-1', email: 'sso.user@example.com', email_verified: true, name: 'Sso User' },
    idTokenOverrides: {},
    useRogueKey: false,
    tokenRequests: [],
  } as unknown as FakeOidc;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', fake.issuer);
    let body = '';
    for await (const c of req) body += c;
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };

    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: fake.issuer,
        authorization_endpoint: `${fake.issuer}/authorize`,
        token_endpoint: `${fake.issuer}/token`,
        jwks_uri: `${fake.issuer}/jwks`,
        userinfo_endpoint: `${fake.issuer}/userinfo`,
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/authorize') {
      const p = url.searchParams;
      if (p.get('client_id') !== fake.clientId || p.get('code_challenge_method') !== 'S256') return json(400, { error: 'invalid_request' });
      const code = randomBytes(12).toString('hex');
      codes.set(code, { user: { ...fake.nextUser }, nonce: p.get('nonce') ?? '', challenge: p.get('code_challenge') ?? '', redirectUri: p.get('redirect_uri') ?? '' });
      const back = new URL(p.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', p.get('state') ?? '');
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(body));
      fake.tokenRequests.push({ form, authorization: req.headers.authorization });
      const expected = `Basic ${Buffer.from(`${fake.clientId}:${fake.clientSecret}`).toString('base64')}`;
      if (req.headers.authorization !== expected && form.client_secret !== fake.clientSecret) return json(401, { error: 'invalid_client' });
      const grant = codes.get(form.code);
      codes.delete(form.code);
      if (!grant) return json(400, { error: 'invalid_grant' });
      const challenge = createHash('sha256').update(form.code_verifier ?? '').digest('base64url');
      if (challenge !== grant.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      if (form.redirect_uri !== grant.redirectUri) return json(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      const { sub, ...claims } = grant.user;
      const token = await new SignJWT({ ...claims, nonce: grant.nonce, ...fake.idTokenOverrides })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        // Overrides win, so tests can forge the issuer or audience
        .setIssuer(String(fake.idTokenOverrides.iss ?? fake.issuer))
        .setAudience(String(fake.idTokenOverrides.aud ?? fake.clientId))
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(fake.useRogueKey ? rogue.privateKey : privateKey);
      return json(200, { access_token: `at-${sub}`, token_type: 'Bearer', expires_in: 300, id_token: token });
    }
    if (url.pathname === '/userinfo') return json(200, { sub: fake.nextUser.sub, email: fake.nextUser.email });
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise((resolve) => server.close(() => resolve()));
  return fake;
}

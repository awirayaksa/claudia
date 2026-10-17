import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { openDatabase } from './db/client';
import { buildSandboxApp, sandboxOriginFor } from './sandbox';
import { MIGRATIONS_DIR, TEST_SECRET, testConfig } from './test/helpers';

const SANDBOX_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'sandbox');

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function app(env: Record<string, string>) {
  const db = await openDatabase({});
  await db.migrate(MIGRATIONS_DIR);
  const a = await buildApp({
    config: testConfig(env),
    db,
    migrationsDir: MIGRATIONS_DIR,
    rootSecret: TEST_SECRET,
    sandboxDir: SANDBOX_DIR,
    logger: false,
  });
  cleanup = async () => {
    await a.close();
    await db.close();
  };
  return a;
}

describe('sandbox origin', () => {
  it('derives the origin from the env', () => {
    expect(sandboxOriginFor(testConfig({ CLAUDIA_SANDBOX_ORIGIN: 'https://sandbox.example.net/path' }))).toBe(
      'https://sandbox.example.net'
    );
    expect(
      sandboxOriginFor(testConfig({ CLAUDIA_PUBLIC_URL: 'http://localhost:8080', CLAUDIA_SANDBOX_PORT: '8081' }))
    ).toBe('http://localhost:8081');
    expect(sandboxOriginFor(testConfig())).toBeNull();
  });

  it('serves only sandbox pages to the sandbox host, without cookies or API', async () => {
    const a = await app({
      CLAUDIA_PUBLIC_URL: 'https://claudia.example.com',
      CLAUDIA_SANDBOX_ORIGIN: 'https://sandbox.example.net',
    });
    const page = await a.inject({ url: '/', headers: { host: 'sandbox.example.net' } });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-security-policy']).toBe('frame-ancestors https://claudia.example.com');
    expect(page.headers['set-cookie']).toBeUndefined();
    expect((await a.inject({ url: '/api/auth/session', headers: { host: 'sandbox.example.net' } })).statusCode).toBe(404);
    expect((await a.inject({ url: '/../server/config.ts', headers: { host: 'sandbox.example.net' } })).statusCode).toBe(404);

    // The app itself only frames the sandbox origin
    const api = await a.inject({ url: '/api/auth/session', headers: { host: 'claudia.example.com' } });
    expect(api.statusCode).toBe(200);
    expect(api.headers['content-security-policy']).toContain('frame-src https://sandbox.example.net');
    expect(api.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect((await a.inject({ url: '/api/public-config' })).json()).toMatchObject({ sandboxOrigin: 'https://sandbox.example.net' });
  });

  it('frames nothing when no sandbox is configured', async () => {
    const a = await app({});
    const res = await a.inject({ url: '/api/public-config' });
    expect(res.json().sandboxOrigin).toBeNull();
    expect(res.headers['content-security-policy']).toContain("frame-src 'none'");
  });

  it('serves the sandbox on its own port for single-host trials', async () => {
    const s = buildSandboxApp(SANDBOX_DIR, 'http://localhost:8080');
    cleanup = () => s.close();
    const res = await s.inject({ url: '/index.html' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect((await s.inject({ url: '/missing.html' })).statusCode).toBe(404);
  });
});

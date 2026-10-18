import { describe, it, expect, afterEach } from 'vitest';
import { HealthResponse, ReadyResponse } from '../shared/api';
import { buildTestApp } from './test/helpers';
import { VERSION } from './version';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe('health endpoints', () => {
  it('/healthz reports the process is up', async () => {
    const t = await buildTestApp();
    close = t.close;
    const res = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(HealthResponse.parse(res.json())).toEqual({ status: 'ok', version: VERSION });
  });

  it('/readyz is 503 until migrations are applied, then 200', async () => {
    const t = await buildTestApp({ migrate: false });
    close = t.close;

    const before = await t.app.inject({ method: 'GET', url: '/readyz' });
    expect(before.statusCode).toBe(503);
    expect(ReadyResponse.parse(before.json())).toMatchObject({ status: 'not_ready', migrations: { applied: 0 } });
    expect(before.json().migrations.pending).toBeGreaterThan(0);

    await t.db.migrate(t.app.deps.migrationsDir);

    const after = await t.app.inject({ method: 'GET', url: '/readyz' });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toMatchObject({ status: 'ready', database: t.db.kind, migrations: { pending: 0 } });
  });

  it('/readyz is 503 when the database is gone', async () => {
    const t = await buildTestApp();
    await t.db.close();
    close = () => t.app.close();
    const res = await t.app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('not_ready');
  });

  it('over http the page is not upgraded to https (no upgrade-insecure-requests, no HSTS)', async () => {
    const t = await buildTestApp({ env: { CLAUDIA_PUBLIC_URL: 'http://192.168.1.47:8080' } });
    close = t.close;
    const res = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('over https the page upgrades insecure requests and sends HSTS', async () => {
    const t = await buildTestApp({ env: { CLAUDIA_PUBLIC_URL: 'https://claudia.example.com' } });
    close = t.close;
    const res = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['content-security-policy']).toContain('upgrade-insecure-requests');
    expect(res.headers['strict-transport-security']).toContain('max-age=');
  });

  it('unknown API routes answer with the JSON error shape', async () => {
    const t = await buildTestApp();
    close = t.close;
    const res = await t.app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'No route for GET /api/nope' } });
  });
});

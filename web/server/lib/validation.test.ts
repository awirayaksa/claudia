import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { parsePatch } from './validation';
import { buildTestApp } from '../test/helpers';
import { TestClient } from '../test/client';

describe('parsePatch', () => {
  const Schema = z.object({ name: z.string(), mode: z.string().default('auto'), tags: z.array(z.string()).default([]) });

  it('keeps only the fields that were sent (no defaults for the others)', () => {
    expect(parsePatch(Schema, { name: 'x' })).toEqual({ name: 'x' });
    expect(parsePatch(Schema, { tags: ['a'] })).toEqual({ tags: ['a'] });
    expect(parsePatch(Schema, {})).toEqual({});
    expect(parsePatch(Schema, undefined)).toEqual({});
    expect(() => parsePatch(Schema, { name: 1 })).toThrow();
  });
});

describe('PATCH keeps what it was not given', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('for connections (a toggle used to reset the URL, quirks and model filter)', async () => {
    const t = await buildTestApp();
    close = t.close;
    const admin = new TestClient(t.app);
    await admin.signup('admin@example.com');
    const created = await admin.post('/api/admin/connections', {
      name: 'C',
      prefix: 'c',
      type: 'openai',
      baseUrl: 'http://127.0.0.1:9/v1',
      quirks: { toolsFirstTurnOnly: true },
      modelFilter: ['m1'],
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().connection.id;
    const patched = await admin.patch(`/api/admin/connections/${id}`, { enabled: false });
    expect(patched.json().connection).toMatchObject({
      enabled: false,
      baseUrl: 'http://127.0.0.1:9/v1',
      quirks: { toolsFirstTurnOnly: true },
      modelFilter: ['m1'],
    });
  });
});

/**
 * Both storage backends behave the same. S3 runs against TEST_S3_ENDPOINT
 * (any S3-compatible server with the bucket TEST_S3_BUCKET, default
 * "claudia-test"), path-style.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalStorage, type Storage } from './local';
import { S3Storage } from './s3';
import { chatFixture } from '../test/chat-fixture';

const S3_ENDPOINT = process.env.TEST_S3_ENDPOINT;
const S3_BUCKET = process.env.TEST_S3_BUCKET ?? 'claudia-test';
const s3Env = {
  S3_BUCKET,
  S3_ENDPOINT: S3_ENDPOINT ?? '',
  S3_FORCE_PATH_STYLE: 'true',
  S3_ACCESS_KEY_ID: process.env.TEST_S3_ACCESS_KEY_ID ?? 'test',
  S3_SECRET_ACCESS_KEY: process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'test-secret',
};

const read = (s: NodeJS.ReadableStream) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    s.on('data', (c: Buffer) => chunks.push(c));
    s.on('end', () => resolve(Buffer.concat(chunks)));
    s.on('error', reject);
  });

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const backends: Array<[string, () => Storage, boolean]> = [
  [
    'local disk',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudia-storage-'));
      dirs.push(dir);
      return new LocalStorage(dir);
    },
    true,
  ],
  [
    'S3',
    () =>
      new S3Storage({
        bucket: S3_BUCKET,
        region: 'us-east-1',
        endpoint: S3_ENDPOINT,
        forcePathStyle: true,
        accessKeyId: s3Env.S3_ACCESS_KEY_ID,
        secretAccessKey: s3Env.S3_SECRET_ACCESS_KEY,
        prefix: `test-${randomUUID().slice(0, 8)}/`,
      }),
    !!S3_ENDPOINT,
  ],
];

describe.each(backends)('%s storage', (_name, make, enabled) => {
  it.skipIf(!enabled)('puts, reads, streams, overwrites and deletes', async () => {
    const s = make();
    const key = `files/u1/${randomUUID()}`;
    expect(await s.exists(key)).toBe(false);
    await s.put(key, Buffer.from('first'));
    expect(await s.exists(key)).toBe(true);
    expect((await s.get(key)).toString()).toBe('first');
    await s.put(key, Buffer.from('second, longer'));
    expect((await read(s.stream(key))).toString()).toBe('second, longer');
    await s.delete(key);
    expect(await s.exists(key)).toBe(false);
    // Deleting twice is fine
    await s.delete(key);
  });

  it.skipIf(!enabled)('reports a missing file as ENOENT, from get and from stream', async () => {
    const s = make();
    await expect(s.get('files/none')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(read(s.stream('files/none'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(!enabled)('refuses keys that could leave its space', async () => {
    const s = make();
    for (const bad of ['../x', 'a/../../b', '/abs', '']) await expect(s.put(bad, Buffer.from('x'))).rejects.toThrow(/Invalid storage key/);
  });
});

describe.skipIf(!S3_ENDPOINT)('the app on S3', () => {
  it('uploads to the bucket and serves the file back', async () => {
    const f = await chatFixture({ env: { ...s3Env, S3_PREFIX: `app-${randomUUID().slice(0, 8)}/` } });
    try {
      const up = await f.admin.upload('note.txt', 'kept in S3', 'text/plain');
      expect(up.statusCode).toBe(201);
      const id = up.json().file.id;
      const res = await f.admin.get(`/api/files/${id}/content`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('kept in S3');
      expect((await f.app.inject({ method: 'GET', url: '/readyz' })).json().storage).toBe('s3');
      // Nothing was written to DATA_DIR/storage
      expect(fs.existsSync(path.join(f.dataDir, 'storage'))).toBe(false);
    } finally {
      await f.close();
    }
  });
});

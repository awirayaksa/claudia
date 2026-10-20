/**
 * The workspace page: each user browses, downloads, uploads to, adds folders
 * in and deletes from their own workspace only, and paths can't leave it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { chatFixture, type ChatFixture } from '../../test/chat-fixture';
import { TestClient } from '../../test/client';

let f: ChatFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const list = async (c: TestClient, dir = '') => (await c.get(`/api/workspace-files?path=${encodeURIComponent(dir)}`)).json();
const userId = async (c: TestClient): Promise<string> => (await c.get('/api/me')).json().user.id;

describe('workspace files', () => {
  it('are listed, uploaded, downloaded, put in folders and deleted', async () => {
    f = await chatFixture();
    expect(await list(f.admin)).toEqual({ path: '', entries: [] });

    expect((await f.admin.post('/api/workspace-files/folders', { parent: '', name: 'reports' })).statusCode).toBe(201);
    const up = await f.admin.upload('q3.md', '# Q3', 'text/markdown', '/api/workspace-files/upload?path=reports');
    expect(up.statusCode).toBe(201);
    expect(up.json()).toEqual({ path: 'reports/q3.md', size: 4 });

    const top = await list(f.admin);
    expect(top.entries).toEqual([expect.objectContaining({ name: 'reports', path: 'reports', type: 'directory' })]);
    expect((await list(f.admin, 'reports')).entries).toEqual([
      expect.objectContaining({ name: 'q3.md', path: 'reports/q3.md', type: 'file', size: 4 }),
    ]);

    const dl = await f.admin.get('/api/workspace-files/content?path=reports%2Fq3.md');
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe('# Q3');
    expect(dl.headers['content-type']).toContain('text/markdown');
    expect(dl.headers['content-disposition']).toContain('attachment');
    expect(dl.headers['content-security-policy']).toBe('sandbox');

    expect((await f.admin.delete('/api/workspace-files?path=reports')).statusCode).toBe(200);
    expect((await list(f.admin)).entries).toEqual([]);
    expect((await f.admin.get('/api/workspace-files/content?path=reports%2Fq3.md')).statusCode).toBe(404);
  });

  it("are each user's own, and paths can't leave the workspace", async () => {
    f = await chatFixture();
    await f.admin.upload('secret.txt', 'admin only', 'text/plain', '/api/workspace-files/upload');
    const bob = await f.newUser('bob@example.com');
    expect((await list(bob)).entries).toEqual([]);
    expect((await bob.get('/api/workspace-files/content?path=secret.txt')).statusCode).toBe(404);

    const adminDir = `../${await userId(f.admin)}`;
    for (const bad of [`${adminDir}/secret.txt`, '../../secret.txt', path.join(f.dataDir, 'workspaces'), '/etc/passwd', 'C:\\Windows\\win.ini']) {
      expect((await bob.get(`/api/workspace-files/content?path=${encodeURIComponent(bad)}`)).statusCode, bad).toBe(400);
      expect((await bob.get(`/api/workspace-files?path=${encodeURIComponent(bad)}`)).statusCode, bad).toBe(400);
      expect((await bob.delete(`/api/workspace-files?path=${encodeURIComponent(bad)}`)).statusCode, bad).toBe(400);
    }
    expect((await bob.upload('x.txt', 'x', 'text/plain', `/api/workspace-files/upload?path=${encodeURIComponent(adminDir)}`)).statusCode).toBe(400);
    expect((await bob.post('/api/workspace-files/folders', { parent: '', name: '..' })).statusCode).toBe(400);
    expect((await bob.post('/api/workspace-files/folders', { parent: '', name: 'a/b' })).statusCode).toBe(400);
    // The workspace itself stays
    expect((await bob.delete('/api/workspace-files?path=')).statusCode).toBe(400);
    expect(fs.readFileSync(path.join(f.dataDir, 'workspaces', await userId(f.admin), 'secret.txt'), 'utf8')).toBe('admin only');
  });

  it('need a signed-in user', async () => {
    f = await chatFixture();
    const anon = new TestClient(f.app);
    expect((await anon.get('/api/workspace-files')).statusCode).toBe(401);
  });
});

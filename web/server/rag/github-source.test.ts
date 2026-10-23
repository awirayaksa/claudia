/**
 * GitHub repositories as knowledge: the chosen paths come in as files that
 * chats can cite, a re-sync brings changes and removals, an unchanged commit
 * does nothing, and private repositories need their token.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { chatFixture, type ChatFixture } from '../test/chat-fixture';
import { startMockGitHub, type MockGitHub } from '../test/mock-github';
import { kbSources } from '../db/schema';
import { pathWanted, readablePath } from './github-source';

let f: ChatFixture | undefined;
let gh: MockGitHub | undefined;
afterEach(async () => {
  await f?.close();
  await gh?.close();
  f = undefined;
  gh = undefined;
});

async function setup(opts: { token?: string } = {}) {
  f = await chatFixture();
  gh = await startMockGitHub(opts);
  // The mock is on 127.0.0.1
  await f.admin.patch('/api/admin/settings/net.allowlist', { hosts: ['127.0.0.1'] });
  const kb = (await f.admin.post('/api/knowledge', { name: 'Handbook' })).json().knowledge.id as string;
  return { fx: f, mock: gh, kb };
}

const detail = async (fx: ChatFixture, kb: string) => (await fx.admin.get(`/api/knowledge/${kb}`)).json().knowledge;
const search = async (fx: ChatFixture, kb: string, query: string) =>
  (await fx.admin.post(`/api/knowledge/${kb}/search`, { query })).json().hits as Array<{ title: string; text: string }>;

describe('GitHub knowledge sources', () => {
  it('pulls the chosen paths, re-syncs changes and removals, and skips an unchanged commit', async () => {
    const { fx, mock, kb } = await setup();
    mock.commit({
      'README.md': '# Handbook\n\nWelcome to the Acme handbook.',
      'docs/leave.md': '# Leave\n\nEveryone gets 28 days of paid leave per year.',
      'docs/travel.md': '# Travel\n\nBook trains for trips under five hours.',
      'docs/logo.png': 'not really a png',
      'src/app.ts': 'export const x = 1;',
    });
    const added = await fx.admin.post(`/api/knowledge/${kb}/sources`, { kind: 'github', repo: 'https://github.com/acme/handbook', paths: ['docs/', 'README.md'], apiUrl: mock.apiUrl });
    expect(added.statusCode, added.body).toBe(202);
    expect(added.json().source).toMatchObject({ repo: 'acme/handbook', ref: null, paths: ['docs/', 'README.md'], hasToken: false });
    await fx.app.ctx.jobs.idle();

    let kbView = await detail(fx, kb);
    expect(kbView.sources[0]).toMatchObject({ status: 'ready', error: null, fileCount: 3 });
    expect(kbView.files.map((x: any) => x.name).sort()).toEqual(['README.md', 'docs/leave.md', 'docs/travel.md']);
    expect(kbView.files.every((x: any) => x.status === 'ready')).toBe(true);
    expect((await search(fx, kb, 'paid leave days'))[0].text).toContain('28 days');

    // Usable in a chat, cited by path
    fx.mock.push({ text: ['28 days.'] });
    const chat = (await fx.admin.post('/api/chats', {})).json().chat.id;
    const run = await fx.admin.post(`/api/chats/${chat}/completions`, { parentId: null, content: 'How many days of paid leave?', modelIds: ['mock/gpt-test'], refs: [{ type: 'kb', id: kb }] });
    const events = await fx.readRun(fx.admin, run.json().runId);
    const cites = (events.find((e) => e.event.type === 'message.citations')!.event as any).citations;
    expect(cites.some((c: any) => c.source.title === 'docs/leave.md')).toBe(true);

    // Same commit: nothing is fetched again
    const before = mock.requests.length;
    await fx.admin.post(`/api/knowledge/${kb}/sources/${kbView.sources[0].id}/sync`);
    await fx.app.ctx.jobs.idle();
    expect(mock.requests.slice(before).some((r) => r.includes('/git/'))).toBe(false);

    // A new commit: one file changed, one removed, one added; unchanged ones aren't downloaded again
    mock.commit({
      'README.md': '# Handbook\n\nWelcome to the Acme handbook.',
      'docs/leave.md': '# Leave\n\nEveryone gets 30 days of paid leave per year.',
      'docs/remote.md': '# Remote work\n\nWork from anywhere in the EU.',
    });
    const mark = mock.requests.length;
    await fx.admin.post(`/api/knowledge/${kb}/sources/${kbView.sources[0].id}/sync`);
    await fx.app.ctx.jobs.idle();
    expect(mock.requests.slice(mark).filter((r) => r.includes('/git/blobs/'))).toHaveLength(2);
    kbView = await detail(fx, kb);
    expect(kbView.files.map((x: any) => x.name).sort()).toEqual(['README.md', 'docs/leave.md', 'docs/remote.md']);
    const leave = await search(fx, kb, 'paid leave days');
    expect(leave[0].text).toContain('30 days');
    expect(leave.some((h) => h.text.includes('28 days'))).toBe(false);
    expect((await search(fx, kb, 'trains trips')).some((h) => h.title === 'docs/travel.md')).toBe(false);

    // Removing the source removes its files
    expect((await fx.admin.delete(`/api/knowledge/${kb}/sources/${kbView.sources[0].id}`)).statusCode).toBe(200);
    kbView = await detail(fx, kb);
    expect(kbView.sources).toEqual([]);
    expect(kbView.files).toEqual([]);
  });

  it('needs the token for a private repository, kept secret', async () => {
    const { fx, mock, kb } = await setup({ token: 'ghp_secret123' });
    mock.commit({ 'notes.md': '# Notes\n\nThe launch is on Tuesday.' });

    await fx.admin.post(`/api/knowledge/${kb}/sources`, { kind: 'github', repo: 'acme/handbook', apiUrl: mock.apiUrl });
    await fx.app.ctx.jobs.idle();
    const failed = (await detail(fx, kb)).sources[0];
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/token/i);

    const ok = await fx.admin.post(`/api/knowledge/${kb}/sources`, { kind: 'github', repo: 'acme/handbook', apiUrl: mock.apiUrl, token: 'ghp_secret123' });
    expect(ok.body).not.toContain('ghp_secret123');
    await fx.app.ctx.jobs.idle();
    const view = await detail(fx, kb);
    expect(view.sources.find((s: any) => s.hasToken)).toMatchObject({ status: 'ready', fileCount: 1 });
    const [row] = await fx.db.db.select().from(kbSources).where(eq(kbSources.id, ok.json().source.id));
    expect(row.tokenCipher).not.toContain('ghp_secret123');

    // Only those who may change the knowledge base add sources
    const bob = await fx.newUser('bob@example.com');
    expect((await bob.post(`/api/knowledge/${kb}/sources`, { kind: 'github', repo: 'acme/handbook' })).statusCode).toBe(404);
    expect((await fx.admin.post(`/api/knowledge/${kb}/sources`, { kind: 'github', repo: 'not a repo' })).statusCode).toBe(400);
  });

  it('chooses paths and readable files', () => {
    expect(pathWanted('docs/a.md', ['docs/'])).toBe(true);
    expect(pathWanted('docs/a.md', ['docs'])).toBe(true);
    expect(pathWanted('docsx/a.md', ['docs'])).toBe(false);
    expect(pathWanted('README.md', ['README.md'])).toBe(true);
    expect(pathWanted('anything.md', [])).toBe(true);
    expect(readablePath('a.md')).toBe(true);
    expect(readablePath('guide.pdf')).toBe(true);
    expect(readablePath('logo.png')).toBe(false);
  });
});

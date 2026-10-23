/** A chat exported as Markdown and PDF: the branch that is shown, with its title as the file name. */
import { describe, it, expect, afterEach } from 'vitest';
import { chatFixture, type ChatFixture } from '../../test/chat-fixture';

let f: ChatFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

describe('chat export as Markdown and PDF', () => {
  it('exports the shown branch, and only for the owner with the permission', async () => {
    f = await chatFixture();
    const fx = f;
    const chatId = await fx.newChat(fx.admin);
    await fx.admin.patch(`/api/chats/${chatId}`, { title: 'Trip to Kyoto' });
    fx.mock.push({ text: ['First answer'] }, { text: ['Second, better answer'] });
    const first = (await fx.admin.post(`/api/chats/${chatId}/completions`, { parentId: null, modelIds: ['mock/gpt-test'], content: 'Plan 3 days in Kyoto' })).json();
    await fx.readRun(fx.admin, first.runId);
    const again = (await fx.admin.post(`/api/chats/${chatId}/completions`, { parentId: first.userMessageId, regenerate: true, modelIds: ['mock/gpt-test'] })).json();
    await fx.readRun(fx.admin, again.runId);

    const md = await fx.admin.get(`/api/chats/${chatId}/export?format=md`);
    expect(md.statusCode).toBe(200);
    expect(md.headers['content-type']).toContain('text/markdown');
    expect(md.headers['content-disposition']).toContain('filename="Trip to Kyoto.md"');
    expect(md.body).toContain('# Trip to Kyoto');
    expect(md.body).toContain('## You\n\nPlan 3 days in Kyoto');
    expect(md.body).toContain('## gpt-test\n\nSecond, better answer');
    // Only the version that is shown
    expect(md.body).not.toContain('First answer');

    const pdf = await fx.admin.get(`/api/chats/${chatId}/export?format=pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    // JSON stays the default
    expect((await fx.admin.get(`/api/chats/${chatId}/export`)).json()).toHaveProperty('chats');

    const bob = await fx.newUser('bob@example.com');
    expect((await bob.get(`/api/chats/${chatId}/export?format=md`)).statusCode).toBe(404);
  });
});

/**
 * Uploads: extraction, what the model receives, and that files stay private.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { chatFixture, type ChatFixture } from '../../test/chat-fixture';
import { TINY_PNG, docxWith, minimalPdf, xlsxWith } from '../../test/documents';

let f: ChatFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const send = (fx: ChatFixture, client = fx.admin, chatId: string, body: Record<string, unknown>) =>
  client.post(`/api/chats/${chatId}/completions`, { parentId: null, modelIds: ['mock/gpt-test'], ...body });

describe('files', () => {
  it('extracts PDF, DOCX and XLSX and sends their text to the model', async () => {
    f = await chatFixture();
    const pdf = await f.admin.upload('report.pdf', minimalPdf('Revenue grew'), 'application/pdf');
    const docx = await f.admin.upload('memo.docx', await docxWith('Ship on Friday'));
    const xlsx = await f.admin.upload('stock.xlsx', xlsxWith('Stock', [['item', 'qty'], ['pear', 4]]));
    for (const res of [pdf, docx, xlsx]) {
      expect(res.statusCode).toBe(201);
      expect(res.json().file).toMatchObject({ status: 'ready', hasText: true, textTruncated: false });
    }

    f.mock.push({ text: ['Noted'] });
    const chatId = await f.newChat(f.admin);
    const fileIds = [pdf, docx, xlsx].map((r) => r.json().file.id);
    const start = await send(f, f.admin, chatId, { content: 'Summarize these', fileIds });
    expect(start.statusCode).toBe(202);
    await f.readRun(f.admin, start.json().runId);

    const content = f.mock.requests.find((r) => r.stream)!.messages.at(-1).content as string;
    expect(content.startsWith('Summarize these\n\n<attachment name="report.pdf">')).toBe(true);
    expect(content).toContain('Revenue grew');
    expect(content).toContain('<attachment name="memo.docx">\nShip on Friday');
    expect(content).toContain('--- Sheet: Stock ---\nitem\tqty\npear\t4');

    // The user turn keeps the files as parts
    const chat = (await f.admin.get(`/api/chats/${chatId}`)).json().chat;
    const user = chat.messages.find((m: any) => m.role === 'user');
    expect(user.parts.filter((p: any) => p.type === 'file').map((p: any) => p.name)).toEqual([
      'report.pdf',
      'memo.docx',
      'stock.xlsx',
    ]);
  });

  it('sends images as image content, recognised by their bytes', async () => {
    f = await chatFixture();
    const img = await f.admin.upload('pixel.bin', TINY_PNG, 'application/octet-stream');
    expect(img.json().file).toMatchObject({ mime: 'image/png', status: 'ready', hasText: false });

    f.mock.push({ text: ['A pixel'] });
    const chatId = await f.newChat(f.admin);
    const start = await send(f, f.admin, chatId, { content: 'What is this?', fileIds: [img.json().file.id] });
    await f.readRun(f.admin, start.json().runId);

    const content = f.mock.requests.find((r) => r.stream)!.messages.at(-1).content;
    expect(content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG.toString('base64')}` } },
    ]);
  });

  it('marks unreadable files failed and refuses to attach them', async () => {
    f = await chatFixture();
    const res = await f.admin.upload('tool.exe', Buffer.from([0x4d, 0x5a, 0, 1, 2, 3]), 'application/x-msdownload');
    expect(res.json().file).toMatchObject({ status: 'failed', hasText: false });
    expect(res.json().file.error).toMatch(/can't be read/);

    const chatId = await f.newChat(f.admin);
    const start = await send(f, f.admin, chatId, { content: 'x', fileIds: [res.json().file.id] });
    expect(start.statusCode).toBe(400);
    expect(start.json().error.code).toBe('file_not_ready');
  });

  it('serves downloads as attachments that never render', async () => {
    f = await chatFixture();
    const html = '<script>alert(1)</script>';
    const id = (await f.admin.upload('page.html', html, 'text/html')).json().file.id;
    const res = await f.admin.get(`/api/files/${id}/content`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(html);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="page.html"/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe('sandbox');
  });

  it("keeps each user's files to themselves", async () => {
    f = await chatFixture();
    const bob = await f.newUser('bob@example.com');
    const mine = (await f.admin.upload('secret.txt', 'admin only', 'text/plain')).json().file.id;

    expect((await bob.get(`/api/files/${mine}`)).statusCode).toBe(404);
    expect((await bob.get(`/api/files/${mine}/content`)).statusCode).toBe(404);
    expect((await bob.delete(`/api/files/${mine}`)).statusCode).toBe(404);
    expect((await bob.get('/api/files')).json().files).toEqual([]);

    // Nor can another user attach it by id
    const chatId = await f.newChat(bob);
    const start = await send(f, bob, chatId, { content: 'leak it', fileIds: [mine] });
    expect(start.statusCode).toBe(400);
    expect(start.json().error.code).toBe('file_not_found');

    expect((await f.admin.get(`/api/files/${mine}`)).statusCode).toBe(200);
    expect((await f.admin.delete(`/api/files/${mine}`)).statusCode).toBe(200);
    expect((await f.admin.get(`/api/files/${mine}`)).statusCode).toBe(404);
  });

  it('requires a file and the CSRF header', async () => {
    f = await chatFixture();
    const empty = await f.admin.post('/api/files', {});
    expect(empty.statusCode).toBeGreaterThanOrEqual(400);
    f.admin.csrf = false;
    expect((await f.admin.upload('a.txt', 'x', 'text/plain')).statusCode).toBe(403);
  });
});

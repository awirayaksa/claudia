/**
 * Phase 4: embeddings are set up in Admin → Knowledge, a knowledge base gets
 * a document (progress arrives live over the WebSocket), a chat references
 * it with "#" and the reply's [1] opens the cited passage. A "#https://…"
 * page is read and cited too.
 */
import { test, expect, type Page } from '@playwright/test';

const ADMIN = { email: 'admin@e2e.test', password: 'admin-password-e2e' };

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByPlaceholder('Message Claudia…')).toBeVisible();
}

async function api(page: Page, method: string, url: string, body?: unknown) {
  return page.evaluate(
    async ({ method, url, body }) => {
      const csrf = document.cookie.split('; ').find((c) => c.startsWith('claudia_csrf='))?.split('=')[1] ?? '';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Claudia-CSRF': decodeURIComponent(csrf) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { method, url, body }
  );
}

async function shot(page: Page, name: string) {
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `test-results/screens/${name}.png`, fullPage: true });
}

const HANDBOOK = `# Employee handbook

## Vacation

Full-time staff get twenty-five paid vacation days per year. Unused days carry over until March.

## Expenses

Submit receipts within thirty days through the finance portal.`;

const messages = (page: Page) => page.getByTestId('messages');
const idle = (page: Page) => expect(page.getByTitle('Send message')).toBeVisible({ timeout: 20_000 });

test.describe.serial('Claudia Web, Phase 4', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await signIn(page);
    const conns = await api(page, 'GET', '/api/admin/connections');
    if (!conns.body.connections.some((c: { prefix: string }) => c.prefix === 'mock-llm')) {
      await api(page, 'POST', '/api/admin/connections', {
        name: 'Mock LLM',
        prefix: 'mock-llm',
        type: 'openai',
        baseUrl: 'http://127.0.0.1:18080/v1',
        apiKey: 'sk-e2e-key-0000',
      });
    }
  });
  test.afterAll(async () => {
    await page.close();
  });

  test('an admin turns on embeddings', async () => {
    await page.goto('/admin/knowledge');
    await page.getByTestId('embedding-engine').selectOption('openai');
    await page.getByTestId('embedding-model').fill('hash-256');
    await page.getByTestId('embedding-url').fill('http://127.0.0.1:18080/v1');
    await page.getByTestId('rag-save').click();
    await expect(page.getByText(/Saved/)).toBeVisible();
    await page.getByRole('button', { name: 'Test embeddings' }).click();
    await expect(page.getByText('Works: 256 dimensions.')).toBeVisible();
    await shot(page, 'p4-admin-knowledge');
  });

  test('a document added to a knowledge base becomes ready live', async () => {
    await page.goto('/workspace/knowledge');
    await page.getByRole('button', { name: 'New knowledge base' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Handbook');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByTestId('knowledge-name')).toHaveText('Handbook');
    await expect(page.getByText(/Searched by meaning and keywords/)).toBeVisible();

    await page.getByTestId('knowledge-upload').setInputFiles({ name: 'handbook.md', mimeType: 'text/markdown', buffer: Buffer.from(HANDBOOK) });
    // No reload: the status comes over the WebSocket
    await expect(page.getByTestId('kb-file-handbook.md').getByTestId('kb-file-status')).toHaveText(/Ready · \d+ passage/, { timeout: 20_000 });

    await page.getByLabel('Try a question').fill('how many vacation days');
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page.getByTestId('knowledge-hits')).toContainText('twenty-five paid vacation days');
    await shot(page, 'p4-knowledge-base');
  });

  test('a chat cites the knowledge base it references with #', async () => {
    await page.goto('/');
    const box = page.getByPlaceholder('Message Claudia…');
    await box.fill('#Hand');
    await expect(page.getByRole('button', { name: /Handbook/ })).toBeVisible();
    await box.press('Enter');
    await expect(page.getByTestId('pending-ref')).toContainText('Handbook');
    await box.fill('How many vacation days do I get?');
    await box.press('Enter');
    await expect(messages(page)).toContainText('Echo: How many vacation days do I get?');
    await idle(page);
    // The user message keeps its reference; the reply cites [1]
    await expect(page.getByTestId('message-refs')).toContainText('Handbook');
    const cite = page.getByTestId('citation-link').first();
    await expect(cite).toHaveText('1');
    await cite.click();
    const detail = page.getByTestId('citation-detail');
    await expect(detail).toContainText('handbook.md');
    await expect(detail).toContainText('twenty-five paid vacation days');
    await expect(page.getByTestId('citations')).toBeVisible();
    await shot(page, 'p4-citation');
    // Still there after a reload (stored as parts of the reply)
    await page.reload();
    await expect(page.getByTestId('citations')).toBeVisible();
  });

  test('a #https:// page is read and cited', async () => {
    await api(page, 'PATCH', '/api/admin/settings/net.allowlist', { hosts: ['127.0.0.1'] });
    await page.goto('/');
    const box = page.getByPlaceholder('Message Claudia…');
    await box.fill('#http://127.0.0.1:18080/page/tides When is high tide?');
    await box.press('Enter');
    await expect(messages(page)).toContainText('When is high tide?');
    await idle(page);
    await page.getByTestId('citation-link').first().click();
    await expect(page.getByTestId('citation-detail')).toContainText('Tide tables');
    await expect(page.getByTestId('citation-detail')).toContainText('06:12');
    await expect(page.getByTestId('message-refs')).toContainText('127.0.0.1:18080/page/tides');
  });

  test('knowledge works on a phone', async () => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/workspace/knowledge');
    await expect(page.getByTestId('knowledge-Handbook')).toBeVisible();
    await page.getByTestId('knowledge-Handbook').click();
    await expect(page.getByTestId('kb-file-handbook.md')).toBeVisible();
    await shot(page, 'p4-knowledge-phone');
    await page.setViewportSize({ width: 1280, height: 720 });
  });
});

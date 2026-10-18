/**
 * Phase 1b: an attachment reaches the model; a built-in tool runs in the
 * user's workspace; a skill adds its prompt; the admin tool and directory
 * pages load.
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

/** E2E_SCREENSHOTS=1 saves screenshots of key screens to test-results/screens. */
async function shot(page: Page, name: string) {
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `test-results/screens/${name}.png`, fullPage: true });
}

async function send(page: Page, text: string) {
  const box = page.getByPlaceholder('Message Claudia…');
  await box.fill(text);
  await box.press('Enter');
}

test.describe.serial('Claudia Web, Phase 1b', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await signIn(page);
    // The Phase 1a flow adds the mock connection; add it when running alone
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
    await page.reload();
  });
  test.afterAll(async () => {
    await page.close();
  });

  test('an attached document reaches the model', async () => {
    await page.goto('/');
    await page.locator('input[type="file"].hidden').setInputFiles({
      name: 'launch.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('The launch code is 7421.'),
    });
    await expect(page.getByText('launch.txt')).toBeVisible();
    await send(page, 'What does the file say?');
    // The mock echoes the whole user message, attachment block included
    await expect(page.getByText(/The launch code is 7421/).last()).toBeVisible();
    await expect(page.getByText(/<attachment name="launch.txt">|Echo: What does the file say\?/).first()).toBeVisible();
    await shot(page, 'chat-attachment');
  });

  test('a built-in tool runs once switched on', async () => {
    await page.goto('/settings');
    await page.getByRole('tab', { name: 'Tools' }).click();
    await page.getByTestId('tool-toggle-builtin-filesystem-001').click();
    await expect(page.getByTestId('tool-toggle-builtin-filesystem-001')).toBeChecked();
    await expect(page.getByText(/ready/).first()).toBeVisible();
    await shot(page, 'settings-tools');

    await page.goto('/');
    await send(page, 'please save it');
    await expect(page.getByText(/Saved:/)).toBeVisible();
    await shot(page, 'chat-tool');
    const files = await api(page, 'GET', '/api/mcp/servers');
    expect(files.body.servers.find((s: { id: string }) => s.id === 'builtin-filesystem-001').enabled).toBe(true);
  });

  test('a skill adds its prompt', async () => {
    const created = await api(page, 'POST', '/api/skills', {
      id: 'marker',
      name: 'Marker',
      description: 'Adds a marker',
      body: 'SKILL-MARKER {{args}}',
    });
    expect(created.status).toBe(201);
    await page.goto('/');
    await page.reload();
    await send(page, '/marker hello skill');
    await expect(page.getByText('[skill] Echo: hello skill')).toBeVisible();
  });

  test('the admin tool and directory pages load', async () => {
    await page.goto('/admin/tools');
    await expect(page.getByTestId('new-tool-server')).toBeVisible();
    await page.getByTestId('new-tool-server').click();
    await shot(page, 'admin-tool-server-form');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.goto('/admin/directory');
    await expect(page.getByText('Directory server')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Test connection' })).toBeVisible();
    await shot(page, 'admin-directory');
    await page.goto('/admin/settings');
    await expect(page.getByText('Built-in tools')).toBeVisible();
    await shot(page, 'admin-settings');
  });
});

/**
 * Phase 8: the Web browser built-in. The admin offers it, a user switches it
 * on, and a reply that browses shows its screenshot under the tool call and
 * waits for the user before clicking. The page is about:blank, so nothing
 * leaves the machine.
 */
import { test, expect, type Page } from '@playwright/test';

const ADMIN = { email: 'admin@e2e.test', password: 'admin-password-e2e' };
const BROWSER = 'builtin-browser-001';

async function shot(page: Page, name: string) {
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `test-results/screens/${name}.png`, fullPage: true });
}

/** Sign in through the form; every spec signs in from one address, so wait out the per-IP limit. */
async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  for (let attempt = 0; attempt < 8; attempt++) {
    await page.getByRole('button', { name: 'Sign in' }).click();
    const outcome = await Promise.race([
      page.getByPlaceholder('Message Claudia…').waitFor().then(() => 'in' as const),
      page.getByRole('alert').filter({ hasText: /Rate limit exceeded/ }).waitFor().then(() => 'limited' as const),
    ]);
    if (outcome === 'in') return;
    await page.waitForTimeout(8_000);
  }
  throw new Error('Could not sign in');
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

async function send(page: Page, text: string) {
  const box = page.getByPlaceholder('Message Claudia…');
  await box.fill(text);
  await box.press('Enter');
}

test.describe.serial('Claudia Web, Phase 8', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await signIn(page);
    const conns = await api(page, 'GET', '/api/admin/connections');
    if (!conns.body.connections.some((c: { prefix: string }) => c.prefix === 'mock-llm')) {
      await api(page, 'POST', '/api/admin/connections', { name: 'Mock LLM', prefix: 'mock-llm', type: 'openai', baseUrl: 'http://127.0.0.1:18080/v1', apiKey: 'sk-e2e-key-0000' });
    }
  });
  test.afterAll(async () => {
    await page.close();
  });

  test('the admin offers the web browser and tests it', async () => {
    await page.goto('/admin/settings');
    const offered = page.getByRole('checkbox', { name: /Web browser \(open pages/ });
    await offered.check();
    // Its card appears once it is offered
    await expect(page.getByRole('heading', { name: 'Web browser' })).toBeVisible();
    await page.getByRole('button', { name: 'Test the browser' }).click();
    await expect(page.getByText(/Works \(Chromium/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('browser-approval')).toBeChecked();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    expect((await api(page, 'GET', '/api/admin/settings')).body.settings['mcp.builtins'].enabled).toContain(BROWSER);
    await shot(page, 'admin-browser');
  });

  test('a reply browses, shows its screenshot, and asks before clicking', async () => {
    await page.goto('/settings');
    await page.getByRole('tab', { name: 'Tools' }).click();
    await page.getByTestId(`tool-toggle-${BROWSER}`).click();
    await expect(page.getByTestId(`tool-toggle-${BROWSER}`)).toBeChecked();
    await page.getByTestId('settings-save').click();
    await expect(page.getByTestId('settings-save')).toBeDisabled();

    await page.goto('/');
    await send(page, 'please browse blank');
    // The click waits for the user; the model had seen the screenshot
    const approval = page.getByTestId('tool-approval');
    await expect(approval).toBeVisible({ timeout: 30_000 });
    await expect(approval).toContainText('Click on a web page');
    await expect(approval).toContainText('the blank page (screenshot seen)');
    // The screenshot is under its tool call
    const thumb = page.getByTestId('tool-images').locator('img').first();
    await expect(thumb).toBeVisible();
    expect(await thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await shot(page, 'chat-browser-approval');

    await page.getByTestId('reject-tool').click();
    await expect(page.getByText('Browsing done; you declined the click.')).toBeVisible();
    await expect(page.getByTestId('tool-approval-state').filter({ hasText: 'Declined' })).toBeVisible();
  });
});

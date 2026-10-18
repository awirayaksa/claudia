/**
 * Phase 6: an admin posts a banner (users see it and can dismiss it), sets up
 * a signed webhook (the secret is shown once and signs the deliveries), reads
 * usage analytics and the audit log; the app is an installable PWA.
 */
import { createHmac } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';

const ADMIN = { email: 'admin@e2e.test', password: 'admin-password-e2e' };
const HOOK = 'http://127.0.0.1:18080/hook';

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  // Every spec signs in from the same address: past 10 a minute, wait for the per-IP limit
  for (let attempt = 0; attempt < 8; attempt++) {
    await page.getByRole('button', { name: 'Sign in' }).click();
    const limited = page.getByRole('alert').filter({ hasText: /Rate limit exceeded/ });
    const outcome = await Promise.race([
      page.getByPlaceholder('Message Claudia…').waitFor().then(() => 'in' as const),
      limited.waitFor().then(() => 'limited' as const),
    ]);
    if (outcome === 'in') return;
    await page.waitForTimeout(8_000);
  }
  throw new Error('Could not sign in');
}

async function shot(page: Page, name: string) {
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `test-results/screens/${name}.png`, fullPage: true });
}

test.describe.serial('Claudia Web, Phase 6', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await signIn(page);
  });
  test.afterAll(async () => {
    await page.close();
  });

  test('a banner from the admin shows on every page and can be dismissed', async () => {
    await page.goto('/admin/settings');
    const editor = page.getByTestId('banners-editor');
    await editor.getByRole('button', { name: 'Add banner' }).click();
    await editor.getByLabel('Text').fill('Maintenance tonight at 22:00, see https://status.example.com');
    await editor.getByLabel('Type').selectOption('warning');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved')).toBeVisible();

    await page.goto('/');
    const banner = page.getByTestId('banners').getByRole('alert');
    await expect(banner).toContainText('Maintenance tonight at 22:00');
    await expect(banner.getByRole('link', { name: 'https://status.example.com' })).toHaveAttribute('href', 'https://status.example.com');
    await shot(page, 'p6-banner');
    await banner.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByTestId('banners')).toHaveCount(0);
    await page.reload();
    await expect(page.getByPlaceholder('Message Claudia…')).toBeVisible();
    await expect(page.getByTestId('banners')).toHaveCount(0);
  });

  test('a webhook shows its secret once and its deliveries are signed with it', async () => {
    await page.goto('/admin/webhooks');
    await page.getByRole('button', { name: 'New webhook' }).click();
    await page.getByLabel('Name', { exact: true }).fill('E2E receiver');
    await page.getByLabel('Address (URL)').fill(HOOK);
    await page.getByRole('button', { name: 'Save' }).click();
    const secret = (await page.getByTestId('webhook-secret').textContent())!.trim();
    expect(secret).toMatch(/^whsec_/);
    await shot(page, 'p6-webhook-secret');
    await page.getByRole('button', { name: 'Done' }).click();

    const row = page.getByTestId('webhooks').getByRole('listitem').filter({ hasText: 'E2E receiver' });
    await expect(row).toBeVisible();
    await expect(page.getByTestId('webhooks')).not.toContainText(secret);
    await row.getByRole('button', { name: 'Send test' }).click();
    await expect(row.getByRole('status')).toContainText('Test delivered: 204');

    const deliveries = await (await page.request.get('http://127.0.0.1:18080/hook/deliveries')).json();
    const test = deliveries.findLast((d: { body: string }) => JSON.parse(d.body).event === 'webhook.test');
    const ts = test.headers['x-claudia-timestamp'];
    expect(test.headers['x-claudia-signature']).toBe(`v1=${createHmac('sha256', secret).update(`${ts}.${test.body}`).digest('hex')}`);
  });

  test('analytics and the audit log show what happened', async () => {
    await page.goto('/admin/analytics');
    const analytics = page.getByTestId('analytics');
    await expect(analytics.getByText('Requests', { exact: true }).first()).toBeVisible();
    await expect(analytics.getByRole('img', { name: 'Tokens per day' })).toBeVisible();
    await analytics.getByRole('button', { name: 'Last 7 days' }).click();
    await expect(analytics.getByRole('button', { name: 'Last 7 days' })).toHaveAttribute('aria-pressed', 'true');
    await shot(page, 'p6-analytics');

    await page.goto('/admin/audit');
    const audit = page.getByTestId('audit');
    await expect(audit.getByText('POST /api/admin/webhooks', { exact: true }).first()).toBeVisible();
    await audit.getByLabel('Action').selectOption('auth.login');
    await expect(audit.getByRole('cell', { name: 'Signed in' }).first()).toBeVisible();
    await expect(audit.getByText('POST /api/admin/webhooks', { exact: true })).toHaveCount(0);
    await shot(page, 'p6-audit');
  });

  test('the app is installable: a manifest, icons and a service worker', async () => {
    await page.goto('/');
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    const manifest = await (await page.request.get(href!)).json();
    expect(manifest).toMatchObject({ name: 'Claudia', display: 'standalone', start_url: '/' });
    for (const icon of manifest.icons) expect((await page.request.get(icon.src)).ok()).toBe(true);
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    expect(scope).toBe('http://127.0.0.1:18090/');
    const sw = await page.request.get('/sw.js');
    expect(sw.headers()['cache-control']).toBe('no-cache');
  });
});

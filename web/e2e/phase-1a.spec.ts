/**
 * Phase 1a exit flow: admin bootstrap → a second user signs up → shows as
 * pending → is approved → gets a streamed chat → reload keeps the history →
 * stop works → a second tab resumes a live run; the rate limit is enforced;
 * the app is usable at phone width.
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';

const ADMIN = { email: 'admin@e2e.test', password: 'admin-password-e2e' };
const USER = { name: 'Uma User', email: 'uma@e2e.test', password: 'uma-password-123' };

let adminCtx: BrowserContext;
let userCtx: BrowserContext;
let admin: Page;
let user: Page;
let chatUrl = '';

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function send(page: Page, text: string) {
  const box = page.getByPlaceholder('Message Claudia…');
  await box.fill(text);
  await box.press('Enter');
}

/** E2E_SCREENSHOTS=1 saves screenshots of key screens to test-results/screens. */
async function shot(page: Page, name: string) {
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `test-results/screens/${name}.png`, fullPage: true });
}

/** Call the API from the page, with its cookies and CSRF header. */
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

test.describe.serial('Claudia Web, Phase 1a', () => {
  test.beforeAll(async ({ browser }) => {
    adminCtx = await browser.newContext();
    userCtx = await browser.newContext();
    admin = await adminCtx.newPage();
    user = await userCtx.newPage();
  });
  test.afterAll(async () => {
    await adminCtx.close();
    await userCtx.close();
  });

  test('the bootstrapped admin signs in and adds a connection', async () => {
    await signIn(admin, ADMIN.email, ADMIN.password);
    await expect(admin.getByText('How can I help?')).toBeVisible();
    await expect(admin.getByText(/Add a connection in Admin/)).toBeVisible();

    await admin.goto('/admin/connections');
    await admin.getByTestId('new-connection').click();
    await admin.getByLabel('Name').fill('Mock LLM');
    await admin.getByLabel('Base URL').fill('http://127.0.0.1:18080/v1');
    await admin.getByLabel('API key').fill('sk-e2e-key-0000');
    await admin.getByRole('button', { name: 'Save' }).click();
    await expect(admin.getByText('2 models')).toBeVisible();
    await shot(admin, 'admin-connections');
    // The key is never shown again
    await expect(admin.locator('body')).not.toContainText('sk-e2e-key-0000');

    // Skipping certificate verification warns, is saved, and shows on the list
    await admin.getByRole('button', { name: 'Edit' }).click();
    await admin.getByTestId('connection-insecure-tls').check();
    await expect(admin.getByText("the server's identity isn't checked")).toBeVisible();
    await shot(admin, 'admin-connection-insecure-tls');
    await admin.getByRole('button', { name: 'Save' }).click();
    await expect(admin.getByText('certificate not verified')).toBeVisible();
    await shot(admin, 'admin-connections-insecure-tls');
    await admin.getByRole('button', { name: 'Edit' }).click();
    await expect(admin.getByTestId('connection-insecure-tls')).toBeChecked();
    await admin.getByTestId('connection-insecure-tls').uncheck();
    await admin.getByRole('button', { name: 'Save' }).click();
    await expect(admin.getByText('certificate not verified')).toHaveCount(0);
  });

  test('a new user signs up, waits, and is approved', async () => {
    await user.goto('/');
    await user.getByRole('button', { name: 'Create account' }).click();
    await user.getByLabel('Name').fill(USER.name);
    await user.getByLabel('Email').fill(USER.email);
    await user.getByLabel('Password', { exact: true }).fill(USER.password);
    await user.getByRole('button', { name: 'Create account' }).click();
    await expect(user.getByText('Waiting for approval')).toBeVisible();
    await shot(user, 'pending');

    await admin.goto('/admin/users');
    const row = admin.getByTestId(`user-${USER.email}`);
    await expect(row.getByRole('combobox', { name: 'Role' })).toHaveValue('pending');
    await row.getByRole('button', { name: 'Approve' }).click();
    await expect(row.getByRole('combobox', { name: 'Role' })).toHaveValue('user');

    await user.getByRole('button', { name: 'Check again' }).click();
    await expect(user.getByText('How can I help?')).toBeVisible();
  });

  test('the user gets a streamed reply, and a reload keeps the history', async () => {
    await send(user, 'hello there');
    await expect(user.getByTestId('messages')).toContainText('Echo: hello there');
    await expect(user).toHaveURL(/\/c\/[0-9a-f-]{36}$/);
    chatUrl = user.url();
    // The model named the chat
    await expect(user.getByRole('link', { name: 'E2E Chat Title' })).toBeVisible();

    await shot(user, 'chat');
    await user.reload();
    await expect(user.getByTestId('messages')).toContainText('hello there');
    await expect(user.getByTestId('messages')).toContainText('Echo: hello there');
  });

  test('stop ends a reply and keeps what was written', async () => {
    await send(user, 'please be slow');
    await expect(user.getByTestId('messages')).toContainText('word3');
    await user.getByRole('button', { name: 'Stop generating' }).click();
    await expect(user.getByTitle('Send message')).toBeVisible();
    await user.reload();
    await expect(user.getByTestId('messages')).toContainText('word3');
    await expect(user.getByTestId('messages')).not.toContainText('word79');
  });

  test('a second tab picks up a reply that is still being written', async () => {
    await send(user, 'slow again');
    await expect(user.getByTestId('messages')).toContainText('word2');

    const second = await userCtx.newPage();
    await second.goto(chatUrl);
    await expect(second.getByTestId('messages')).toContainText('word40', { timeout: 20_000 });
    await expect(second.getByTestId('messages')).toContainText('word79', { timeout: 20_000 });
    await expect(user.getByTestId('messages')).toContainText('word79', { timeout: 20_000 });
    await second.close();
  });

  test('the per-user message rate limit is enforced', async () => {
    const res = await api(admin, 'PATCH', '/api/admin/settings/limits', {
      completionsPerMinute: 3,
      concurrentRuns: 3,
      maxToolIterations: 10,
    });
    expect(res.status).toBe(200);
    // The user already sent 3 messages this minute
    await send(user, 'one more');
    await expect(user.getByRole('alert')).toContainText(/rate limit/i);
    // Every later spec shares the admin's per-minute budget, so keep it out of their way
    await api(admin, 'PATCH', '/api/admin/settings/limits', { completionsPerMinute: 1000, concurrentRuns: 3, maxToolIterations: 10 });
  });

  test('works at phone width', async ({ browser }) => {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    // Same user, signed in on the phone
    const page = await phone.newPage();
    await signIn(page, USER.email, USER.password);
    await expect(page.getByText('How can I help?')).toBeVisible();

    // The sidebar is a drawer behind the menu button
    await expect(page.getByTestId('new-chat')).toBeHidden();
    await page.getByTestId('open-menu').click();
    await shot(page, 'phone-drawer');
    await page.getByRole('link', { name: 'E2E Chat Title' }).click();
    await expect(page.getByTestId('new-chat')).toBeHidden();
    await expect(page.getByTestId('messages')).toContainText('Echo: hello there');
    await expect(page.getByPlaceholder('Message Claudia…')).toBeVisible();

    await shot(page, 'phone-chat');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await phone.close();
  });
});

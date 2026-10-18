/**
 * Phase 7: two-factor sign-in set up and used; single sign-on with a fake
 * OpenID Connect provider; a blind comparison voted on; a note asked about
 * in a chat; Explain and Ask on selected reply text; a channel where a
 * model answers an @mention; a scheduled prompt run on demand.
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { startFakeOidc, type FakeOidc } from '../server/test/fake-oidc';
import { stepAt, totpAt } from '../server/auth/totp';

const ADMIN = { email: 'admin@e2e.test', password: 'admin-password-e2e' };

async function shot(page: Page, name: string) {
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `test-results/screens/${name}.png`, fullPage: true });
}

/** Sign in through the form; every spec signs in from one address, so wait out the per-IP limit. */
async function submitSignIn(page: Page, email: string, password: string) {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  for (let attempt = 0; attempt < 8; attempt++) {
    await page.getByRole('button', { name: 'Sign in' }).click();
    const outcome = await Promise.race([
      page.getByPlaceholder('Message Claudia…').waitFor().then(() => 'in' as const),
      page.getByLabel('Code').waitFor().then(() => 'code' as const),
      page.getByRole('alert').filter({ hasText: /Rate limit exceeded/ }).waitFor().then(() => 'limited' as const),
    ]);
    if (outcome !== 'limited') return outcome;
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

const idle = (page: Page) => expect(page.getByTitle('Send message')).toBeVisible({ timeout: 20_000 });

test.describe.serial('Claudia Web, Phase 7', () => {
  let page: Page;
  let oidc: FakeOidc;

  test.beforeAll(async ({ browser }) => {
    oidc = await startFakeOidc();
    page = await browser.newPage();
    await page.goto('/');
    await submitSignIn(page, ADMIN.email, ADMIN.password);
    const conns = await api(page, 'GET', '/api/admin/connections');
    if (!conns.body.connections.some((c: { prefix: string }) => c.prefix === 'mock-llm')) {
      await api(page, 'POST', '/api/admin/connections', { name: 'Mock LLM', prefix: 'mock-llm', type: 'openai', baseUrl: 'http://127.0.0.1:18080/v1', apiKey: 'sk-e2e-key-0000' });
    }
  });
  test.afterAll(async () => {
    await page.close();
    await oidc.close();
  });

  test('two-factor sign-in: set up with a QR code, then asked for a code at sign-in', async ({ browser }: { browser: Browser }) => {
    const email = `mfa-${Date.now()}@e2e.test`;
    expect((await api(page, 'POST', '/api/admin/users', { email, name: 'Mia', password: 'mia-password-1' })).status).toBe(201);
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto('/');
    await submitSignIn(p, email, 'mia-password-1');
    await p.goto('/settings');
    await p.getByRole('tab', { name: 'Account' }).click();
    const section = p.getByTestId('two-factor');
    await section.getByRole('button', { name: 'Set up two-factor sign-in' }).click();
    await expect(section.getByTestId('mfa-qr')).toBeVisible();
    const secret = (await section.getByTestId('mfa-secret').textContent())!.trim();
    await section.getByLabel('Code').fill(totpAt(secret, stepAt(Date.now())));
    await section.getByRole('button', { name: 'Turn on' }).click();
    await expect(section.getByTestId('recovery-codes').getByRole('listitem')).toHaveCount(10);
    await shot(p, 'p7-recovery-codes');
    await section.getByRole('button', { name: 'Done' }).click();
    await expect(section).toContainText('On. 10 recovery codes left.');

    // Signing in again asks for the next code
    await ctx.clearCookies();
    await p.goto('/');
    expect(await submitSignIn(p, email, 'mia-password-1')).toBe('code');
    await shot(p, 'p7-mfa-code');
    await p.getByLabel('Code').fill(totpAt(secret, stepAt(Date.now()) + 1));
    await p.getByRole('button', { name: 'Verify' }).click();
    await expect(p.getByPlaceholder('Message Claudia…')).toBeVisible();
    await ctx.close();
  });

  test('single sign-on: "Continue with" a provider, back signed in', async ({ browser }: { browser: Browser }) => {
    const created = await api(page, 'POST', '/api/admin/sso', {
      id: 'corp',
      name: 'Corp SSO',
      issuer: oidc.issuer,
      clientId: oidc.clientId,
      clientSecret: oidc.clientSecret,
      defaultRole: 'user',
    });
    expect([201, 409]).toContain(created.status);
    oidc.nextUser = { sub: `e2e-${Date.now()}`, email: `sso-${Date.now()}@e2e.test`, email_verified: true, name: 'Sam Sso' };
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto('/');
    await shot(p, 'p7-sso-button');
    await p.getByRole('link', { name: 'Continue with Corp SSO' }).click();
    await expect(p.getByPlaceholder('Message Claudia…')).toBeVisible();
    const me = await p.evaluate(async () => (await (await fetch('/api/auth/session')).json()).user);
    expect(me).toMatchObject({ name: 'Sam Sso', role: 'user', hasPassword: false });
    await ctx.close();
    await page.goto('/admin/signin');
    await expect(page.getByTestId('sso-providers')).toContainText('Corp SSO');
    await shot(page, 'p7-admin-signin');
  });

  test('a blind comparison: two unnamed replies, a vote, then the names', async () => {
    expect((await api(page, 'PATCH', '/api/admin/settings/arena', { enabled: true, models: ['mock-llm/e2e-model', 'mock-llm/e2e-other'] })).status).toBe(200);
    await page.goto('/');
    await page.getByRole('button', { name: 'Select model' }).click();
    await page.getByRole('listbox', { name: 'Available models' }).getByText('Arena (blind)').click();
    // (Not "compare": the mock would name its model in the reply)
    await send(page, 'which is better');
    await idle(page);
    const columns = page.getByTestId('model-columns');
    await expect(columns.getByRole('region', { name: 'Model A' })).toBeVisible();
    await expect(columns.getByRole('region', { name: 'Model B' })).toBeVisible();
    await expect(columns).not.toContainText('e2e-model');
    await shot(page, 'p7-arena');
    await page.getByTestId('arena-vote').getByRole('button', { name: 'A is better' }).click();
    await expect(page.getByTestId('arena-result')).toContainText(/A was mock-llm\/e2e-(model|other), B was mock-llm\/e2e-(model|other)/);
    await page.goto('/admin/evaluations');
    await expect(page.getByTestId('leaderboard').getByRole('row')).toHaveCount(3);
  });

  test('a note: written, previewed, and asked about in a chat', async () => {
    await page.goto('/notes');
    await page.getByRole('button', { name: 'New note' }).click();
    await page.getByLabel('Title').fill('Packing list');
    await page.getByLabel('Note', { exact: true }).fill('- passport\n- **charger**\n- tide tables for Bergen');
    await expect(page.getByRole('status')).toHaveText('Saved', { timeout: 10_000 });
    await page.getByRole('button', { name: 'Preview' }).click();
    await expect(page.getByTestId('note-preview').locator('strong')).toHaveText('charger');
    await shot(page, 'p7-note');
    await page.getByRole('button', { name: 'Ask about it in a chat' }).click();
    await expect(page.getByPlaceholder('Message Claudia…')).toBeVisible();
    await expect(page.getByText('Packing list')).toBeVisible();
    await send(page, 'what to pack?');
    await idle(page);
    // The mock cites the first source when sources came with the message
    await expect(page.getByTestId('citation-link').first()).toBeVisible();
  });

  test('selected text in a reply: Explain and Ask answer in a pop-up', async () => {
    await page.goto('/');
    await send(page, 'tidal energy facts');
    await idle(page);
    // (Still in the blind arena from above: two replies, and the menu uses a real model)
    const reply = page.getByTestId('messages').getByText('Echo: tidal energy facts').first();
    // Selecting the reply (a triple click selects its paragraph) shows the menu
    await reply.click({ clickCount: 3 });
    await page.getByRole('button', { name: 'Explain', exact: true }).click();
    const popup = page.locator('[data-selection-popup]');
    await expect(popup).toContainText('Explained: Echo: tidal energy facts');
    await shot(page, 'p7-selection-explain');
    await popup.getByRole('button', { name: 'Close' }).click();
    await expect(popup).toBeHidden();

    await reply.click({ clickCount: 3 });
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await popup.getByLabel('Ask a question...').fill('why tides?');
    await popup.getByLabel('Ask a question...').press('Enter');
    await expect(popup).toContainText('Answered: why tides?');
    await page.keyboard.press('Escape');
    await expect(popup).toBeHidden();
  });

  test('a channel: people write, and a model answers an @mention live', async () => {
    await page.goto('/');
    await page.getByTestId('sidebar-extras').getByRole('button', { name: 'New channel' }).click();
    await page.getByLabel('Name').fill(`general-${Date.now() % 1000}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByTestId('channel')).toBeVisible();
    const box = page.getByLabel('Message the channel (type @ to ask a model)');
    await box.fill('Good morning');
    await box.press('Enter');
    await box.fill('@e2e-mo');
    await page.getByRole('listbox', { name: 'Ask a model' }).getByRole('option').first().click();
    await box.pressSequentially('hello there');
    await box.press('Enter');
    const messages = page.getByTestId('channel-message');
    await expect(messages).toHaveCount(3);
    await expect(messages.nth(2)).toContainText('🤖 mock-llm/e2e-model');
    await expect(messages.nth(2)).toContainText('Echo:', { timeout: 20_000 });
    await shot(page, 'p7-channel');
  });

  test('a scheduled prompt: created, run now, its reply in a chat', async () => {
    await page.goto('/schedules');
    await page.getByRole('button', { name: 'New schedule' }).first().click();
    await page.getByLabel('Name').fill('Morning brief');
    await page.getByLabel('Prompt').fill('brief me');
    await page.getByRole('button', { name: 'Save' }).click();
    const row = page.getByTestId('schedules').getByRole('listitem').filter({ hasText: 'Morning brief' });
    await expect(row).toContainText('Next:');
    await row.getByRole('button', { name: 'Run now' }).click();
    await row.getByRole('link', { name: 'Open chat' }).click();
    await expect(page.getByText('Echo: brief me')).toBeVisible({ timeout: 20_000 });
    await shot(page, 'p7-schedule-chat');
  });
});

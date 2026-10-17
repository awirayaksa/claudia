/**
 * Phase 3: an admin makes a group, builds a custom model and shares it with
 * the group; a member uses it (by name, with its starter prompts). A prompt
 * with {{variables}} fills the message box from the "/" menu. A member with
 * API keys calls the OpenAI-compatible API. Memories are kept per user.
 */
import { test, expect, type Browser, type Page } from '@playwright/test';

const ADMIN = { email: 'admin@e2e.test', password: 'admin-password-e2e' };
const MEMBER = { email: 'member3@e2e.test', password: 'member-password-3', name: 'Mia Member' };

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto('/');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password', { exact: true }).fill(who.password);
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

const messages = (page: Page) => page.getByTestId('messages');
const idle = (page: Page) => expect(page.getByTitle('Send message')).toBeVisible({ timeout: 20_000 });

async function memberPage(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, MEMBER);
  return page;
}

test.describe.serial('Claudia Web, Phase 3', () => {
  let admin: Page;
  let memberId: string;

  test.beforeAll(async ({ browser }) => {
    admin = await browser.newPage();
    await signIn(admin, ADMIN);
    const conns = await api(admin, 'GET', '/api/admin/connections');
    if (!conns.body.connections.some((c: { prefix: string }) => c.prefix === 'mock-llm')) {
      await api(admin, 'POST', '/api/admin/connections', {
        name: 'Mock LLM',
        prefix: 'mock-llm',
        type: 'openai',
        baseUrl: 'http://127.0.0.1:18080/v1',
        apiKey: 'sk-e2e-key-0000',
      });
    }
    const created = await api(admin, 'POST', '/api/admin/users', { ...MEMBER, role: 'user' });
    expect([201, 409]).toContain(created.status);
    const users = await api(admin, 'GET', `/api/admin/users?search=${encodeURIComponent(MEMBER.email)}`);
    memberId = users.body.users[0].id;
  });
  test.afterAll(async () => {
    await admin.close();
  });

  test('an admin makes a group that may use API keys and adds a member', async () => {
    await admin.goto('/admin/groups');
    await admin.getByRole('button', { name: 'New group' }).click();
    await admin.getByLabel('Name', { exact: true }).fill('Pirates');
    await admin.getByTestId('perm-api.keys').check();
    await admin.getByRole('button', { name: 'Save' }).click();
    await expect(admin.getByTestId('group-Pirates')).toBeVisible();

    await admin.getByTestId('group-Pirates').getByRole('button', { name: 'Edit' }).click();
    await admin.getByLabel('Add someone by name or email…').fill('member3');
    await admin.getByRole('button', { name: /Mia Member/ }).click();
    await expect(admin.getByTestId('group-members')).toContainText(MEMBER.email);
    await shot(admin, 'p3-group');
    await admin.getByRole('button', { name: 'Save' }).click();
    await expect(admin.getByTestId('group-Pirates')).toContainText('1 member');
  });

  test('a custom model shared with the group answers members with its prompt', async ({ browser }) => {
    await admin.goto('/workspace/models');
    await admin.getByRole('button', { name: 'New model' }).click();
    await admin.getByLabel('Name', { exact: true }).fill('Captain');
    await admin.getByLabel('Description', { exact: true }).fill('Answers like a pirate');
    await admin.getByTestId('base-model').selectOption('mock-llm/e2e-model');
    await admin.getByTestId('model-system-prompt').fill('PERSONA:Captain Speak like a pirate to {{USER_NAME}}.');
    await admin.getByLabel('Starter prompts').fill('Where is the treasure?\nSing a shanty');
    await admin.getByRole('button', { name: 'Save' }).click();
    const card = admin.getByTestId('custom-model-Captain');
    await expect(card).toContainText('mock-llm/e2e-model');

    await card.getByRole('button', { name: 'Share' }).click();
    await admin.getByTestId('add-group').selectOption({ label: 'Pirates' });
    await expect(admin.getByTestId('grants')).toContainText('Pirates');
    await shot(admin, 'p3-share-model');
    await admin.getByTestId('access-dialog').getByRole('button', { name: 'Save' }).click();
    await expect(admin.getByTestId('access-dialog')).toBeHidden();

    const member = await memberPage(browser);
    // Picked by name, with its starter prompts on a new chat
    await member.getByRole('button', { name: 'Select model' }).click();
    await member.getByRole('option', { name: 'Captain' }).click();
    await expect(member.getByRole('button', { name: 'Select model' })).toContainText('Captain');
    await expect(member.getByText('Answers like a pirate')).toBeVisible();
    await member.getByTestId('model-suggestions').getByRole('button', { name: 'Where is the treasure?' }).click();
    await member.getByPlaceholder('Message Claudia…').press('Enter');
    await expect(messages(member)).toContainText('[Captain] Echo: Where is the treasure?');
    await idle(member);
    await shot(member, 'p3-custom-model');
    await member.context().close();
  });

  test('a prompt with variables fills the message box from the / menu', async () => {
    await admin.goto('/workspace/prompts');
    await admin.getByRole('button', { name: 'New prompt' }).click();
    await admin.getByLabel('Command', { exact: true }).fill('greet');
    await admin.getByLabel('Title', { exact: true }).fill('Greeting');
    await admin.getByTestId('prompt-body').fill('Say hello to {{name}} from {{place:Oslo}}');
    await expect(admin.getByTestId('prompt-form')).toContainText('Asks for: name, place');
    await admin.getByRole('button', { name: 'Save' }).click();
    await expect(admin.getByTestId('prompt-greet')).toBeVisible();

    await admin.goto('/');
    const box = admin.getByPlaceholder('Message Claudia…');
    await box.fill('/gre');
    await expect(admin.getByRole('button', { name: /greet/ })).toBeVisible();
    await box.press('Enter');
    const form = admin.getByTestId('prompt-variables');
    await expect(form).toBeVisible();
    await form.getByLabel('name').fill('Ada');
    await expect(form).toContainText('Say hello to Ada from Oslo');
    await shot(admin, 'p3-prompt-variables');
    await form.getByRole('button', { name: 'Insert' }).click();
    await expect(box).toHaveValue('Say hello to Ada from Oslo');
    await box.press('Enter');
    await expect(messages(admin)).toContainText('Echo: Say hello to Ada from Oslo');
    await idle(admin);

    // Typing the whole command and Enter opens it too
    await admin.goto('/');
    await box.fill('/greet');
    await box.press('Enter');
    await expect(admin.getByTestId('prompt-variables')).toBeVisible();
    await admin.getByTestId('prompt-variables').getByRole('button', { name: 'Cancel' }).click();
  });

  test('a member creates an API key and uses the OpenAI-compatible API', async ({ browser, playwright }) => {
    const member = await memberPage(browser);
    await member.goto('/settings');
    await member.getByRole('tab', { name: 'API keys' }).click();
    await member.getByTestId('api-key-name').fill('Laptop');
    await member.getByRole('button', { name: 'Create key' }).click();
    const secret = (await member.getByTestId('api-key-secret').textContent())!.trim();
    expect(secret).toMatch(/^ck-/);
    await expect(member.getByTestId('api-keys')).toContainText('Laptop');
    await shot(member, 'p3-api-keys');

    const baseURL = (await member.getByTestId('api-base-url').textContent())!.trim();
    const request = await playwright.request.newContext();
    const models = await request.get(`${baseURL}/models`, { headers: { Authorization: `Bearer ${secret}` } });
    expect(models.status()).toBe(200);
    const ids = (await models.json()).data.map((m: { id: string }) => m.id);
    expect(ids).toContain('mock-llm/e2e-model');

    const done = await request.post(`${baseURL}/chat/completions`, {
      headers: { Authorization: `Bearer ${secret}` },
      data: { model: 'mock-llm/e2e-model', messages: [{ role: 'user', content: 'from the api' }] },
    });
    expect(done.status()).toBe(200);
    expect((await done.json()).choices[0].message.content).toBe('Echo: from the api');
    expect((await request.get(`${baseURL}/models`)).status()).toBe(401);

    // Revoked: refused
    await member.getByRole('button', { name: 'Revoke' }).click();
    await expect(member.getByTestId('api-keys')).toContainText('No keys yet.');
    expect((await request.get(`${baseURL}/models`, { headers: { Authorization: `Bearer ${secret}` } })).status()).toBe(401);
    await request.dispose();
    await member.context().close();
  });

  test('memories are kept per user and shown on a phone', async ({ browser }) => {
    const member = await memberPage(browser);
    await member.setViewportSize({ width: 390, height: 800 });
    await member.goto('/settings');
    await member.getByRole('tab', { name: 'Memory' }).click();
    await member.getByTestId('memory-input').fill('I sail a small boat called Wren');
    await member.getByRole('button', { name: 'Add' }).click();
    await expect(member.getByTestId('memories')).toContainText('I sail a small boat called Wren');
    await shot(member, 'p3-memory-phone');
    const theirs = await api(admin, 'GET', '/api/me/memories');
    expect(JSON.stringify(theirs.body)).not.toContain('Wren');
    await member.context().close();
    void memberId;
  });
});

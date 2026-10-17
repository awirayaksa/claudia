/**
 * Phase 2: versions (regenerate, edit, switch), several models side by side,
 * share links opened while signed out (no script from the chat runs),
 * export → import, search inside messages, math and diagrams, follow-up
 * suggestions, temporary chats and the message queue.
 */
import fs from 'node:fs';
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

async function send(page: Page, text: string) {
  const box = page.getByPlaceholder('Message Claudia…');
  await box.fill(text);
  await box.press('Enter');
}

/** A fresh chat page, after the previous reply (and its follow-ups) finished. */
async function newChat(page: Page) {
  await page.goto('/');
  await expect(page.getByPlaceholder('Message Claudia…')).toBeVisible();
}

const messages = (page: Page) => page.getByTestId('messages');
const idle = (page: Page) => expect(page.getByTitle('Send message')).toBeVisible({ timeout: 20_000 });

test.describe.serial('Claudia Web, Phase 2', () => {
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
    await page.reload();
  });
  test.afterAll(async () => {
    await page.close();
  });

  test('regenerating and editing make versions, and the switcher moves between them', async () => {
    await newChat(page);
    await send(page, 'version one');
    await expect(messages(page)).toContainText('Echo: version one');
    await idle(page);

    // Regenerate: a second answer to the same message
    await page.getByRole('button', { name: '↻ Retry' }).click();
    await idle(page);
    const replySwitcher = page.getByTestId('version-switcher').last();
    await expect(replySwitcher).toContainText('2/2');
    await replySwitcher.getByRole('button', { name: 'Previous version' }).click();
    await expect(replySwitcher).toContainText('1/2');

    // Edit the message: a new version of it, with its own answer
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.getByLabel('Edit message');
    await editor.fill('version two');
    await page.getByRole('button', { name: 'Save and send' }).click();
    await expect(messages(page)).toContainText('Echo: version two');
    await idle(page);
    const userSwitcher = page.getByTestId('version-switcher').first();
    await expect(userSwitcher).toContainText('2/2');
    await shot(page, 'versions');

    // The choice is stored: after a reload the edited version is shown; going back shows the first
    await page.reload();
    await expect(messages(page)).toContainText('Echo: version two');
    await page.getByTestId('version-switcher').first().getByRole('button', { name: 'Previous version' }).click();
    await expect(messages(page)).toContainText('Echo: version one');
    await expect(messages(page)).not.toContainText('version two');
  });

  test('several models answer side by side', async () => {
    await newChat(page);
    await page.getByRole('button', { name: 'Compare models' }).click();
    await page.getByLabel('Add a model').selectOption({ index: 1 });
    await expect(page.getByTestId('compare-models')).toBeVisible();
    await send(page, 'compare these');

    const columns = page.getByTestId('model-columns');
    await expect(columns.locator('section')).toHaveCount(2);
    await expect(columns).toContainText('Echo (e2e-model): compare these');
    await expect(columns).toContainText('Echo (e2e-other): compare these');
    await idle(page);
    await shot(page, 'multi-model');
    // On a phone the columns scroll sideways instead of squeezing
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(columns.locator('section').first()).toBeVisible();
    await shot(page, 'multi-model-phone');
    await page.setViewportSize({ width: 1280, height: 720 });

    // Continue the chat from the other answer
    const inactive = columns.locator('section[data-active="false"]');
    await inactive.getByRole('button', { name: 'Continue with this answer' }).click();
    await expect(columns.locator('section[data-active="true"]')).toContainText('Echo (e2e-other)');
  });

  test('a share link works signed out and runs no script from the chat', async ({ browser }) => {
    await newChat(page);
    await send(page, 'share me <img src=x onerror="window.__pwned=1"> [link](javascript:window.__pwned=2)');
    await expect(messages(page)).toContainText('Echo: share me');
    await idle(page);

    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await page.getByRole('button', { name: 'Create link' }).click();
    const url = await page.getByTestId('share-url').inputValue();
    expect(url).toMatch(/\/s\/[A-Za-z0-9_-]{32}$/);

    const anon = await browser.newContext();
    const viewer = await anon.newPage();
    await viewer.goto(url);
    await expect(viewer.getByTestId('shared-title')).toBeVisible();
    await expect(viewer.getByTestId('shared-messages')).toContainText('Echo: share me');
    await expect(viewer.getByText(/Shared by/)).toBeVisible();
    // Nothing to act on, and the chat's HTML is text
    await expect(viewer.getByRole('button', { name: '↻ Retry' })).toHaveCount(0);
    expect(await viewer.evaluate(() => (window as any).__pwned)).toBeUndefined();
    expect(await viewer.locator('a[href^="javascript:"]').count()).toBe(0);
    expect(await viewer.locator('img[src="x"]').count()).toBe(0);
    await shot(viewer, 'share-link');

    // Deleting the link stops it at once
    await page.getByRole('button', { name: 'Delete link' }).click();
    await viewer.reload();
    await expect(viewer.getByText("This link doesn't exist or was deleted.")).toBeVisible();
    await anon.close();
    await page.keyboard.press('Escape');
  });

  test('export and import round-trip every chat', async () => {
    const before = (await api(page, 'GET', '/api/chats')).body.chats.length;
    await page.goto('/settings');
    await page.getByRole('tab', { name: 'Data' }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export all chats' }).click()]);
    const file = await download.path();
    const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(exported.format).toBe('claudia-web');
    expect(exported.chats).toHaveLength(before);

    await page.getByTestId('import-files').setInputFiles({ name: 'claudia-chats.json', mimeType: 'application/json', buffer: fs.readFileSync(file) });
    await expect(page.getByTestId('import-summary')).toContainText(`Imported ${before} chat`);
    const after = (await api(page, 'GET', '/api/chats')).body.chats;
    expect(after.length).toBe(before * 2);
    // Branches come along: the imported copy of the first test's chat still has both versions
    const copies = after.filter((c: any) => c.title === exported.chats.find((x: any) => x.messages.length >= 4)?.title);
    expect(copies.length).toBeGreaterThanOrEqual(2);
    await shot(page, 'data-settings');
  });

  test('search finds text inside messages', async () => {
    await newChat(page);
    await send(page, 'where does the zebracorn live');
    await expect(messages(page)).toContainText('Echo: where does the zebracorn live');
    await idle(page);
    await page.getByLabel('Search chats').fill('zebraco');
    await expect(page.getByTestId('search-snippet').first()).toContainText('zebracorn');
    await shot(page, 'search');
    await page.getByLabel('Search chats').fill('');
  });

  test('math and diagrams render, and follow-up questions are offered', async () => {
    await newChat(page);
    await send(page, 'render math');
    await expect(messages(page).locator('.katex').first()).toBeVisible();
    await expect(messages(page).getByTestId('mermaid-diagram').locator('svg')).toBeVisible({ timeout: 20_000 });
    await idle(page);

    const followUps = page.getByTestId('follow-ups');
    await expect(followUps).toContainText('Tell me more');
    await shot(page, 'math-mermaid');
    await followUps.getByRole('button', { name: 'Tell me more' }).click();
    await expect(messages(page)).toContainText('Echo: Tell me more');
  });

  test('a temporary chat stays out of the list until kept', async () => {
    await newChat(page);
    await page.getByTestId('temporary-toggle').click();
    await expect(page.getByText('Not saved in your chat list', { exact: false })).toBeVisible();
    await send(page, 'ghost message');
    await expect(messages(page)).toContainText('Echo: ghost message');
    await expect(page.getByTestId('temporary-badge')).toBeVisible();
    await idle(page);
    const listed = (await api(page, 'GET', '/api/chats')).body.chats;
    expect(listed.some((c: any) => c.temporary)).toBe(false);

    await page.getByRole('button', { name: 'Keep this chat' }).click();
    await expect(page.getByTestId('temporary-badge')).toHaveCount(0);
    expect((await api(page, 'GET', '/api/chats')).body.chats.some((c: any) => c.title === 'New chat')).toBe(true);
  });

  test('a message sent during a reply waits its turn', async () => {
    await newChat(page);
    await send(page, 'slow reply please');
    await expect(messages(page)).toContainText('word2');
    await send(page, 'queued after it');
    await expect(page.getByTestId('queue')).toContainText('queued after it');
    await expect(messages(page)).toContainText('Echo: queued after it', { timeout: 30_000 });
    await expect(page.getByTestId('queue')).toHaveCount(0);
    // It followed the slow reply, on the same branch
    const text = await messages(page).innerText();
    expect(text.indexOf('word79')).toBeLessThan(text.indexOf('Echo: queued after it'));
  });
});

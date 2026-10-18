/**
 * Phase 5: the code interpreter runs Python (Pyodide) in the browser on the
 * sandbox origin and the model gets its output; HTML and React artifacts
 * render live in the sandbox and can't reach the app, its cookies, storage
 * or the network; image generation shows its picture; an admin-installed
 * ESM plugin changes how messages render.
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

async function send(page: Page, text: string) {
  const box = page.getByPlaceholder('Message Claudia…');
  await box.fill(text);
  await box.press('Enter');
}

const messages = (page: Page) => page.getByTestId('messages');
const idle = (page: Page, timeout = 20_000) => expect(page.getByTitle('Send message')).toBeVisible({ timeout });

test.describe.serial('Claudia Web, Phase 5', () => {
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

  test('the code interpreter runs Python in the browser and the model gets the output', async () => {
    test.setTimeout(120_000);
    await page.goto('/');
    await page.getByTestId('code-toggle').click();
    await expect(page.getByTestId('code-toggle')).toHaveAttribute('aria-pressed', 'true');
    await send(page, 'run python please');
    // Pyodide starts in the sandbox frame on first use
    await expect(messages(page)).toContainText('Python said:', { timeout: 90_000 });
    await expect(messages(page)).toContainText('42');
    await expect(messages(page)).toContainText('3628800');
    await idle(page);
    await shot(page, 'p5-code-interpreter');
  });

  test('an HTML artifact renders in the sandbox and cannot reach the app', async () => {
    await page.goto('/');
    await send(page, 'make a page');
    await idle(page);
    await page.getByTestId('artifacts').getByRole('button', { name: /Sandbox probe/ }).click();
    const panel = page.getByTestId('artifact-panel');
    await expect(panel).toBeVisible();
    const content = page.frameLocator('[data-testid="artifact-frame"]').frameLocator('#frame');
    await expect(content.locator('#script')).toHaveText('script: ran');
    await expect(content.locator('#parent')).toHaveText('parent: blocked');
    // Reading cookies in the opaque-origin frame throws (or finds none)
    await expect(content.locator('#cookie')).toHaveText(/^cookie: (none|blocked)$/);
    await expect(content.locator('#storage')).toHaveText('storage: blocked');
    await expect(content.locator('#fetch')).toHaveText('fetch: blocked');
    await shot(page, 'p5-artifact');

    // The app only frames the sandbox origin, and the sandbox only lets the app frame it
    const app = await page.request.get('/');
    expect(app.headers()['content-security-policy']).toContain('frame-src http://127.0.0.1:18091');
    const host = await page.request.get('http://127.0.0.1:18091/artifact.html');
    expect(host.headers()['content-security-policy']).toBe('frame-ancestors http://127.0.0.1:18090');
    await panel.getByRole('button', { name: 'Close' }).click();
  });

  test('a React artifact runs', async () => {
    await page.goto('/');
    await send(page, 'make a counter');
    await idle(page);
    await page.getByTestId('artifacts').getByRole('button', { name: /Click Counter/ }).click();
    const counter = page.frameLocator('[data-testid="artifact-frame"]').frameLocator('#frame').locator('#counter');
    await expect(counter).toHaveText('Clicked 0 times', { timeout: 20_000 });
    await counter.click();
    await expect(counter).toHaveText('Clicked 1 times');
    await page.getByTestId('artifact-panel').getByRole('button', { name: 'Code' }).click();
    await expect(page.getByTestId('artifact-panel')).toContainText('export default function ClickCounter');
  });

  test('image generation shows the picture in the reply', async () => {
    const saved = await api(page, 'PUT', '/api/admin/media', {
      image: { engine: 'openai', baseUrl: 'http://127.0.0.1:18080/v1', model: 'e2e-image', size: '1024x1024', steps: 25, comfyWorkflow: '' },
    });
    expect(saved.status).toBe(200);
    await page.goto('/');
    await page.getByTestId('image-toggle').click();
    await send(page, 'draw a red square');
    await expect(messages(page)).toContainText('Here is your picture.');
    await idle(page);
    const img = messages(page).locator('img[src^="/api/files/"]').first();
    await expect(img).toBeVisible();
    await shot(page, 'p5-image');
  });

  test('an admin-installed plugin changes how messages render', async () => {
    const uploaded = await page.evaluate(async () => {
      const csrf = document.cookie.split('; ').find((c) => c.startsWith('claudia_csrf='))?.split('=')[1] ?? '';
      const form = new FormData();
      form.append('manifest', JSON.stringify({ id: 'wave', name: 'Wave', version: '1.0.0', type: 'renderer-extension' }));
      form.append(
        'bundle',
        new Blob(["import React from 'react';\nexport default { preProcess: (content) => content.replaceAll(':wave:', '👋 (React ' + React.version + ')') };"], {
          type: 'text/javascript',
        }),
        'index.mjs'
      );
      const res = await fetch('/api/admin/plugins', { method: 'POST', body: form, headers: { 'X-Claudia-CSRF': decodeURIComponent(csrf) } });
      return res.status;
    });
    expect(uploaded).toBe(201);
    expect((await api(page, 'PATCH', '/api/admin/plugins/wave', { enabled: true })).status).toBe(200);
    await page.goto('/');
    await send(page, ':wave: hello');
    await expect(messages(page)).toContainText(/👋 \(React 18\.\d+\.\d+\) hello/);
    await idle(page);
  });
});

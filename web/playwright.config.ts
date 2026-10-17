import { defineConfig, devices } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

/**
 * Browser tests against the production build (`npm run build` first), with an
 * embedded database in a fresh temp folder and a mock LLM.
 */
const PORT = 18090;
const DATA_DIR = path.join(os.tmpdir(), `claudia-e2e-${Date.now()}`);

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npx tsx e2e/mock-llm.ts',
      port: 18080,
      reuseExistingServer: false,
      env: { MOCK_LLM_PORT: '18080' },
    },
    {
      command: 'node dist/server/index.cjs',
      url: `http://127.0.0.1:${PORT}/readyz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'production',
        PORT: String(PORT),
        HOST: '127.0.0.1',
        DATA_DIR,
        CLAUDIA_SECRET_KEY: 'e2e-secret-key-e2e-secret-key-0123456789',
        CLAUDIA_ADMIN_EMAIL: 'admin@e2e.test',
        CLAUDIA_ADMIN_PASSWORD: 'admin-password-e2e',
        LOG_LEVEL: 'warn',
      },
    },
  ],
});

import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// Same aliases and shared-import resolution as the client build.
// Server tests run in Node; client tests opt into jsdom per file.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['server/**/*.test.ts', 'client/**/*.test.{ts,tsx}', 'shared/**/*.test.ts', 'scripts/**/*.test.mjs'],
      environment: 'node',
      setupFiles: ['./client/test/setup.ts'],
      restoreMocks: true,
      testTimeout: 30_000,
      hookTimeout: 60_000,
    },
  })
);

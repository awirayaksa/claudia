import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// The shared ../electron code require()s packages relative to itself, which
// finds the root node_modules, absent in CI and Docker. Let it fall back to
// web/node_modules, as the server bundle does. Test processes and the PDF
// worker threads they start inherit this.
const webModules = path.join(path.dirname(fileURLToPath(import.meta.url)), 'node_modules');
process.env.NODE_PATH = [webModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);

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

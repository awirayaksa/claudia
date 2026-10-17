import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const fromRoot = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Kept separate from vite.config.ts so tests don't start the Electron plugins.
// Tests run in Node by default; component tests opt into jsdom with a
// `// @vitest-environment jsdom` comment at the top of the file.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fromRoot('./src'),
      '@electron': fromRoot('./electron'),
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'electron/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
  },
});

import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'tsup';

/**
 * Server bundle. First-party code (server/, shared/, ../src, ../electron/services)
 * is bundled; every package stays external and loads from web/node_modules at
 * runtime (bundling pdf-parse, for one, triggers its debug path and crashes).
 * CommonJS, because the built-in MCP servers call require().
 */
export default defineConfig({
  entry: { index: 'server/index.ts' },
  outDir: 'dist/server',
  format: ['cjs'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  shims: true,
  splitting: false,
  tsconfig: 'tsconfig.server.json',
  esbuildOptions(options) {
    // Leave every bare import to Node's resolver at runtime
    options.packages = 'external';
  },
  async onSuccess() {
    // Migrations ship next to the bundle
    fs.cpSync(path.join('server', 'db', 'migrations'), path.join('dist', 'server', 'migrations'), { recursive: true });
  },
});

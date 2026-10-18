import { defineConfig, normalizePath, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(webDir, '..');
/** Code shared with the desktop app, compiled into the web client. */
const sharedDirs = [path.join(rootDir, 'src'), path.join(rootDir, 'electron')].map(
  (d) => normalizePath(d) + '/'
);
const webImporter = path.join(webDir, 'index.html');

/**
 * Bare imports in files under ../src resolve against web/, not the root.
 * Otherwise a shared file would pull a second React or Redux from the root
 * node_modules, and Docker (which has no root node_modules) couldn't build.
 */
function resolveSharedFromWeb(): Plugin {
  return {
    name: 'claudia:resolve-shared-from-web',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer) return null;
      const isBare =
        !source.startsWith('.') &&
        !source.startsWith('/') &&
        !source.startsWith('\0') &&
        !/^[a-zA-Z]:[\\/]/.test(source) &&
        !source.includes(':') &&
        source !== '@' &&
        !source.startsWith('@/') &&
        !source.startsWith('@web/') &&
        !source.startsWith('@shared/');
      if (!isBare) return null;
      const from = normalizePath(importer.split('?')[0]);
      if (!sharedDirs.some((dir) => from.startsWith(dir))) return null;
      return this.resolve(source, webImporter, { ...options, skipSelf: true });
    },
  };
}

export default defineConfig({
  root: webDir,
  plugins: [resolveSharedFromWeb(), react()],
  resolve: {
    alias: {
      '@': path.join(rootDir, 'src'),
      '@web': path.join(webDir, 'client'),
      '@shared': path.join(webDir, 'shared'),
    },
    dedupe: [
      'react',
      'react-dom',
      'react-redux',
      '@reduxjs/toolkit',
      'react-markdown',
      '@mcp-ui/client',
      'framer-motion',
      '@radix-ui/react-tooltip',
    ],
  },
  server: {
    port: 5180,
    fs: { allow: [rootDir] },
    proxy: {
      // ws: live updates (/api/ws); the Host header stays the page's, so the server's origin check passes
      '/api': { target: 'http://localhost:8080', changeOrigin: false, ws: true },
      '/healthz': 'http://localhost:8080',
      '/readyz': 'http://localhost:8080',
    },
  },
  build: {
    outDir: path.join(webDir, 'dist', 'client'),
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
});

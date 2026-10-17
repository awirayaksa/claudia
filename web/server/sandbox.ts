/**
 * The sandbox origin serves static pages that render untrusted content: the
 * MCP-UI proxy, artifacts (Phase 5) and file previews. It is a different
 * origin from the app, so script there can't reach the app's cookies or DOM.
 *
 * - CLAUDIA_SANDBOX_ORIGIN on its own: a separate host routed to this server
 *   (requests are told apart by their Host header).
 * - CLAUDIA_SANDBOX_PORT: single-host trials; a second listener on that port.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config';

export function sandboxOriginFor(config: AppConfig): string | null {
  if (config.CLAUDIA_SANDBOX_ORIGIN) return new URL(config.CLAUDIA_SANDBOX_ORIGIN).origin;
  if (config.CLAUDIA_SANDBOX_PORT && config.CLAUDIA_PUBLIC_URL) {
    const u = new URL(config.CLAUDIA_PUBLIC_URL);
    u.port = String(config.CLAUDIA_SANDBOX_PORT);
    return u.origin;
  }
  return null;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
};

const requireFrom = createRequire(import.meta.url);
const pkgDir = (name: string) => path.dirname(requireFrom.resolve(`${name}/package.json`));

/**
 * Third-party files the sandbox pages load (never the app): Pyodide for the
 * code interpreter, React and Babel for React previews. A fixed list, so no
 * other file under node_modules can be reached.
 */
let vendorFiles: Map<string, string> | null = null;
function vendor(): Map<string, string> {
  if (vendorFiles) return vendorFiles;
  const out = new Map<string, string>();
  try {
    const py = pkgDir('pyodide');
    for (const f of ['pyodide.js', 'pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']) {
      out.set(`vendor/pyodide/${f}`, path.join(py, f));
    }
  } catch {
    /* the code interpreter stays unavailable */
  }
  try {
    out.set('vendor/react.js', path.join(pkgDir('react'), 'umd', 'react.production.min.js'));
    out.set('vendor/react-dom.js', path.join(pkgDir('react-dom'), 'umd', 'react-dom.production.min.js'));
    out.set('vendor/babel.js', path.join(pkgDir('@babel/standalone'), 'babel.min.js'));
  } catch {
    /* React previews stay unavailable */
  }
  vendorFiles = out;
  return out;
}

/** Serve one file from the sandbox folder; false when there is nothing to serve. */
export function serveSandboxFile(
  dir: string,
  appOrigin: string | null,
  req: IncomingMessage,
  res: ServerResponse
): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const vendored = vendor().get(rel);
  const file = vendored ?? path.resolve(dir, rel);
  if (!vendored && !file.startsWith(path.resolve(dir) + path.sep)) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    // Vendored packages change only with an upgrade
    'Cache-Control': vendored ? 'public, max-age=86400' : 'no-cache',
    // Pyodide's worker and the previews load these cross-origin (from opaque-origin frames)
    ...(vendored ? { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' } : {}),
    'X-Content-Type-Options': 'nosniff',
    // Only the app may embed sandbox pages
    'Content-Security-Policy': `frame-ancestors ${appOrigin ?? "'self'"}`,
    'Referrer-Policy': 'no-referrer',
  });
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(file).pipe(res);
  return true;
}

/** Second listener for single-host trials (CLAUDIA_SANDBOX_PORT). */
export function buildSandboxApp(dir: string, appOrigin: string | null): FastifyInstance {
  const app = Fastify({ logger: false });
  app.all('/*', async (req, reply) => {
    reply.hijack();
    if (!serveSandboxFile(dir, appOrigin, req.raw, reply.raw)) {
      reply.raw.writeHead(404, { 'Content-Type': 'text/plain' });
      reply.raw.end('Not found');
    }
  });
  return app;
}

/** Host-routed mode: requests for the sandbox host never reach the app. */
export function registerSandboxHost(app: FastifyInstance, config: AppConfig, dir: string): void {
  const origin = config.CLAUDIA_SANDBOX_ORIGIN ? new URL(config.CLAUDIA_SANDBOX_ORIGIN) : null;
  if (!origin || config.CLAUDIA_SANDBOX_PORT) return;
  const appOrigin = config.CLAUDIA_PUBLIC_URL ? new URL(config.CLAUDIA_PUBLIC_URL).origin : null;
  if (appOrigin === origin.origin) {
    app.log.warn('CLAUDIA_SANDBOX_ORIGIN equals CLAUDIA_PUBLIC_URL: the sandbox must be a different origin; ignoring it');
    return;
  }
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers.host?.toLowerCase() !== origin.host.toLowerCase()) return;
    reply.hijack();
    if (!serveSandboxFile(dir, appOrigin, req.raw, reply.raw)) {
      reply.raw.writeHead(404, { 'Content-Type': 'text/plain' });
      reply.raw.end('Not found');
    }
  });
}

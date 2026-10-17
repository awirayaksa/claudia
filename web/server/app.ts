import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { AppConfig } from './config';
import type { DbHandle } from './db/client';
import { VERSION } from './version';
import type { HealthResponse, ReadyResponse } from '../shared/api';

export interface AppDeps {
  config: AppConfig;
  db: DbHandle;
  migrationsDir: string;
  /** Built client to serve; omitted in development (Vite serves it). */
  clientDir?: string;
  logger?: FastifyServerOptions['logger'];
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
}

export function defaultLogger(config: AppConfig): FastifyServerOptions['logger'] {
  if (config.NODE_ENV === 'test') return false;
  return {
    level: config.LOG_LEVEL,
    // Never log credentials
    redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    ...(config.isProduction ? {} : { transport: { target: 'pino-pretty', options: { singleLine: true } } }),
  };
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? defaultLogger(deps.config),
    // Request ids show up in every log line of the request
    genReqId: () => crypto.randomUUID(),
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });
  app.decorate('deps', deps);

  // ─── Health ───────────────────────────────────────────────────────────────
  // /healthz: the process is up. /readyz: the database answers and is migrated.
  app.get('/healthz', async (): Promise<HealthResponse> => ({ status: 'ok', version: VERSION }));

  app.get('/readyz', async (_req, reply): Promise<ReadyResponse> => {
    try {
      await deps.db.ping();
      const migrations = await deps.db.migrationStatus(deps.migrationsDir);
      const ready = migrations.pending === 0;
      reply.code(ready ? 200 : 503);
      return { status: ready ? 'ready' : 'not_ready', database: deps.db.kind, migrations };
    } catch (err) {
      reply.code(503);
      return {
        status: 'not_ready',
        database: deps.db.kind,
        migrations: { applied: 0, pending: 0 },
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // ─── API ──────────────────────────────────────────────────────────────────
  await app.register(
    async (api) => {
      api.setNotFoundHandler((req, reply) => {
        reply.code(404).send({ error: { code: 'not_found', message: `No route for ${req.method} ${req.url}` } });
      });
    },
    { prefix: '/api' }
  );

  // ─── Client (production build) ────────────────────────────────────────────
  if (deps.clientDir && fs.existsSync(path.join(deps.clientDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: deps.clientDir,
      // Hashed assets never change; index.html must always be revalidated
      setHeaders: (res, filePath) => {
        res.header(
          'Cache-Control',
          filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache'
        );
      },
    });
    // Client-side routes (/c/:id, /admin/...) all load the SPA
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && req.headers.accept?.includes('text/html')) {
        return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
      }
      reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
    });
  }

  return app;
}

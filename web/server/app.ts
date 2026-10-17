import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyHelmet from '@fastify/helmet';
import type { AppConfig } from './config';
import type { DbHandle } from './db/client';
import type { ServerContext } from './context';
import { VERSION } from './version';
import { createKeyring } from './crypto/keys';
import { SecretBox } from './crypto/secrets';
import { registerErrorHandler } from './lib/errors';
import { AppSettings } from './modules/settings/app-settings';
import { LoginGuard } from './auth/login-guard';
import { registerAuthHooks } from './auth/rbac';
import { authRoutes } from './auth/routes';
import { bootstrapAdmin } from './auth/bootstrap';
import { adminUserRoutes, meRoutes } from './modules/users/routes';
import { adminConnectionRoutes, modelRoutes } from './modules/connections/routes';
import { adminSettingsRoutes } from './modules/settings/routes';
import { chatRoutes, folderRoutes, llmRoutes, runRoutes } from './modules/chats/routes';
import { ModelRegistry } from './llm/model-registry';
import { RunHub } from './llm/run-hub';
import { ChatOrchestrator, type OrchestratorDeps } from './llm/chat-orchestrator';
import { registerSandboxHost, sandboxOriginFor } from './sandbox';
import type { HealthResponse, PublicConfig, ReadyResponse } from '../shared/api';

export interface AppDeps {
  config: AppConfig;
  db: DbHandle;
  migrationsDir: string;
  /** Root secret (CLAUDIA_SECRET_KEY or the trial key file). */
  rootSecret: string;
  /** Built client to serve; omitted in development (Vite serves it). */
  clientDir?: string;
  /** Static sandbox pages (served on the sandbox origin only). */
  sandboxDir?: string;
  logger?: FastifyServerOptions['logger'];
  /** Test hook: extra orchestrator dependencies (e.g. tools). */
  orchestrator?: Partial<OrchestratorDeps>;
  /** Create the env admin on startup (default true). */
  bootstrap?: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
    ctx: ServerContext;
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

/** Content-Security-Policy for the app origin. */
function cspDirectives(config: AppConfig) {
  const sandbox = sandboxOriginFor(config);
  return {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    // React style props and the code highlighter set inline styles
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
    fontSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"],
    // MCP-UI, artifacts and previews only ever come from the sandbox origin
    frameSrc: sandbox ? [sandbox] : ["'none'"],
    workerSrc: ["'self'", 'blob:'],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
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

  const keyring = createKeyring(deps.rootSecret, deps.config.previousSecretKeys);
  const secrets = new SecretBox(keyring);
  const settings = new AppSettings(deps.db.db);
  const runs = new RunHub();
  const models = new ModelRegistry({ db: deps.db.db, secrets, settings, log: app.log });
  const ctx: ServerContext = {
    config: deps.config,
    dbHandle: deps.db,
    db: deps.db.db,
    keyring,
    secrets,
    settings,
    loginGuard: new LoginGuard(),
    models,
    runs,
    orchestrator: new ChatOrchestrator({ db: deps.db.db, models, runs, settings, log: app.log, ...deps.orchestrator }),
    log: app.log,
  };
  app.decorate('ctx', ctx);
  app.addHook('onClose', async () => runs.close());

  if (deps.sandboxDir) registerSandboxHost(app, deps.config, deps.sandboxDir);
  registerErrorHandler(app);
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: false });
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: { directives: cspDirectives(deps.config) },
    // Allow the sandbox origin to load its own resources cross-origin
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  registerAuthHooks(app, ctx);

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
      api.get('/public-config', async (): Promise<PublicConfig> => ({
        version: VERSION,
        sandboxOrigin: sandboxOriginFor(deps.config),
      }));
      await api.register((a) => authRoutes(a, ctx), { prefix: '/auth' });
      await api.register((a) => meRoutes(a, ctx), { prefix: '/me' });
      await api.register((a) => modelRoutes(a, ctx), { prefix: '/models' });
      await api.register((a) => chatRoutes(a, ctx), { prefix: '/chats' });
      await api.register((a) => folderRoutes(a, ctx), { prefix: '/folders' });
      await api.register((a) => runRoutes(a, ctx), { prefix: '/runs' });
      await api.register((a) => llmRoutes(a, ctx), { prefix: '/llm' });
      await api.register((a) => adminUserRoutes(a, ctx), { prefix: '/admin/users' });
      await api.register((a) => adminConnectionRoutes(a, ctx), { prefix: '/admin/connections' });
      await api.register((a) => adminSettingsRoutes(a, ctx), { prefix: '/admin/settings' });
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

  if (deps.bootstrap !== false) await bootstrapAdmin(ctx);
  return app;
}

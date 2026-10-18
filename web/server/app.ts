import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyHelmet from '@fastify/helmet';
import fastifyMultipart from '@fastify/multipart';
import type { AppConfig } from './config';
import type { DbHandle } from './db/client';
import type { ServerContext } from './context';
import { VERSION } from './version';
import { createKeyring } from './crypto/keys';
import { SecretBox } from './crypto/secrets';
import { registerErrorHandler } from './lib/errors';
import { AppSettings } from './modules/settings/app-settings';
import { MemoryLoginGuard, RedisLoginGuard } from './auth/login-guard';
import { Cluster } from './cluster/cluster';
import { S3Storage } from './storage/s3';
import { AuditLog, registerAdminAudit } from './admin/audit';
import { Webhooks } from './admin/webhooks';
import { adminOpsRoutes, bannerRoutes } from './admin/routes';
import { registerRequestTracing } from './telemetry';
import { registerAuthHooks } from './auth/rbac';
import { authRoutes } from './auth/routes';
import { bootstrapAdmin } from './auth/bootstrap';
import { adminUserRoutes, meRoutes } from './modules/users/routes';
import { adminConnectionRoutes, modelRoutes, userConnectionRoutes } from './modules/connections/routes';
import { adminSettingsRoutes } from './modules/settings/routes';
import { chatRoutes, folderRoutes, llmRoutes, runRoutes } from './modules/chats/routes';
import { ModelRegistry } from './llm/model-registry';
import { RunHub } from './llm/run-hub';
import { ChatOrchestrator, type OrchestratorDeps } from './llm/chat-orchestrator';
import { registerSandboxHost, sandboxOriginFor } from './sandbox';
import { LocalStorage, type Storage } from './storage/local';
import { ExtractPool } from './extract/pool';
import { FileService } from './modules/files/service';
import { fileRoutes } from './modules/files/routes';
import { SkillService } from './modules/skills/service';
import { skillRoutes } from './modules/skills/routes';
import { McpPools } from './mcp/mcp-pool';
import { LdapService } from './auth/ldap';
import { ShareService } from './modules/shares/service';
import { shareRoutes, sharedRoutes } from './modules/shares/routes';
import { ChatRepo, TEMPORARY_CHAT_TTL_MS } from './modules/chats/repo';
import { adminLdapRoutes } from './auth/ldap-routes';
import { adminMcpRoutes, mcpUserRoutes, toolRoutes } from './mcp/routes';
import { AccessService } from './auth/access';
import { apiKeyRoutes } from './auth/api-keys';
import { UsageService } from './modules/usage/service';
import { workspaceModelRoutes } from './modules/workspace/models';
import { workspacePromptRoutes } from './modules/workspace/prompts';
import { memoryRoutes } from './modules/memories/routes';
import { adminGroupRoutes, directoryRoutes } from './modules/groups/routes';
import { openaiRoutes } from './modules/openai/routes';
import { RagConfig } from './rag/config';
import { KnowledgeService } from './rag/knowledge';
import { SourceBuilder } from './rag/sources';
import { VectorStore } from './rag/vector-store';
import { JobQueue } from './jobs/queue';
import { EventHub, registerWebSocket } from './ws/gateway';
import { adminRagRoutes, knowledgeRoutes } from './modules/knowledge/routes';
import { MediaConfig } from './media/config';
import { adminMediaRoutes, audioRoutes } from './media/routes';
import { adminToolServerRoutes } from './tools/routes';
import { adminPluginRoutes, pluginListRoutes, registerPluginBundles } from './modules/plugins/routes';
import { createHash } from 'node:crypto';
import { PLUGIN_IMPORT_MAP } from '../shared/plugins';
import { MAX_UPLOAD_BYTES } from '../shared/files';
import { eq } from 'drizzle-orm';
import { knowledgeBases } from './db/schema';
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
  /** Start the enabled global MCP servers on startup (default true). */
  startMcp?: boolean;
  /** Run background jobs in this process (default true). */
  startJobs?: boolean;
  /** Test hook: where YouTube pages are fetched from. */
  youtubeOrigin?: string;
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
    // The plugin import map is the one inline script, allowed by its hash
    scriptSrc: ["'self'", `'sha256-${createHash('sha256').update(PLUGIN_IMPORT_MAP).digest('base64')}'`],
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
  const cluster = await Cluster.open({ redisUrl: deps.config.REDIS_URL, prefix: deps.config.REDIS_PREFIX, log: app.log });
  const settings = new AppSettings(deps.db.db, cluster);
  const runs = new RunHub({ cluster, log: app.log });
  const access = new AccessService({ db: deps.db.db, settings });
  const usage = new UsageService({ db: deps.db.db, access });
  const models = new ModelRegistry({ db: deps.db.db, secrets, settings, access, log: app.log, cluster });
  const storage: Storage = deps.config.S3_BUCKET
    ? new S3Storage({
        bucket: deps.config.S3_BUCKET,
        region: deps.config.S3_REGION,
        endpoint: deps.config.S3_ENDPOINT,
        accessKeyId: deps.config.S3_ACCESS_KEY_ID,
        secretAccessKey: deps.config.S3_SECRET_ACCESS_KEY,
        forcePathStyle: deps.config.S3_FORCE_PATH_STYLE,
        prefix: deps.config.S3_PREFIX,
      })
    : new LocalStorage(path.join(deps.config.dataDir, 'storage'));
  const extract = new ExtractPool();
  const files = new FileService({ db: deps.db.db, storage, extract, log: app.log });
  const skills = new SkillService(deps.db.db);
  const rag = new RagConfig({ db: deps.db.db, secrets, cluster });
  const media = new MediaConfig({ db: deps.db.db, secrets, cluster });
  const jobQueue = new JobQueue({ db: deps.db.db, log: app.log, notifier: deps.db });
  const events = new EventHub(cluster);
  await events.listen();
  const webhooks = new Webhooks({ db: deps.db.db, secrets, jobs: jobQueue, log: app.log });
  const audit = new AuditLog({ db: deps.db.db, settings, log: app.log, webhooks });
  const knowledge = new KnowledgeService({
    db: deps.db.db,
    storage,
    extract,
    config: rag,
    vectors: new VectorStore(deps.db.db),
    jobs: jobQueue,
    events,
    log: app.log,
    webhooks,
  });
  const netPolicy = () => ({ allow: settings.peek('net.allowlist').hosts });
  const sources = new SourceBuilder({
    db: deps.db.db,
    config: rag,
    knowledge,
    web: { extract, policy: netPolicy, ...(deps.youtubeOrigin ? { youtubeOrigin: deps.youtubeOrigin } : {}) },
    log: app.log,
  });
  const mcp = new McpPools({
    db: deps.db.db,
    secrets,
    settings,
    allowStdio: deps.config.CLAUDIA_ALLOW_STDIO_MCP,
    log: app.log,
    dataDir: deps.config.dataDir,
    extract,
    netPolicy,
    access,
  });
  const ctx: ServerContext = {
    config: deps.config,
    dbHandle: deps.db,
    db: deps.db.db,
    keyring,
    secrets,
    settings,
    loginGuard: cluster.redis ? new RedisLoginGuard(cluster.redis, deps.config.REDIS_PREFIX) : new MemoryLoginGuard(),
    models,
    runs,
    orchestrator: new ChatOrchestrator({
      db: deps.db.db,
      models,
      runs,
      settings,
      log: app.log,
      files,
      skills,
      toolsFor: (user, toolIds, alwaysOn) => mcp.toolset(user.id, toolIds, alwaysOn),
      usage,
      access,
      sources,
      knowledge,
      rag,
      sandboxOrigin: sandboxOriginFor(deps.config),
      media,
      webhooks,
      ...deps.orchestrator,
    }),
    storage,
    extract,
    files,
    skills,
    mcp,
    ldap: new LdapService({ db: deps.db.db, secrets, config: deps.config, log: app.log }),
    shares: new ShareService(deps.db.db),
    access,
    usage,
    rag,
    knowledge,
    jobs: jobQueue,
    events,
    media,
    cluster,
    audit,
    webhooks,
    log: app.log,
  };
  app.decorate('ctx', ctx);
  cluster.on('mcp.global', ({ id }) => mcp.reloadGlobal(String(id)));
  // Temporary chats go after a day without activity
  const purgeTemporary = () =>
    void new ChatRepo(deps.db.db)
      .purgeTemporary(new Date(Date.now() - TEMPORARY_CHAT_TTL_MS))
      .catch((err) => app.log.warn({ err: String(err) }, 'removing old temporary chats failed'));
  const sweeper = setInterval(purgeTemporary, 60 * 60 * 1000);
  sweeper.unref();
  app.addHook('onClose', async () => {
    clearInterval(sweeper);
    await jobQueue.stop();
    runs.close();
    events.close();
    audit.close();
    await mcp.close();
    await extract.close();
    await cluster.close();
  });

  if (deps.sandboxDir) registerSandboxHost(app, deps.config, deps.sandboxDir);
  registerErrorHandler(app);
  await app.register(fastifyCookie);
  // Several instances count together in Redis; if Redis fails, requests go through rather than all failing
  await app.register(fastifyRateLimit, {
    global: false,
    ...(cluster.redis ? { redis: cluster.redis, nameSpace: `${deps.config.REDIS_PREFIX}rate:`, skipOnError: true } : {}),
  });
  await app.register(fastifyMultipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5, parts: 6 } });
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: { directives: cspDirectives(deps.config) },
    // Allow the sandbox origin to load its own resources cross-origin
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  registerRequestTracing(app);
  registerAuthHooks(app, ctx);
  registerAdminAudit(app, audit);
  events.guard('kb', async (user, id) => {
    const [kb] = await deps.db.db.select({ id: knowledgeBases.id, ownerId: knowledgeBases.ownerId }).from(knowledgeBases).where(eq(knowledgeBases.id, id));
    return !!kb && (await access.rights(user, 'knowledge', kb)).read;
  });
  await registerWebSocket(app, ctx);

  // ─── Health ───────────────────────────────────────────────────────────────
  // /healthz: the process is up. /readyz: the database answers and is migrated.
  app.get('/healthz', async (): Promise<HealthResponse> => ({ status: 'ok', version: VERSION }));

  app.get('/readyz', async (_req, reply): Promise<ReadyResponse> => {
    const storageKind = deps.config.S3_BUCKET ? 's3' : 'local';
    let redis: ReadyResponse['redis'] = cluster.distributed ? 'ok' : 'off';
    try {
      if (cluster.distributed) {
        await cluster.ping().catch((err) => {
          redis = 'error';
          throw err;
        });
      }
      await deps.db.ping();
      const migrations = await deps.db.migrationStatus(deps.migrationsDir);
      const ready = migrations.pending === 0;
      reply.code(ready ? 200 : 503);
      return { status: ready ? 'ready' : 'not_ready', database: deps.db.kind, migrations, redis, storage: storageKind };
    } catch (err) {
      reply.code(503);
      return {
        status: 'not_ready',
        database: deps.db.kind,
        migrations: { applied: 0, pending: 0 },
        redis,
        storage: storageKind,
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
      await api.register((a) => memoryRoutes(a, ctx), { prefix: '/me/memories' });
      await api.register((a) => apiKeyRoutes(a, ctx), { prefix: '/me/api-keys' });
      await api.register((a) => workspaceModelRoutes(a, ctx), { prefix: '/workspace/models' });
      await api.register((a) => workspacePromptRoutes(a, ctx), { prefix: '/workspace/prompts' });
      await api.register((a) => directoryRoutes(a, ctx), { prefix: '/directory' });
      await api.register((a) => openaiRoutes(a, ctx), { prefix: '/v1' });
      await api.register((a) => knowledgeRoutes(a, ctx), { prefix: '/knowledge' });
      await api.register((a) => audioRoutes(a, ctx), { prefix: '/audio' });
      await api.register((a) => pluginListRoutes(a, ctx), { prefix: '/plugins' });
      await api.register((a) => modelRoutes(a, ctx), { prefix: '/models' });
      await api.register((a) => chatRoutes(a, ctx), { prefix: '/chats' });
      await api.register((a) => folderRoutes(a, ctx), { prefix: '/folders' });
      await api.register((a) => shareRoutes(a, ctx), { prefix: '/shares' });
      await api.register((a) => sharedRoutes(a, ctx), { prefix: '/shared' });
      await api.register((a) => runRoutes(a, ctx), { prefix: '/runs' });
      await api.register((a) => llmRoutes(a, ctx), { prefix: '/llm' });
      await api.register((a) => userConnectionRoutes(a, ctx), { prefix: '/connections' });
      await api.register((a) => fileRoutes(a, ctx), { prefix: '/files' });
      await api.register((a) => skillRoutes(a, ctx), { prefix: '/skills' });
      await api.register((a) => mcpUserRoutes(a, ctx), { prefix: '/mcp' });
      await api.register((a) => toolRoutes(a, ctx), { prefix: '/tools' });
      await api.register((a) => adminMcpRoutes(a, ctx), { prefix: '/admin/mcp-servers' });
      await api.register((a) => adminUserRoutes(a, ctx), { prefix: '/admin/users' });
      await api.register((a) => adminConnectionRoutes(a, ctx), { prefix: '/admin/connections' });
      await api.register((a) => adminSettingsRoutes(a, ctx), { prefix: '/admin/settings' });
      await api.register((a) => adminLdapRoutes(a, ctx), { prefix: '/admin/ldap' });
      await api.register((a) => adminGroupRoutes(a, ctx), { prefix: '/admin/groups' });
      await api.register((a) => adminRagRoutes(a, ctx), { prefix: '/admin/rag' });
      await api.register((a) => adminMediaRoutes(a, ctx), { prefix: '/admin/media' });
      await api.register((a) => adminToolServerRoutes(a, ctx), { prefix: '/admin/tool-servers' });
      await api.register((a) => adminPluginRoutes(a, ctx), { prefix: '/admin/plugins' });
      await api.register((a) => adminOpsRoutes(a, ctx), { prefix: '/admin' });
      await api.register((a) => bannerRoutes(a, ctx), { prefix: '/banners' });
      api.setNotFoundHandler((req, reply) => {
        reply.code(404).send({ error: { code: 'not_found', message: `No route for ${req.method} ${req.url}` } });
      });
    },
    { prefix: '/api' }
  );

  registerPluginBundles(app, ctx);

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

  // Fails only when the database isn't migrated yet (/readyz reports that)
  await skills.seedBuiltins().catch((err) => app.log.warn({ err: String(err) }, 'seeding built-in skills failed'));
  if (deps.bootstrap !== false) await bootstrapAdmin(ctx);
  if (deps.bootstrap !== false) purgeTemporary();
  if (deps.startJobs !== false) jobQueue.start();
  if (deps.startMcp !== false) void mcp.startAll().catch((err) => app.log.warn({ err: String(err) }, 'starting MCP servers failed'));
  return app;
}

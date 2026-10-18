import path from 'node:path';
import { buildApp } from './app';
import { ConfigError, loadConfig } from './config';
import { openDatabase } from './db/client';
import { resolveRootSecret } from './crypto/keys';
import { buildSandboxApp, sandboxOriginFor } from './sandbox';
import { defaultClientDir, defaultMigrationsDir, defaultSandboxDir } from './paths';
import { routeConsoleToLogger } from './lib/console';
import { startTelemetry, stopTelemetry } from './telemetry';

async function main() {
  const config = loadConfig();
  // Before anything makes requests, so they are traced
  const tracing = await startTelemetry({ endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT });
  const migrationsDir = defaultMigrationsDir();
  const db = await openDatabase({
    url: config.DATABASE_URL,
    dataDir: config.DATABASE_URL ? undefined : path.join(config.dataDir, 'pglite'),
  });
  const secret = resolveRootSecret(config.CLAUDIA_SECRET_KEY, config.dataDir);

  const clientDir = config.CLAUDIA_CLIENT_DIR ? path.resolve(config.CLAUDIA_CLIENT_DIR) : defaultClientDir();
  const sandboxDir = defaultSandboxDir();

  // Migrate before anything (bootstrap included) touches the tables
  const status = await db.migrate(migrationsDir);

  const app = await buildApp({
    config,
    db,
    migrationsDir,
    rootSecret: secret.secret,
    clientDir: config.isProduction ? clientDir : undefined,
    sandboxDir,
  });
  // Shared desktop code logs with console.*; keep users' content out of normal logs
  routeConsoleToLogger(app.log);
  app.log.info({ database: db.kind, migrations: status }, 'database ready');
  if (tracing) app.log.info({ endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT }, 'OpenTelemetry tracing on');

  if (db.kind === 'pglite') {
    app.log.warn(
      'Using the embedded PGlite database. It is for development and single-user trials; set DATABASE_URL to a PostgreSQL server for real use.'
    );
  }
  if (secret.source !== 'env') {
    app.log.warn(
      { file: secret.file },
      'CLAUDIA_SECRET_KEY is not set: using a key file in DATA_DIR. Every backup of DATA_DIR then holds the key next to the data it protects. Set CLAUDIA_SECRET_KEY for real use.'
    );
  }

  let sandboxApp: Awaited<ReturnType<typeof buildSandboxApp>> | null = null;
  if (config.CLAUDIA_SANDBOX_PORT && sandboxDir) {
    const appOrigin = config.CLAUDIA_PUBLIC_URL ? new URL(config.CLAUDIA_PUBLIC_URL).origin : null;
    sandboxApp = buildSandboxApp(sandboxDir, appOrigin);
    await sandboxApp.listen({ host: config.HOST, port: config.CLAUDIA_SANDBOX_PORT });
    app.log.info({ origin: sandboxOriginFor(config) }, 'sandbox origin listening');
  } else if (!sandboxOriginFor(config)) {
    app.log.warn('No sandbox origin configured (CLAUDIA_SANDBOX_ORIGIN or CLAUDIA_SANDBOX_PORT): MCP-UI and previews stay off.');
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await sandboxApp?.close();
      await db.close();
      await stopTelemetry();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else {
    console.error(err);
  }
  process.exit(1);
});

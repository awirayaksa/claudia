import path from 'node:path';
import { buildApp } from './app';
import { ConfigError, loadConfig } from './config';
import { openDatabase } from './db/client';
import { defaultClientDir, defaultMigrationsDir } from './paths';

async function main() {
  const config = loadConfig();
  const migrationsDir = defaultMigrationsDir();
  const db = await openDatabase({
    url: config.DATABASE_URL,
    dataDir: config.DATABASE_URL ? undefined : path.join(config.dataDir, 'pglite'),
  });

  const clientDir = config.CLAUDIA_CLIENT_DIR ? path.resolve(config.CLAUDIA_CLIENT_DIR) : defaultClientDir();
  const app = await buildApp({ config, db, migrationsDir, clientDir: config.isProduction ? clientDir : undefined });

  if (db.kind === 'pglite') {
    app.log.warn(
      'Using the embedded PGlite database. It is for development and single-user trials; set DATABASE_URL to a PostgreSQL server for real use.'
    );
  }

  const status = await db.migrate(migrationsDir);
  app.log.info({ database: db.kind, migrations: status }, 'database ready');

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await db.close();
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

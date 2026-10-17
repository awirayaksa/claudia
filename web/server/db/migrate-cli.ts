/** Apply pending migrations and exit: `npm run db:migrate`. */
import path from 'node:path';
import { loadConfig } from '../config';
import { defaultMigrationsDir } from '../paths';
import { openDatabase } from './client';

const config = loadConfig();
const db = await openDatabase({
  url: config.DATABASE_URL,
  dataDir: config.DATABASE_URL ? undefined : path.join(config.dataDir, 'pglite'),
});
try {
  const status = await db.migrate(defaultMigrationsDir());
  console.log(`${db.kind}: ${status.applied} migration(s) applied, ${status.pending} pending.`);
} finally {
  await db.close();
}

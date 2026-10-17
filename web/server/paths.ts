import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * This file's directory: web/server in development (tsx), dist/server in the
 * bundle (tsup shims import.meta.url for CommonJS).
 */
const here = path.dirname(fileURLToPath(import.meta.url));

function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((c) => fs.existsSync(c));
}

/** drizzle-kit's migration folder: copied next to the bundle, or the source folder. */
export function defaultMigrationsDir(): string {
  const dir = firstExisting([path.join(here, 'migrations'), path.join(here, 'db', 'migrations')]);
  if (!dir) throw new Error(`Migrations folder not found near ${here}`);
  return dir;
}

/** The built client: dist/client next to dist/server. */
export function defaultClientDir(): string | undefined {
  return firstExisting([path.join(here, '..', 'client'), path.join(here, '..', 'dist', 'client')]);
}

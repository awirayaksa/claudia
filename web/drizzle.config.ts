import { defineConfig } from 'drizzle-kit';

// One migration set for PostgreSQL and PGlite. Generate with `npm run db:generate`.
export default defineConfig({
  dialect: 'postgresql',
  schema: './server/db/schema/index.ts',
  out: './server/db/migrations',
});

/**
 * Server configuration from environment variables, validated at startup.
 *
 * A setting given by an environment variable wins over the same setting in
 * the database (`app_config`) and is shown read-only in the admin UI.
 */
import path from 'node:path';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no', ''])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Uploads, workspaces, the embedded database and (trials only) the generated key. */
  DATA_DIR: z.string().default('./data'),
  /**
   * postgres://… for PostgreSQL 16+ with pgvector. When unset, an embedded
   * PGlite database in DATA_DIR is used: development, tests and
   * single-container trials only (it runs one query at a time).
   */
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL must be a postgres:// or postgresql:// URL')
    .optional(),

  /** Public URL of the app, e.g. https://claudia.example.com. */
  CLAUDIA_PUBLIC_URL: z.url().optional(),
  /** Separate origin that serves MCP-UI, artifacts and file previews. */
  CLAUDIA_SANDBOX_ORIGIN: z.url().optional(),
  /** Root secret; HKDF derives the JWT and encryption keys from it. */
  CLAUDIA_SECRET_KEY: z.string().min(32, 'CLAUDIA_SECRET_KEY must be at least 32 characters').optional(),
  /** Earlier root secrets, comma-separated, still accepted for decryption while rotating. */
  CLAUDIA_SECRET_KEY_PREVIOUS: z.string().optional(),
  /** Local email + password login. Off for directory-only installs. */
  ENABLE_PASSWORD_AUTH: bool.default(true),
  /**
   * Single-host trials: serve the sandbox pages on this port of the same host
   * (a different port is a different origin). Ignored when
   * CLAUDIA_SANDBOX_ORIGIN points elsewhere.
   */
  CLAUDIA_SANDBOX_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  /** stdio MCP servers run commands on the host; admins only, and only when this is on. */
  CLAUDIA_ALLOW_STDIO_MCP: bool.default(false),
  CLAUDIA_ADMIN_EMAIL: z.email().optional(),
  CLAUDIA_ADMIN_PASSWORD: z.string().min(8).optional(),
  /** Built client to serve. Defaults to dist/client next to the server bundle. */
  CLAUDIA_CLIENT_DIR: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig extends Env {
  isProduction: boolean;
  /** DATA_DIR as an absolute path. */
  dataDir: string;
  /** Session cookies get `Secure` (served over HTTPS). */
  secureCookies: boolean;
  previousSecretKeys: string[];
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Treat empty strings as unset, as docker compose passes them for blank variables
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`));
  }
  const cfg = parsed.data;
  return {
    ...cfg,
    isProduction: cfg.NODE_ENV === 'production',
    dataDir: path.resolve(cfg.DATA_DIR),
    secureCookies: cfg.CLAUDIA_PUBLIC_URL?.startsWith('https://') ?? false,
    previousSecretKeys: (cfg.CLAUDIA_SECRET_KEY_PREVIOUS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

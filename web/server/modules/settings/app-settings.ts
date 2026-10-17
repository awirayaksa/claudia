/**
 * Admin-editable settings in `app_config`, typed and validated. Values given
 * by environment variables win and are reported as locked.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../../db/client';
import { appConfig } from '../../db/schema';
import { DEFAULT_PERMISSIONS, DefaultCapsSchema, PermissionsSchema } from '../../../shared/access';

export const AppSettingsSchema = {
  'auth.signup': z.object({
    enabled: z.boolean(),
    /** Role of new local accounts. */
    defaultRole: z.enum(['pending', 'user']),
  }),
  /** Model keys each role may use; null = every model. Admins always see all. */
  'models.allowlist': z.object({
    user: z.array(z.string()).nullable(),
  }),
  'models.default': z.object({ model: z.string().nullable() }),
  limits: z.object({
    /** Chat completions per user per minute. */
    completionsPerMinute: z.number().int().min(1).max(10_000),
    /** Runs a user may have going at once. */
    concurrentRuns: z.number().int().min(1).max(100),
    /** Tool-loop iterations per reply. */
    maxToolIterations: z.number().int().min(1).max(50),
  }),
  tasks: z.object({
    generateTitles: z.boolean(),
    /** Three suggested next questions under each reply. */
    generateFollowUps: z.boolean(),
    /** Model for titles and other background tasks; null = the chat's model. */
    titleModel: z.string().nullable(),
  }),
  /** Built-in tool servers users may switch on. */
  'mcp.builtins': z.object({ enabled: z.array(z.string()) }),
  /**
   * Hosts (exact or "*.example.com") and CIDRs that user-controlled URLs may
   * reach although they are private (e.g. an internal wiki for the fetch tool).
   */
  'net.allowlist': z.object({ hosts: z.array(z.string().trim().min(1).max(253)) }),
  /** What every approved user may do; groups add to it, admins have everything. */
  'permissions.default': PermissionsSchema,
  /** Token and cost caps for everyone (null = no limit); groups can raise them. */
  'caps.default': DefaultCapsSchema,
} as const;

export type AppSettingKey = keyof typeof AppSettingsSchema;
export type AppSettingValue<K extends AppSettingKey> = z.infer<(typeof AppSettingsSchema)[K]>;

export const APP_SETTING_DEFAULTS: { [K in AppSettingKey]: AppSettingValue<K> } = {
  'auth.signup': { enabled: true, defaultRole: 'pending' },
  'models.allowlist': { user: null },
  'models.default': { model: null },
  limits: { completionsPerMinute: 30, concurrentRuns: 3, maxToolIterations: 10 },
  tasks: { generateTitles: true, generateFollowUps: true, titleModel: null },
  'mcp.builtins': {
    enabled: ['builtin-filesystem-001', 'builtin-msoffice-001', 'builtin-diagram-001', 'builtin-fetch-001'],
  },
  'net.allowlist': { hosts: [] },
  'permissions.default': DEFAULT_PERMISSIONS,
  'caps.default': { tokensPerDay: null, tokensPerMonth: null, costPerDay: null, costPerMonth: null },
};

export class AppSettings {
  private cache = new Map<AppSettingKey, unknown>();

  constructor(private readonly db: Database) {}

  async get<K extends AppSettingKey>(key: K): Promise<AppSettingValue<K>> {
    if (this.cache.has(key)) return this.cache.get(key) as AppSettingValue<K>;
    const [row] = await this.db.select().from(appConfig).where(eq(appConfig.key, key));
    // Stored values are merged over defaults, so new fields get sensible values
    const parsed = AppSettingsSchema[key].safeParse({ ...APP_SETTING_DEFAULTS[key], ...(row?.value as object) });
    const value = (parsed.success ? parsed.data : APP_SETTING_DEFAULTS[key]) as AppSettingValue<K>;
    this.cache.set(key, value);
    return value;
  }

  /** The last known value without waiting (defaults until first loaded); refreshes in the background. */
  peek<K extends AppSettingKey>(key: K): AppSettingValue<K> {
    if (!this.cache.has(key)) void this.get(key).catch(() => {});
    return (this.cache.get(key) as AppSettingValue<K> | undefined) ?? APP_SETTING_DEFAULTS[key];
  }

  async set<K extends AppSettingKey>(key: K, value: unknown): Promise<AppSettingValue<K>> {
    const parsed = AppSettingsSchema[key].parse(value) as AppSettingValue<K>;
    await this.db
      .insert(appConfig)
      .values({ key, value: parsed })
      .onConflictDoUpdate({ target: appConfig.key, set: { value: parsed, updatedAt: new Date() } });
    this.cache.set(key, parsed);
    return parsed;
  }

  async all(): Promise<{ [K in AppSettingKey]: AppSettingValue<K> }> {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(AppSettingsSchema) as AppSettingKey[]) out[key] = await this.get(key);
    return out as { [K in AppSettingKey]: AppSettingValue<K> };
  }
}

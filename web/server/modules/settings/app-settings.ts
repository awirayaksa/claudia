/**
 * Admin-editable settings in `app_config`, typed and validated. Values given
 * by environment variables win and are reported as locked. Each instance
 * caches them; a change tells the other instances to read them again.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../../db/client';
import type { Cluster } from '../../cluster/cluster';
import { appConfig } from '../../db/schema';
import { DEFAULT_PERMISSIONS, DefaultCapsSchema, PermissionsSchema } from '../../../shared/access';
import { Banner } from '../../../shared/admin';
import { UserDefaultsSchema } from '../../../shared/settings';
import { AzdoServersSetting } from '../../../shared/azdo';

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
  /** Azure DevOps Server / TFS collections users may connect to (their hosts are reachable although private). */
  'azdo.servers': AzdoServersSetting,
  /** What every approved user may do; groups add to it, admins have everything. */
  'permissions.default': PermissionsSchema,
  /** Token and cost caps for everyone (null = no limit); groups can raise them. */
  'caps.default': DefaultCapsSchema,
  /** Notices at the top of every signed-in page. */
  'ui.banners': z.object({ items: z.array(Banner).max(20) }),
  /** Appearance and preferences a user has until they change them. */
  'users.defaults': UserDefaultsSchema,
  audit: z.object({ retentionDays: z.number().int().min(1).max(3650) }),
  /** Who must use two-factor sign-in. */
  'auth.mfa': z.object({ require: z.enum(['off', 'admins', 'everyone']) }),
  /** Blind comparisons: a model called "Arena" answers with two of these, unnamed until the user votes. */
  arena: z.object({ enabled: z.boolean(), models: z.array(z.string()).max(50) }),
  /** Near the context limit, summarize the oldest turns instead of dropping them. */
  compaction: z.object({
    enabled: z.boolean(),
    /** Share of the model's usable context that starts a compaction. */
    threshold: z.number().min(0.3).max(0.95),
    /** Most recent turns always sent word for word. */
    keepRecentTurns: z.number().int().min(1).max(20),
    /** Model that writes the summaries; null = the chat's model. */
    model: z.string().nullable(),
  }),
  /** Where the code interpreter runs: the user's browser (Pyodide), a Docker sandbox on the server, or nowhere. */
  code: z.object({
    engine: z.enum(['browser', 'server', 'off']),
    pythonImage: z.string().trim().min(1).max(300),
    nodeImage: z.string().trim().min(1).max(300),
    memoryMb: z.number().int().min(64).max(16_384),
    cpus: z.number().min(0.1).max(16),
    timeoutSeconds: z.number().int().min(5).max(3600),
    /** Let runs reach the network (off: no network at all). */
    network: z.boolean(),
    /** A container runtime such as runsc (gVisor); null = Docker's default. */
    runtime: z.string().trim().max(100).nullable(),
  }),
  /** How memories are learned (users can still switch learning off for themselves). */
  memory: z.object({
    /** Offer the model tools to save, change and forget memories during a chat. */
    tools: z.boolean(),
    /** Once a chat goes quiet, a model reads it for lasting facts. */
    extraction: z.boolean(),
    /** Model for learning and for sorting imports; null = the task model, else the chat's model. */
    model: z.string().nullable(),
  }),
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
    enabled: [
      'builtin-filesystem-001',
      'builtin-msoffice-001',
      'builtin-spreadsheet-001',
      'builtin-presentation-001',
      'builtin-pdf-001',
      'builtin-diagram-001',
      'builtin-fetch-001',
    ],
  },
  'net.allowlist': { hosts: [] },
  'azdo.servers': { servers: [] },
  'permissions.default': DEFAULT_PERMISSIONS,
  'caps.default': { tokensPerDay: null, tokensPerMonth: null, costPerDay: null, costPerMonth: null },
  'ui.banners': { items: [] },
  'users.defaults': { appearance: {}, preferences: {} },
  audit: { retentionDays: 365 },
  'auth.mfa': { require: 'off' },
  arena: { enabled: false, models: [] },
  compaction: { enabled: true, threshold: 0.8, keepRecentTurns: 4, model: null },
  code: {
    engine: 'browser',
    pythonImage: 'python:3.12-slim',
    nodeImage: 'node:22-slim',
    memoryMb: 512,
    cpus: 1,
    timeoutSeconds: 60,
    network: false,
    runtime: null,
  },
  // Tools are off by default: not every model takes tools, and a tool the provider refuses fails the reply
  memory: { tools: false, extraction: true, model: null },
};

export class AppSettings {
  private cache = new Map<AppSettingKey, unknown>();

  constructor(
    private readonly db: Database,
    private readonly cluster?: Cluster
  ) {
    cluster?.on('settings', ({ key }) => {
      this.cache.delete(key as AppSettingKey);
    });
  }

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
    this.cluster?.signal('settings', { key });
    return parsed;
  }

  async all(): Promise<{ [K in AppSettingKey]: AppSettingValue<K> }> {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(AppSettingsSchema) as AppSettingKey[]) out[key] = await this.get(key);
    return out as { [K in AppSettingKey]: AppSettingValue<K> };
  }
}

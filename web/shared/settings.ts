import { z } from 'zod';
import { DefaultCapsSchema, PermissionsSchema } from './access';
import { Banner } from './admin';

/**
 * Per-user settings: the desktop `settings` slice's appearance and
 * preferences (the API section is server-managed on the web).
 */
export const UserSettingsSchema = z.object({
  appearance: z
    .object({
      theme: z.enum(['light', 'dark', 'system']).optional(),
      fontSize: z.enum(['small', 'medium', 'large']).optional(),
      sidebarWidth: z.number().int().min(160).max(600).optional(),
      customization: z
        .object({
          accentColor: z.string().max(32).optional(),
          appTitle: z.string().max(100).optional(),
        })
        .partial()
        .optional(),
    })
    .partial(),
  preferences: z
    .object({
      temperature: z.number().min(0).max(2),
      maxTokens: z.number().int().min(1).max(1_000_000),
      showReasoning: z.boolean(),
      showStatistics: z.boolean(),
      visualExplanations: z.boolean(),
      systemPrompt: z.string().max(100_000),
      systemPromptFileName: z.string().max(255),
      reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).nullable(),
      streamingEnabled: z.boolean(),
    })
    .partial(),
  defaultModel: z.string().max(500).optional(),
  memory: z
    .object({
      /** Memories are added to chats (default on). */
      enabled: z.boolean(),
      /** The model may save memories during chats and learn them afterwards (default on). */
      learn: z.boolean(),
      /** Health, finances and similar topics may be saved too (default off). */
      sensitive: z.boolean(),
    })
    .partial()
    .optional(),
  /** The web app's language ("ar"); null follows the browser. */
  language: z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/)
    .nullable()
    .optional(),
});
export type UserSettingsInput = z.infer<typeof UserSettingsSchema>;

/** Admin defaults: what a user's appearance and preferences are until they change them. */
export const UserDefaultsSchema = z.object({
  appearance: UserSettingsSchema.shape.appearance,
  preferences: UserSettingsSchema.shape.preferences,
});
export type UserDefaults = z.infer<typeof UserDefaultsSchema>;

/** The user's own settings over the admin defaults (section by section, field by field). */
export function withDefaults<T extends { appearance?: object; preferences?: object }>(own: T, defaults: UserDefaults): T {
  return {
    ...own,
    appearance: { ...defaults.appearance, ...own.appearance },
    preferences: { ...defaults.preferences, ...own.preferences },
  };
}

export const AppSettingsResponse = z.object({
  'auth.signup': z.object({ enabled: z.boolean(), defaultRole: z.enum(['pending', 'user']) }),
  'models.allowlist': z.object({ user: z.array(z.string()).nullable() }),
  'models.default': z.object({ model: z.string().nullable() }),
  limits: z.object({
    completionsPerMinute: z.number(),
    concurrentRuns: z.number(),
    maxToolIterations: z.number(),
  }),
  tasks: z.object({ generateTitles: z.boolean(), generateFollowUps: z.boolean(), titleModel: z.string().nullable() }),
  'mcp.builtins': z.object({ enabled: z.array(z.string()) }),
  'net.allowlist': z.object({ hosts: z.array(z.string()) }),
  'permissions.default': PermissionsSchema,
  'caps.default': DefaultCapsSchema,
  'ui.banners': z.object({ items: z.array(Banner) }),
  'users.defaults': UserDefaultsSchema,
  audit: z.object({ retentionDays: z.number() }),
  'auth.mfa': z.object({ require: z.enum(['off', 'admins', 'everyone']) }),
  arena: z.object({ enabled: z.boolean(), models: z.array(z.string()) }),
  compaction: z.object({ enabled: z.boolean(), threshold: z.number(), keepRecentTurns: z.number(), model: z.string().nullable() }),
  memory: z.object({ tools: z.boolean(), extraction: z.boolean(), model: z.string().nullable() }),
});
export type AppSettingsResponse = z.infer<typeof AppSettingsResponse>;

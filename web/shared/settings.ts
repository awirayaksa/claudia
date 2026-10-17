import { z } from 'zod';

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
      systemPrompt: z.string().max(100_000),
      systemPromptFileName: z.string().max(255),
      reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).nullable(),
      streamingEnabled: z.boolean(),
    })
    .partial(),
  defaultModel: z.string().max(500).optional(),
});
export type UserSettingsInput = z.infer<typeof UserSettingsSchema>;

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
  'connections.user': z.object({ enabled: z.boolean() }),
});
export type AppSettingsResponse = z.infer<typeof AppSettingsResponse>;

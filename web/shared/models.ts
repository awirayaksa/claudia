import { z } from 'zod';

export const ConnectionType = z.enum(['openai', 'openrouter', 'openwebui', 'opencode-go']);
export type ConnectionType = z.infer<typeof ConnectionType>;

/** A model users can pick: `<connection prefix>/<model id at the provider>`. */
export const ModelInfo = z.object({
  id: z.string(),
  name: z.string(),
  connectionId: z.string(),
  connectionName: z.string(),
  contextLength: z.number().nullable(),
  /** From one of the user's own connections (id starts with "@"). */
  own: z.boolean().optional(),
  /** A custom model from the workspace (id "custom/<uuid>"). */
  custom: z.boolean().optional(),
  description: z.string().optional(),
  /** Starter prompts of a custom model. */
  suggestions: z.array(z.string()).optional(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

export const ModelsResponse = z.object({
  models: z.array(ModelInfo),
  defaultModel: z.string().nullable(),
});
export type ModelsResponse = z.infer<typeof ModelsResponse>;

export const ConnectionQuirks = z
  .object({
    toolsFirstTurnOnly: z.boolean(),
    apiCompatibility: z.enum(['openai', 'anthropic']),
    siteUrl: z.string().max(500),
    siteName: z.string().max(200),
  })
  .partial();

const prefix = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Use lowercase letters, digits, - and _')
  .refine((p) => p !== 'custom', '"custom" is reserved for custom models');

export const ConnectionInput = z.object({
  name: z.string().trim().min(1).max(100),
  prefix,
  type: ConnectionType,
  baseUrl: z.string().trim().max(500).default(''),
  /** Omitted on update = keep the stored key; empty string = remove it. */
  apiKey: z.string().max(10_000).optional(),
  quirks: ConnectionQuirks.default({}),
  modelFilter: z.array(z.string().trim().min(1)).nullable().default(null),
  enabled: z.boolean().default(true),
});
export type ConnectionInput = z.infer<typeof ConnectionInput>;

/** A connection as the API shows it: never the key, only whether there is one. */
export const ConnectionView = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  type: ConnectionType,
  baseUrl: z.string(),
  hasKey: z.boolean(),
  keyLast4: z.string().nullable(),
  quirks: ConnectionQuirks,
  modelFilter: z.array(z.string()).nullable(),
  enabled: z.boolean(),
  /** Models it offered at the last refresh, and the error if listing failed. */
  modelCount: z.number(),
  error: z.string().nullable(),
});
export type ConnectionView = z.infer<typeof ConnectionView>;

export interface UserConnectionsResponse {
  /** Whether the administrator lets users add connections. */
  enabled: boolean;
  connections: ConnectionView[];
}

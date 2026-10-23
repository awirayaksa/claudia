import { z } from 'zod';
import type { GrantView, ItemAccess } from './access';
import { McpOAuthInput, type McpOAuthView } from './mcp';

// ─── Custom models (model builder) ───────────────────────────────────────────

/** Model keys of custom models: "custom/<uuid>". Connections can't use this prefix. */
export const CUSTOM_MODEL_PREFIX = 'custom';
export const customModelKey = (id: string) => `${CUSTOM_MODEL_PREFIX}/${id}`;

export const CustomModelParams = z
  .object({
    temperature: z.number().min(0).max(2),
    topP: z.number().min(0).max(1),
    maxTokens: z.number().int().min(1).max(1_000_000),
    frequencyPenalty: z.number().min(-2).max(2),
    presencePenalty: z.number().min(-2).max(2),
    effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']),
  })
  .partial();
export type CustomModelParams = z.infer<typeof CustomModelParams>;

export const CustomModelInput = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(1000).default(''),
  /** The model it runs on (a key from /api/models; not another custom model). */
  baseModelId: z.string().trim().min(1).max(500),
  systemPrompt: z.string().max(100_000).default(''),
  params: CustomModelParams.default({}),
  /** Tool servers switched on whenever this model answers. */
  toolIds: z.array(z.string().min(1).max(100)).max(50).default([]),
  /** Knowledge bases searched whenever it answers (with the owner's access). */
  knowledgeIds: z.array(z.uuid()).max(20).default([]),
  /** Starter prompts on an empty chat. */
  suggestions: z.array(z.string().trim().min(1).max(500)).max(8).default([]),
  active: z.boolean().default(true),
});
export type CustomModelInput = z.infer<typeof CustomModelInput>;

export interface CustomModelView extends CustomModelInput {
  id: string;
  /** The key chats and the API use. */
  key: string;
  ownerId: string;
  ownerName: string;
  access: ItemAccess;
  updatedAt: string;
}

// ─── Prompt library ──────────────────────────────────────────────────────────

const command = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, digits and -');

export const PromptInput = z.object({
  command,
  title: z.string().trim().min(1).max(100),
  description: z.string().max(500).default(''),
  /** Text put into the message box; {{name}} and {{name:default}} are asked for first. */
  body: z.string().min(1).max(100_000),
});
export type PromptInput = z.infer<typeof PromptInput>;

export interface PromptView extends PromptInput {
  id: string;
  ownerId: string;
  ownerName: string;
  variables: Array<{ name: string; default: string }>;
  access: ItemAccess;
  updatedAt: string;
}

/** Workspace items come with who else can use them (for owners and admins). */
export interface WithGrants {
  grants: GrantView[];
}

// ─── Memory ──────────────────────────────────────────────────────────────────

export const MAX_MEMORIES = 200;
export const MAX_MEMORY_CHARS = 1000;

/** What a memory is about; the Memory settings group them by topic. */
export const MEMORY_TOPICS = ['about', 'work', 'preferences', 'projects', 'people', 'other'] as const;
export type MemoryTopic = (typeof MEMORY_TOPICS)[number];
/** user: typed in settings; model: saved by the model during a chat; auto: learned after a chat; import: from another assistant. */
export type MemorySource = 'user' | 'model' | 'auto' | 'import';

export const MemoryInput = z.object({
  content: z.string().trim().min(1).max(MAX_MEMORY_CHARS),
  topic: z.enum(MEMORY_TOPICS).optional(),
  /** Only for chats in this folder; null (or unset) for every chat. */
  folderId: z.uuid().nullable().optional(),
});

export interface MemoryView {
  id: string;
  content: string;
  topic: MemoryTopic;
  source: MemorySource;
  folderId: string | null;
  chatId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Another assistant's memory export (pasted text, a list or JSON), at most 100 kB. */
export const MemoryImportInput = z.object({ text: z.string().trim().min(1).max(100_000) });

/** A change the model made to memories, shown as a chip under its reply. */
export interface MemoryChangeView {
  id: string;
  action: 'add' | 'update' | 'delete';
  memoryId: string;
  topic: MemoryTopic;
  /** The text after the change (before it, for a deletion). */
  content: string;
  undone: boolean;
}

// ─── API keys ────────────────────────────────────────────────────────────────

export const ApiKeyInput = z.object({
  name: z.string().trim().min(1).max(100),
  /** Days until it stops working; null = never. */
  expiresInDays: z.number().int().min(1).max(3650).nullable().default(null),
});

export interface ApiKeyView {
  id: string;
  name: string;
  /** The first characters, to recognise it. */
  prefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export interface CreatedApiKey {
  key: ApiKeyView;
  /** Shown once; only its hash is stored. */
  secret: string;
}

// ─── User-owned tool servers ─────────────────────────────────────────────────

export const UserMcpServerInput = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).nullable().default(null),
  transport: z.enum(['streamable-http', 'sse']),
  url: z.url().refine((u) => /^https?:\/\//i.test(u), 'Use an http(s) URL'),
  /** Omitted on update = keep the stored ones. */
  headers: z.record(z.string().min(1).max(200), z.string().max(10_000)).optional(),
  /** Sign in with OAuth; null = no OAuth. */
  oauth: McpOAuthInput.nullable().optional(),
  enabled: z.boolean().default(true),
});
export type UserMcpServerInput = z.infer<typeof UserMcpServerInput>;

export interface UserMcpServerView {
  id: string;
  name: string;
  description: string | null;
  transport: 'streamable-http' | 'sse';
  url: string;
  headerNames: string[];
  oauth: McpOAuthView | null;
  enabled: boolean;
}

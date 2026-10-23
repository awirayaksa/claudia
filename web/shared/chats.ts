import { z } from 'zod';
import { MessageRef } from './knowledge';
import type { MessageNode } from '../../src/types/turn.types';

export const ChatSummary = z.object({
  id: z.string(),
  title: z.string(),
  folderId: z.string().nullable(),
  modelIds: z.array(z.string()),
  pinned: z.boolean(),
  archived: z.boolean(),
  temporary: z.boolean(),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChatSummary = z.infer<typeof ChatSummary> & {
  /** Search results: where the text matched (absent for title matches). */
  match?: { messageId: string; snippet: string };
};

/** In search snippets, matched words sit between these two characters. */
export const SNIPPET_MARK_START = '\u0002';
export const SNIPPET_MARK_END = '\u0003';

/** Request parameters per chat; null clears one (back to the user's preference). */
export const ChatParamsSchema = z.object({
  temperature: z.number().min(0).max(2).nullable(),
  topP: z.number().min(0).max(1).nullable(),
  maxTokens: z.number().int().min(1).max(1_000_000).nullable(),
  frequencyPenalty: z.number().min(-2).max(2).nullable(),
  presencePenalty: z.number().min(-2).max(2).nullable(),
  systemPrompt: z.string().max(100_000).nullable(),
});
export type ChatParams = { [K in keyof z.infer<typeof ChatParamsSchema>]?: Exclude<z.infer<typeof ChatParamsSchema>[K], null> };

export interface ChatDetail extends ChatSummary {
  currentLeafId: string | null;
  params: ChatParams;
  /** Every node of the chat; the visible path ends at currentLeafId. */
  messages: MessageNode[];
  /** Runs still going (another tab, or a reload mid-reply), to resume. */
  activeRuns: Array<{ runId: string; lastSeq: number }>;
  /** The chat's share link, if it has one. */
  share: ShareView | null;
}

export const TAG = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(32)
  .regex(/^[^\s,]+$/u, 'Tags have no spaces or commas.');

export const ChatListQuery = z.object({
  search: z.string().trim().max(200).optional(),
  folderId: z.uuid().optional(),
  tag: TAG.optional(),
  // "false" must stay false (z.coerce.boolean would make it true)
  archived: z.preprocess((v) => v === true || v === 'true', z.boolean()).default(false),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

export const CreateChatRequest = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  folderId: z.uuid().nullable().optional(),
  modelIds: z.array(z.string()).max(4).optional(),
  temporary: z.boolean().optional(),
});

export const UpdateChatRequest = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  folderId: z.uuid().nullable().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  /** Only false: a temporary chat can be kept, not the other way round. */
  temporary: z.literal(false).optional(),
  tags: z.array(TAG).max(20).optional(),
  currentLeafId: z.uuid().optional(),
  modelIds: z.array(z.string()).min(1).max(4).optional(),
  params: ChatParamsSchema.partial().optional(),
});

export const CompletionRequest = z.object({
  /**
   * The node the new user turn follows; null starts the chat (or, for an
   * edited first message, adds a sibling of it). With `regenerate`, the user
   * node to answer again.
   */
  parentId: z.uuid().nullable(),
  content: z.string().max(500_000).default(''),
  fileIds: z.array(z.uuid()).max(20).default([]),
  /** Each model answers as a sibling assistant node; more than one are shown side by side. */
  modelIds: z.array(z.string().min(1)).min(1).max(4),
  /** Answer the user node `parentId` again (new sibling replies); content and files are ignored. */
  regenerate: z.boolean().default(false),
  /** Carry on this reply, cut off at the output limit, in the same message (by the model that wrote it). */
  continueId: z.uuid().optional(),
  params: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).nullable().optional(),
    })
    .default({}),
  toolIds: z.array(z.string()).default([]),
  /** A `/skill args` invocation; content holds what the user sees. */
  skill: z.object({ id: z.string().min(1).max(64), args: z.string().max(100_000).default('') }).optional(),
  /** webSearch: search the web for this message. */
  features: z.record(z.string(), z.boolean()).default({}),
  /** #kb, #url and #chat references. */
  refs: z.array(MessageRef).max(10).default([]),
});
export type CompletionRequest = z.infer<typeof CompletionRequest>;

export interface CompletionResponse {
  runId: string;
  /** The new user node (or, when regenerating, the one answered again). */
  userMessageId: string;
  assistantMessageIds: string[];
}

export const FeedbackRequest = z.object({
  rating: z.union([z.literal(1), z.literal(-1), z.null()]),
  comment: z.string().trim().max(2000).optional(),
  reasons: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
});

export const ForkRequest = z.object({
  /** The fork copies the path from the first message down to this one. */
  messageId: z.uuid(),
});

export const Folder = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  systemPrompt: z.string().nullable(),
  /** Knowledge bases searched for every chat in it. */
  knowledgeIds: z.array(z.string()),
  /** Yours; else it (or a folder above it) was shared with you by `ownerName`. */
  mine: z.boolean(),
  ownerName: z.string().nullable(),
  /** You may change its name, instructions and knowledge. */
  canEdit: z.boolean(),
  /** You may share, move and delete it (the owner). */
  canManage: z.boolean(),
  /** Yours, and shared with someone. */
  shared: z.boolean(),
  createdAt: z.string(),
});
export type Folder = z.infer<typeof Folder>;

export const FolderInput = z.object({
  name: z.string().trim().min(1).max(100),
  parentId: z.uuid().nullable().optional(),
  systemPrompt: z.string().max(100_000).nullable().optional(),
  knowledgeIds: z.array(z.uuid()).max(20).optional(),
});

export const LlmCompleteRequest = z.object({
  model: z.string().min(1),
  messages: z
    .array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string().max(200_000) }))
    .min(1)
    .max(50),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(8192).optional(),
});

// ─── Share links ──────────────────────────────────────────────────────────

export interface ShareView {
  token: string;
  title: string;
  /** When the snapshot was taken. */
  updatedAt: string;
  createdAt: string;
}

export interface ShareListItem extends ShareView {
  chatId: string;
}

/** What anyone with the link sees (no ids of the owner's other data). */
export interface SharedChat {
  title: string;
  sharedBy: string;
  sharedAt: string;
  messages: MessageNode[];
}

// ─── Export and import ────────────────────────────────────────────────────

export const EXPORT_FORMAT = 'claudia-web';
export const EXPORT_VERSION = 1;

const UIResourceSchema = z.object({
  uri: z.string().max(2000),
  mimeType: z.string().max(100),
  text: z.string().max(2_000_000).optional(),
  blob: z.string().max(5_000_000).optional(),
});

const LONG_TEXT = z.string().max(1_000_000);

export const MessagePartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: LONG_TEXT }),
  z.object({ type: z.literal('reasoning'), text: LONG_TEXT }),
  z.object({
    type: z.literal('file'),
    fileId: z.string().max(100),
    name: z.string().max(500),
    mime: z.string().max(200),
    size: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal('tool_call'),
    callId: z.string().max(200),
    alias: z.string().max(200),
    serverId: z.string().max(200),
    tool: z.string().max(200),
    args: LONG_TEXT,
  }),
  z.object({
    type: z.literal('tool_result'),
    callId: z.string().max(200),
    content: LONG_TEXT,
    isError: z.boolean().optional(),
    uiResource: UIResourceSchema.optional(),
  }),
  z.object({
    type: z.literal('citation'),
    index: z.number().int().min(0),
    source: z.object({
      kind: z.enum(['file', 'url', 'chat', 'note']),
      id: z.string().max(200).optional(),
      title: z.string().max(1000),
      url: z.string().max(4000).optional(),
      snippet: z.string().max(10_000).optional(),
      page: z.number().int().optional(),
      section: z.string().max(1000).optional(),
    }),
  }),
  z.object({
    type: z.literal('workspace_file'),
    path: z.string().max(4000),
    size: z.number().int().min(0).optional(),
  }),
]);

const USAGE = z
  .object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
    cost: z.number().optional(),
  })
  .loose();

export const ExportedMessageSchema = z.object({
  id: z.string().min(1).max(200),
  parentId: z.string().max(200).nullable(),
  role: z.enum(['user', 'assistant', 'system']),
  parts: z.array(MessagePartSchema).max(2000),
  modelId: z.string().max(500).optional(),
  usage: USAGE.optional(),
  effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
  status: z.enum(['streaming', 'completed', 'stopped', 'error']).default('completed'),
  error: z.string().max(10_000).optional(),
  rating: z.union([z.literal(1), z.literal(-1)]).optional(),
  models: z.array(z.string().max(500)).max(4).optional(),
  createdAt: z.string().max(40),
});
export type ExportedMessage = z.infer<typeof ExportedMessageSchema>;

export const ExportedChatSchema = z.object({
  title: z.string().trim().min(1).max(200).catch('Imported chat'),
  createdAt: z.string().max(40),
  updatedAt: z.string().max(40),
  modelIds: z.array(z.string().max(500)).max(4).default([]),
  params: ChatParamsSchema.partial().default({}),
  tags: z.array(TAG).max(20).default([]),
  pinned: z.boolean().default(false),
  archived: z.boolean().default(false),
  /** Folder names from the top: ["Work", "Reports"]. */
  folder: z.array(z.string().trim().min(1).max(100)).max(10).nullable().default(null),
  currentLeafId: z.string().max(200).nullable(),
  messages: z.array(ExportedMessageSchema).max(10_000),
});
export type ExportedChat = z.infer<typeof ExportedChatSchema>;

export interface ClaudiaExport {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  chats: ExportedChat[];
}

export const ImportRequest = z.object({
  chats: z.array(ExportedChatSchema).min(1).max(200),
});

export interface ImportResponse {
  imported: number;
  chatIds: string[];
  /** Messages left out because they were broken (e.g. a parent that isn't in the chat). */
  skippedMessages: number;
}

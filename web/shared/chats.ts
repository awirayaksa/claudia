import { z } from 'zod';
import type { MessageNode } from '../../src/types/turn.types';

export const ChatSummary = z.object({
  id: z.string(),
  title: z.string(),
  folderId: z.string().nullable(),
  modelIds: z.array(z.string()),
  pinned: z.boolean(),
  archived: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChatSummary = z.infer<typeof ChatSummary>;

export interface ChatDetail extends ChatSummary {
  currentLeafId: string | null;
  params: { temperature?: number; systemPrompt?: string };
  /** Every node of the chat; the visible path ends at currentLeafId. */
  messages: MessageNode[];
  /** Runs still going (another tab, or a reload mid-reply), to resume. */
  activeRuns: Array<{ runId: string; lastSeq: number }>;
}

export const ChatListQuery = z.object({
  search: z.string().trim().max(200).optional(),
  folderId: z.uuid().optional(),
  archived: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

export const CreateChatRequest = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  folderId: z.uuid().nullable().optional(),
  modelIds: z.array(z.string()).max(4).optional(),
});

export const UpdateChatRequest = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  folderId: z.uuid().nullable().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  currentLeafId: z.uuid().optional(),
  modelIds: z.array(z.string()).min(1).max(4).optional(),
  params: z
    .object({ temperature: z.number().min(0).max(2).optional(), systemPrompt: z.string().max(100_000).optional() })
    .optional(),
});

export const CompletionRequest = z.object({
  /** The node the new user turn follows; null starts the chat. */
  parentId: z.uuid().nullable(),
  content: z.string().max(500_000),
  fileIds: z.array(z.uuid()).max(20).default([]),
  /** Each model answers as a sibling assistant node (Phase 2 shows them side by side). */
  modelIds: z.array(z.string().min(1)).min(1).max(4),
  params: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).nullable().optional(),
    })
    .default({}),
  toolIds: z.array(z.string()).default([]),
  features: z.record(z.string(), z.boolean()).default({}),
});
export type CompletionRequest = z.infer<typeof CompletionRequest>;

export interface CompletionResponse {
  runId: string;
  userMessageId: string;
  assistantMessageIds: string[];
}

export const Folder = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  systemPrompt: z.string().nullable(),
  createdAt: z.string(),
});
export type Folder = z.infer<typeof Folder>;

export const FolderInput = z.object({
  name: z.string().trim().min(1).max(100),
  parentId: z.uuid().nullable().optional(),
  systemPrompt: z.string().max(100_000).nullable().optional(),
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

import { z } from 'zod';
import type { ItemAccess } from './access';
import type { CitationSource } from '../../src/types/turn.types';

// ─── Knowledge bases ─────────────────────────────────────────────────────────

export const KnowledgeInput = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(1000).default(''),
  /** Chunk size and overlap in tokens; null = the admin defaults. */
  chunkSize: z.number().int().min(100).max(8000).nullable().default(null),
  chunkOverlap: z.number().int().min(0).max(2000).nullable().default(null),
  /** Send whole documents instead of the best passages (when they fit). */
  fullContext: z.boolean().default(false),
});
export type KnowledgeInput = z.infer<typeof KnowledgeInput>;

export type KbFileStatus = 'queued' | 'processing' | 'ready' | 'failed';

export interface KbFileView {
  fileId: string;
  name: string;
  mime: string;
  size: number;
  status: KbFileStatus;
  error: string | null;
  chunks: number;
  addedAt: string;
}

export interface KnowledgeView extends KnowledgeInput {
  id: string;
  ownerId: string;
  ownerName: string;
  /** "<engine>:<model>" the chunks are embedded with; null = keyword search only. */
  embedModel: string | null;
  fileCount: number;
  access: ItemAccess;
  updatedAt: string;
}

export interface KnowledgeDetail extends KnowledgeView {
  files: KbFileView[];
}

/** One hit of a knowledge search (the "try a query" box, and what chats get). */
export interface SearchHit {
  chunkId: string;
  fileId: string | null;
  title: string;
  text: string;
  page: number | null;
  heading: string | null;
  score: number;
}

/** Live progress over the WebSocket (topic "kb:<id>"). */
export interface KbFileEvent {
  type: 'kb.file';
  kbId: string;
  fileId: string;
  status: KbFileStatus;
  chunks: number;
  /** 0..1 while embedding. */
  progress: number;
  error: string | null;
}

// ─── References in a message (#kb, #url, #chat) ─────────────────────────────

export const MessageRef = z.discriminatedUnion('type', [
  z.object({ type: z.literal('kb'), id: z.uuid(), name: z.string().max(200).optional() }),
  z.object({ type: z.literal('url'), url: z.url().refine((u) => /^https?:\/\//i.test(u), 'Use an http(s) URL') }),
  z.object({ type: z.literal('chat'), id: z.uuid(), name: z.string().max(200).optional() }),
]);
export type MessageRef = z.infer<typeof MessageRef>;

export interface Citation {
  index: number;
  source: CitationSource;
}

// ─── Admin RAG settings ──────────────────────────────────────────────────────

export const EMBEDDING_ENGINES = ['none', 'openai', 'ollama', 'local'] as const;
export const RERANK_ENGINES = ['none', 'cohere', 'tei'] as const;
export const SEARCH_ENGINES = ['none', 'searxng', 'brave', 'tavily', 'google_pse', 'duckduckgo'] as const;

export const RagSettings = z.object({
  embedding: z.object({
    /** none: keyword search only; openai: any OpenAI-compatible /embeddings; ollama; local: transformers.js. */
    engine: z.enum(EMBEDDING_ENGINES),
    baseUrl: z.string().trim().max(500),
    model: z.string().trim().max(200),
    batchSize: z.number().int().min(1).max(512),
  }),
  chunkSize: z.number().int().min(100).max(8000),
  chunkOverlap: z.number().int().min(0).max(2000),
  /** Passages a message gets from knowledge. */
  topK: z.number().int().min(1).max(50),
  /** At most this many tokens of sources go with one message. */
  maxContextTokens: z.number().int().min(500).max(200_000),
  rerank: z.object({
    engine: z.enum(RERANK_ENGINES),
    baseUrl: z.string().trim().max(500),
    model: z.string().trim().max(200),
  }),
  webSearch: z.object({
    engine: z.enum(SEARCH_ENGINES),
    /** SearXNG instance URL. */
    baseUrl: z.string().trim().max(500),
    /** Google Programmable Search engine id. */
    cx: z.string().trim().max(200),
    resultCount: z.number().int().min(1).max(10),
    /** Read the result pages (else only the search snippets are used). */
    fetchPages: z.boolean(),
  }),
});
export type RagSettings = z.infer<typeof RagSettings>;

export const RagSettingsUpdate = RagSettings.partial().extend({
  /** Omitted = keep; '' = remove. */
  embeddingKey: z.string().max(10_000).optional(),
  rerankKey: z.string().max(10_000).optional(),
  searchKey: z.string().max(10_000).optional(),
});
export type RagSettingsUpdate = z.infer<typeof RagSettingsUpdate>;

export interface RagSettingsResponse {
  settings: RagSettings;
  hasEmbeddingKey: boolean;
  hasRerankKey: boolean;
  hasSearchKey: boolean;
  /** Whether the optional local embedding package is installed. */
  localAvailable: boolean;
}

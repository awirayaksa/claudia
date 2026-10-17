/**
 * Turn-based message model (Claudia Web).
 *
 * One node per turn: a tool-using assistant reply is a single node whose
 * parts are in the order they happened (reasoning, text, tool calls, tool
 * results, more text). `toOpenAIMessages` in services/chat/message-builder
 * expands it back into the flat OpenAI shape providers expect.
 */
import type { UIResourceContent } from './mcp.types';
import type { MessageUsage } from './statistics.types';
import type { ReasoningEffort } from '../utils/effort-utils';

/** Where a `[n]` citation points. */
export interface CitationSource {
  kind: 'file' | 'url' | 'chat';
  /** File id, chat id, ... */
  id?: string;
  title: string;
  url?: string;
  snippet?: string;
  page?: number;
}

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  /** User attachments, images included. */
  | { type: 'file'; fileId: string; name: string; mime: string; size?: number }
  /**
   * `alias` is the name the model saw and called; `serverId` + `tool` is where
   * it ran. Stored so history replays and UI actions resolve the same way.
   */
  | { type: 'tool_call'; callId: string; alias: string; serverId: string; tool: string; args: string }
  /** `content` is what the model sees; `uiResource` is rendered for the user. */
  | { type: 'tool_result'; callId: string; content: string; isError?: boolean; uiResource?: UIResourceContent }
  | { type: 'citation'; index: number; source: CitationSource };

export type MessagePartType = MessagePart['type'];
export type PartOf<T extends MessagePartType> = Extract<MessagePart, { type: T }>;

export type MessageStatus = 'streaming' | 'completed' | 'stopped' | 'error';

export interface MessageNode {
  id: string;
  chatId: string;
  /** null for the first message of a chat. Siblings (same parent) are alternatives. */
  parentId: string | null;
  role: 'user' | 'assistant' | 'system';
  parts: MessagePart[];
  modelId?: string;
  usage?: MessageUsage;
  effort?: ReasoningEffort;
  status: MessageStatus;
  /** Set when status is 'error'. */
  error?: string;
  rating?: 1 | -1;
  createdAt: string;
}

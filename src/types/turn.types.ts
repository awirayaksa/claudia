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
  kind: 'file' | 'url' | 'chat' | 'note';
  /** File id, chat id, ... */
  id?: string;
  title: string;
  url?: string;
  snippet?: string;
  page?: number;
  /** The heading the passage is under ("Handbook › Vacation"). */
  section?: string;
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
  | { type: 'citation'; index: number; source: CitationSource }
  /** A file a tool wrote in the user's workspace (web), by its path there ("reports/q3.md"). */
  | { type: 'workspace_file'; path: string; size?: number };

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
  /** What the user said along with the rating. */
  feedback?: { comment?: string; reasons?: string[] };
  /** User nodes: the models asked at once (more than one → answers side by side). */
  models?: string[];
  /** Assistant nodes: suggested next questions. */
  followUps?: string[];
  /** User turns: #kb / #url / #chat references, and whether the web was searched. */
  refs?: Array<{ type: 'kb' | 'url' | 'chat' | 'note'; id?: string; url?: string; name?: string }>;
  webSearch?: boolean;
  /**
   * User turns of a blind comparison (web): the vote, and the two models in
   * A/B order once voted (null before, when replies show as "arena:A"/"arena:B").
   */
  arena?: { winner: 'a' | 'b' | 'tie' | null; models: [string, string] | null };
  /**
   * Web: the turns up to and including this node were summarized to fit the
   * context window; later sends down this path use the summary instead.
   */
  compaction?: { summary: string; turns: number };
  createdAt: string;
}

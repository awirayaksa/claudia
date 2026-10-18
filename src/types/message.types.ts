// Message types for chat functionality
import { UIResourceContent } from './mcp.types';
import { MessageUsage } from './statistics.types';
import { ReasoningEffort } from '../utils/effort-utils';
import type { CitationSource } from './turn.types';

export interface Attachment {
  id: string;
  type: 'file' | 'image';
  name: string;
  size: number;
  mimeType: string;
  url?: string;
  localPath?: string;
  data?: string; // base64 data URI for inline embedding (e.g. images)
  /** Plain text extracted from a document; inlined into the message sent to the model. */
  extractedText?: string;
  /** True when extractedText was cut off at the size limit. */
  textTruncated?: boolean;
  /** Id of the file on the provider (Open WebUI), sent in the request's `files` field. */
  remoteFileId?: string;
}

// Tool calling types (OpenAI function calling format)
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ToolResult {
  tool_call_id: string;
  role: 'tool';
  name: string;
  content: string | UIResourceContent; // Primary content for LLM (text)
  isError?: boolean;
  hasUI?: boolean; // Track if this result contains UI
  uiResource?: UIResourceContent; // Separate UI resource for rendering
  serverId?: string; // MCP server that produced this result
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: string;
  attachments?: Attachment[];
  error?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  // For tool result messages
  tool_call_id?: string;
  name?: string;
  // Reasoning/thinking content
  reasoning?: string;
  // Usage statistics
  usage?: MessageUsage;
  // Reasoning effort this message was sent with (user messages only, so retries reuse it)
  effort?: ReasoningEffort;
  /** Numbered sources a reply cites as [n] (Claudia Web: knowledge, web pages, chats). */
  citations?: Array<{ index: number; source: CitationSource }>;
}

export interface ChatState {
  messages: Message[];
  currentMessageId: string | null;
  isLoading: boolean;
  error: string | null;
}

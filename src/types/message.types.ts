// Message types for chat functionality
import { UIResourceContent } from './mcp.types';

export interface Attachment {
  id: string;
  type: 'file' | 'image';
  name: string;
  size: number;
  mimeType: string;
  url?: string;
  localPath?: string;
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
}

export interface ChatState {
  messages: Message[];
  currentMessageId: string | null;
  isLoading: boolean;
  error: string | null;
}

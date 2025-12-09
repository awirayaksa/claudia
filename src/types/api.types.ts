// Open WebUI API Types
import { ToolCall } from './message.types';

// Provider Types
export type ProviderType = 'openwebui' | 'openrouter';

export interface ProviderCapabilities {
  supportsFileUpload: boolean;
  supportsToolCalling: boolean;
  supportsStreaming: boolean;
  requiresCustomHeaders: boolean;
}

// Provider-specific Configuration Types
export interface OpenWebUIConfig {
  baseUrl: string;
  apiKey: string;
  selectedModel: string;
}

export interface OpenRouterConfig {
  apiKey: string;
  selectedModel: string;
  siteUrl?: string;
  siteName?: string;
}

// Union type for all provider configs
export type ProviderConfig = OpenWebUIConfig | OpenRouterConfig;

// API Configuration with Provider Selection
export interface APIConfig {
  provider: ProviderType;
  openwebui?: OpenWebUIConfig;
  openrouter?: OpenRouterConfig;
  availableModels: string[];
}

export interface Model {
  id: string;
  name: string;
  object: string;
  created: number;
  owned_by: string;
}

export interface ModelsResponse {
  data: Model[];
  object: string;
}

// OpenAI Function Calling Types
export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: any; // JSON Schema
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string; // For tool role messages
  name?: string; // Tool name for tool role messages
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  tools?: OpenAITool[];
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      tool_calls?: ToolCall[];
    };
    finish_reason: string | null;
  }>;
}

export interface FileUploadResponse {
  id: string;
  filename: string;
  url: string;
}

export interface APIError {
  error: {
    message: string;
    type: string;
    code: string;
  };
}

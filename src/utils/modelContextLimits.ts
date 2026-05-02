import { Message } from '../types/message.types';
import { MessageUsage } from '../types/statistics.types';

interface ContextLimitEntry {
  pattern: RegExp;
  window: number;
}

// Ordered most-specific-first; matched against lowercased model id.
const STATIC_CONTEXT_LIMITS: ContextLimitEntry[] = [
  // Claude family
  { pattern: /^claude-3-5-/, window: 200_000 },
  { pattern: /^claude-3-7/, window: 200_000 },
  { pattern: /^claude-(opus|sonnet|haiku)-4/, window: 200_000 },
  { pattern: /^claude-3-/, window: 200_000 },

  // GPT-4 family
  { pattern: /^gpt-4o/, window: 128_000 },
  { pattern: /^gpt-4o-mini/, window: 128_000 },
  { pattern: /^gpt-4-turbo/, window: 128_000 },
  { pattern: /^o1-/, window: 128_000 },
  { pattern: /^gpt-4-32k/, window: 32_768 },
  { pattern: /^gpt-4/, window: 8_192 },

  // GPT-3.5 family
  { pattern: /^gpt-3\.5-turbo/, window: 16_385 },

  // Gemini family
  { pattern: /^gemini-1\.5-pro/, window: 2_000_000 },
  { pattern: /^gemini-1\.5-flash/, window: 1_000_000 },
  { pattern: /^gemini-2\.0/, window: 1_000_000 },
  { pattern: /^gemini-pro/, window: 32_768 },

  // DeepSeek family
  { pattern: /^deepseek-r1/, window: 65_536 },
  { pattern: /^deepseek-v3/, window: 65_536 },
  { pattern: /^deepseek-coder/, window: 16_384 },
  { pattern: /^deepseek/, window: 65_536 },

  // Qwen family
  { pattern: /^qwen2\.5$/, window: 131_072 },
  { pattern: /^qwen2\.5-coder/, window: 32_768 },
  { pattern: /^qwen-max/, window: 32_768 },
  { pattern: /^qwen/, window: 32_768 },

  // Llama family
  { pattern: /^llama-3\.1/, window: 128_000 },
  { pattern: /^llama-3\.2/, window: 128_000 },
  { pattern: /^llama-3\.3/, window: 128_000 },
  { pattern: /^llama-3/, window: 8_192 },
  { pattern: /^llama-2/, window: 4_096 },

  // Mistral / Mixtral family
  { pattern: /^mixtral-8x22b/, window: 65_536 },
  { pattern: /^mixtral/, window: 32_768 },
  { pattern: /^mistral-large/, window: 128_000 },
  { pattern: /^mistral/, window: 32_768 },
];

/**
 * Look up the context window for a model id.
 * Priority:
 * 1. Cached per-model lengths from OpenRouter (modelContextLengths)
 * 2. Static regex fallback map
 * 3. null if completely unknown
 */
export function getContextWindow(
  modelId: string | undefined,
  modelContextLengths?: Record<string, number>
): number | null {
  if (!modelId) return null;

  // 1. Check cached OpenRouter lengths
  if (modelContextLengths?.[modelId] != null) {
    return modelContextLengths[modelId];
  }

  // 2. Static fallback map
  const lower = modelId.toLowerCase();
  for (const entry of STATIC_CONTEXT_LIMITS) {
    if (entry.pattern.test(lower)) {
      return entry.window;
    }
  }

  return null;
}

interface CurrentContextTokens {
  used: number | null;
  promptTokens: number;
  completionTokens: number;
  cached: number;
}

/**
 * Compute the "current context used" tokens.
 *
 * Source of truth (in priority order):
 * 1. Mid-stream: streamingUsage.prompt_tokens + streamingUsage.completion_tokens
 * 2. Otherwise: walk messages backward, find most recent assistant message with usage,
 *    return usage.prompt_tokens + usage.completion_tokens
 * 3. No assistant response yet: return null for used
 */
export function getCurrentContextTokens(
  messages: Message[],
  streamingUsage: MessageUsage | null,
  isStreaming: boolean
): CurrentContextTokens {
  // 1. Mid-stream
  if (isStreaming && streamingUsage) {
    return {
      used: streamingUsage.prompt_tokens + streamingUsage.completion_tokens,
      promptTokens: streamingUsage.prompt_tokens,
      completionTokens: streamingUsage.completion_tokens,
      cached: streamingUsage.prompt_tokens_details?.cached_tokens ?? 0,
    };
  }

  // 2. Walk backward for most recent assistant message with usage
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.usage) {
      return {
        used: msg.usage.prompt_tokens + msg.usage.completion_tokens,
        promptTokens: msg.usage.prompt_tokens,
        completionTokens: msg.usage.completion_tokens,
        cached: msg.usage.prompt_tokens_details?.cached_tokens ?? 0,
      };
    }
  }

  // 3. No assistant response yet
  return {
    used: null,
    promptTokens: 0,
    completionTokens: 0,
    cached: 0,
  };
}

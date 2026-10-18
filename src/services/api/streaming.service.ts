import { ChatCompletionRequest } from '../../types/api.types';
import { streamOpenAICompatible, type StreamCallbacks } from './sse-parser';

export type { StreamCallbacks, StreamEndReason } from './sse-parser';

/**
 * Stream chat completions from Open WebUI using Server-Sent Events
 */
export async function streamChatCompletion(
  baseUrl: string,
  apiKey: string,
  request: ChatCompletionRequest,
  callbacks: StreamCallbacks,
  abortSignal?: AbortSignal,
  _traceId?: string,
  fetchImpl?: typeof fetch
): Promise<void> {
  // Normalize baseUrl - remove trailing slash and /api suffix to prevent duplication
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '').replace(/\/api$/i, '');

  await streamOpenAICompatible(
    {
      url: `${normalizedBaseUrl}/api/chat/completions`,
      headers: { Authorization: `Bearer ${apiKey}` },
      body: { ...request, stream: true, stream_options: { include_usage: true } },
      signal: abortSignal,
      fetchImpl,
    },
    callbacks
  );
}

/**
 * Create an abort controller for cancelling streaming requests
 */
export function createStreamAbortController(): AbortController {
  return new AbortController();
}

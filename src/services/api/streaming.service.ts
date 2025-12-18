import { createParser, ParsedEvent, ReconnectInterval } from 'eventsource-parser';
import { ChatCompletionRequest } from '../../types/api.types';
import { ToolCall } from '../../types/message.types';

export interface StreamCallbacks {
  onChunk: (content: string) => void;
  onComplete: () => void;
  onError: (error: Error) => void;
  onToolCalls?: (toolCalls: ToolCall[]) => void;
}

/**
 * Stream chat completions from Open WebUI using Server-Sent Events
 */
export async function streamChatCompletion(
  baseUrl: string,
  apiKey: string,
  request: ChatCompletionRequest,
  callbacks: StreamCallbacks,
  abortSignal?: AbortSignal,
  _traceId?: string
): Promise<void> {
  const { onChunk, onComplete, onError, onToolCalls } = callbacks;

  // Normalize baseUrl - remove trailing slash to prevent double slashes
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');

  try {
    const response = await fetch(`${normalizedBaseUrl}/api/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        ...request,
        stream: true,
      }),
      signal: abortSignal,
    });

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}: ${response.statusText}`;

      try {
        const errorData = await response.json();
        errorMessage = errorData.error?.message || errorMessage;
      } catch {
        // Use default error message if JSON parsing fails
      }

      throw new Error(errorMessage);
    }

    if (!response.body) {
      throw new Error('No response body received');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    // Accumulate tool calls from streaming deltas
    const accumulatedToolCalls: Map<number, ToolCall> = new Map();

    // Accumulate content and track chunks for logging
    let accumulatedContent = '';
    let chunkCount = 0;

    // Create SSE parser
    const parser = createParser((event: ParsedEvent | ReconnectInterval) => {
      if (event.type === 'event') {
        const data = event.data;

        // OpenAI/Open WebUI sends [DONE] when stream is complete
        if (data === '[DONE]') {
          onComplete();
          return;
        }

        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta;
          const content = delta?.content;
          const toolCallDeltas = delta?.tool_calls;

          if (content) {
            accumulatedContent += content;
            chunkCount++;
            onChunk(content);
          }

          // Accumulate tool call deltas
          if (toolCallDeltas && onToolCalls) {
            for (const toolCallDelta of toolCallDeltas) {
              const index = toolCallDelta.index;
              const existing = accumulatedToolCalls.get(index);

              if (!existing) {
                // First chunk for this tool call
                accumulatedToolCalls.set(index, {
                  id: toolCallDelta.id || '',
                  type: toolCallDelta.type || 'function',
                  function: {
                    name: toolCallDelta.function?.name || '',
                    arguments: toolCallDelta.function?.arguments || '',
                  },
                });
              } else {
                // Subsequent chunks - append arguments
                if (toolCallDelta.function?.arguments) {
                  existing.function.arguments += toolCallDelta.function.arguments;
                }
                // Update ID if it wasn't set in first chunk
                if (toolCallDelta.id && !existing.id) {
                  existing.id = toolCallDelta.id;
                }
                // Update name if it wasn't set in first chunk
                if (toolCallDelta.function?.name && !existing.function.name) {
                  existing.function.name = toolCallDelta.function.name;
                }
              }
            }
          }

          // Check if stream is done via finish_reason
          if (json.choices?.[0]?.finish_reason) {
            // Send accumulated tool calls if any
            if (accumulatedToolCalls.size > 0 && onToolCalls) {
              const toolCallsArray = Array.from(accumulatedToolCalls.values()).map(tc => ({
                ...tc,
                // Ensure arguments is valid JSON - default to empty object if empty
                function: {
                  ...tc.function,
                  arguments: tc.function.arguments || '{}',
                },
              }));
              onToolCalls(toolCallsArray);
            }

            onComplete();
          }
        } catch (error) {
          // Continue processing other chunks even if one fails
        }
      }
    });

    // Read the stream
    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          onComplete();
          break;
        }

        // Decode the chunk and feed to parser
        const chunk = decoder.decode(value, { stream: true });
        parser.feed(chunk);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        // Stream was aborted by user
        onComplete();
      } else {
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      // Stream was aborted, not an error
      onComplete();
    } else {
      onError(error instanceof Error ? error : new Error('Unknown streaming error'));
    }
  }
}

/**
 * Create an abort controller for cancelling streaming requests
 */
export function createStreamAbortController(): AbortController {
  return new AbortController();
}

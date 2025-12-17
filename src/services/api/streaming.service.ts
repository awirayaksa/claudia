import { createParser, ParsedEvent, ReconnectInterval } from 'eventsource-parser';
import { ChatCompletionRequest } from '../../types/api.types';
import { ToolCall } from '../../types/message.types';
import { Logger } from '../logger.service';

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
  traceId?: string
): Promise<void> {
  const { onChunk, onComplete, onError, onToolCalls } = callbacks;

  // Normalize baseUrl - remove trailing slash to prevent double slashes
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');

  try {
    // Log request initiation
    Logger.debug('http.request', 'Initiating streaming request', {
      url: `${normalizedBaseUrl}/api/chat/completions`,
      model: request.model,
      messageCount: request.messages?.length,
      toolCount: request.tools?.length || 0,
      tool_choice: request.tool_choice,
      hasAbortSignal: !!abortSignal,
      abortSignalAborted: abortSignal?.aborted || false
    }, traceId);

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

    // Log HTTP response status
    Logger.debug('http.response', 'HTTP response received', {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      hasBody: !!response.body,
      headers: {
        contentType: response.headers.get('content-type'),
        contentLength: response.headers.get('content-length')
      }
    }, traceId);

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

        // Log RAW SSE event before any processing
        Logger.debug('sse.raw', 'Raw SSE event received', {
          dataPreview: data?.substring(0, 500),
          dataLength: data?.length,
          timestamp: Date.now()
        }, traceId);

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

          // Log COMPLETE delta object for comprehensive analysis
          Logger.debug('llm.stream.delta.complete', 'Complete delta object', {
            fullDelta: delta,
            deltaStringified: JSON.stringify(delta),
            hasChoices: !!json.choices,
            choicesLength: json.choices?.length,
            choice0Keys: json.choices?.[0] ? Object.keys(json.choices[0]) : [],
            model: json.model,
            id: json.id
          }, traceId);

          // Debug logging to see what's being received
          Logger.debug('llm.stream.chunk', 'Received SSE chunk', {
            hasContent: !!content,
            contentLength: content?.length,
            hasDelta: !!delta,
            deltaKeys: delta ? Object.keys(delta) : [],
            finishReason: json.choices?.[0]?.finish_reason
          }, traceId);

          if (content) {
            accumulatedContent += content;
            chunkCount++;
            onChunk(content);
          }

          // Accumulate tool call deltas
          if (toolCallDeltas && onToolCalls) {
            Logger.debug('sse.toolcalls', 'tool_calls detected in delta', {
              toolCallDeltasPresent: true,
              toolCallDeltasLength: toolCallDeltas?.length,
              toolCallDeltasContent: JSON.stringify(toolCallDeltas)
            }, traceId);

            for (const toolCallDelta of toolCallDeltas) {
              const index = toolCallDelta.index;
              const existing = accumulatedToolCalls.get(index);

              Logger.debug('llm.stream.toolcall', 'Tool call delta received', {
                toolCallDelta,
                index,
                hasExisting: !!existing
              }, traceId);

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
            Logger.debug('llm.stream.toolcall', 'Tool calls accumulated', {
              toolCallCount: accumulatedToolCalls.size,
              toolCalls: Array.from(accumulatedToolCalls.values())
            }, traceId);
          } else if (delta && !toolCallDeltas) {
            // Log when delta exists but NO tool_calls
            Logger.debug('sse.toolcalls', 'No tool_calls in delta', {
              toolCallDeltasPresent: false,
              deltaKeys: Object.keys(delta),
              hasContent: !!delta.content,
              hasReasoningContent: !!delta.reasoning_content,
              hasRole: !!delta.role
            }, traceId);
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
              Logger.debug('llm.stream.toolcall', 'Sending accumulated tool calls', {
                toolCallCount: toolCallsArray.length,
                toolCalls: toolCallsArray
              }, traceId);
              onToolCalls(toolCallsArray);
            }

            // Log complete LLM response at DEBUG level
            Logger.debug('llm.response', 'LLM streaming response complete', {
              payload: {
                finish_reason: json.choices[0].finish_reason,
                content: accumulatedContent,
                tool_calls: accumulatedToolCalls.size > 0
                  ? Array.from(accumulatedToolCalls.values()).map(tc => ({
                      id: tc.id,
                      type: tc.type,
                      function: {
                        name: tc.function.name,
                        arguments: JSON.parse(tc.function.arguments || '{}')
                      }
                    }))
                  : undefined,
                usage: json.usage
              },
              metadata: {
                model: json.model,
                response_id: json.id,
                chunkCount,
                contentLength: accumulatedContent.length,
                toolCallCount: accumulatedToolCalls.size
              }
            }, traceId);

            onComplete();
          }
        } catch (error) {
          Logger.error('llm.stream', 'Failed to parse SSE chunk', error as Error, {
            data: event.data?.substring(0, 200) // Log first 200 chars for debugging
          }, traceId);
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

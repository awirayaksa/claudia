import axios, { AxiosInstance, AxiosError } from 'axios';
import { createParser, ParsedEvent, ReconnectInterval } from 'eventsource-parser';
import {
  Model,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ProviderType,
  ProviderCapabilities,
  CustomProviderConfig,
  APIError,
} from '../../../types/api.types';
import { ToolCall } from '../../../types/message.types';
import { IAPIProvider } from '../provider.interface';
import { StreamCallbacks } from '../streaming.service';

/**
 * Custom API Provider
 * Implements IAPIProvider for generic OpenAI-compatible endpoints.
 * Users provide the base URL, API key, and model name manually.
 */
export class CustomProvider implements IAPIProvider {
  private axiosInstance: AxiosInstance;
  private config: CustomProviderConfig;

  constructor(config: CustomProviderConfig) {
    this.config = config;
    this.axiosInstance = this.createAxiosInstance(config);
  }

  private createAxiosInstance(config: CustomProviderConfig): AxiosInstance {
    // Normalize baseUrl - remove trailing slash and /api suffix to prevent duplication
    let normalizedBaseUrl = config.baseUrl.replace(/\/+$/, '');
    normalizedBaseUrl = normalizedBaseUrl.replace(/\/api$/i, '');

    return axios.create({
      baseURL: normalizedBaseUrl,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      timeout: 30000, // 30 seconds
    });
  }

  getProviderType(): ProviderType {
    return 'custom';
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsFileUpload: false,
      supportsToolCalling: true,
      supportsStreaming: true,
      requiresCustomHeaders: false,
    };
  }

  async getModels(): Promise<Model[]> {
    try {
      const response = await this.axiosInstance.get<{ data: any[] } | any[]>('/models');
      const data = Array.isArray(response.data) ? response.data : response.data.data || [];

      return data.map((model: any) => ({
        id: model.id,
        name: model.name || model.id,
        object: 'model',
        created: model.created || Date.now(),
        owned_by: model.owned_by || 'custom',
      }));
    } catch {
      // Custom endpoints may not support /models; return empty array
      return [];
    }
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    try {
      const response = await this.axiosInstance.post<ChatCompletionResponse>(
        '/chat/completions',
        {
          ...request,
          stream: false,
        }
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  async streamChatCompletion(
    request: ChatCompletionRequest,
    callbacks: StreamCallbacks,
    abortSignal?: AbortSignal,
    _traceId?: string
  ): Promise<void> {
    const { onChunk, onComplete, onError, onToolCalls, onReasoning, onUsage } = callbacks;

    // Normalize baseUrl - remove trailing slash and /api suffix to prevent duplication
    let normalizedBaseUrl = this.config.baseUrl.replace(/\/+$/, '');
    normalizedBaseUrl = normalizedBaseUrl.replace(/\/api$/i, '');

    try {
      const response = await fetch(`${normalizedBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
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

          // OpenAI-compatible providers send [DONE] when stream is complete
          if (data === '[DONE]') {
            onComplete();
            return;
          }

          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta;
            const content = delta?.content;
            const toolCallDeltas = delta?.tool_calls;
            const reasoningContent = delta?.reasoning;
            const usage = json.usage;

            if (content) {
              accumulatedContent += content;
              chunkCount++;
              onChunk(content);
            }

            if (reasoningContent && onReasoning) {
              onReasoning(reasoningContent);
            }

            // Handle usage data
            if (usage && onUsage) {
              onUsage(usage);
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
              // Send usage FIRST before anything else (including tool calls)
              if (json.usage && onUsage) {
                onUsage(json.usage);
              }

              // Then send accumulated tool calls if any
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

              // NOTE: Don't call onComplete() here - usage data may arrive in subsequent chunks
              // onComplete() will be called when stream actually ends (done=true or [DONE])
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

  async testConnection(): Promise<boolean> {
    try {
      // Try a lightweight /models request first
      const models = await this.getModels();
      if (models.length > 0) {
        return true;
      }
      // If /models returned empty (common for custom endpoints), try a minimal chat completion
      await this.chatCompletion({
        model: this.config.selectedModel,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  updateConfig(config: CustomProviderConfig): void {
    this.config = config;
    this.axiosInstance = this.createAxiosInstance(config);
  }

  /**
   * Handle API errors and convert them to user-friendly messages
   */
  private handleError(error: unknown): Error {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<APIError>;

      if (axiosError.response) {
        // Server responded with error
        const message =
          axiosError.response.data?.error?.message ||
          axiosError.response.statusText ||
          'Unknown server error';

        return new Error(`API Error: ${message}`);
      } else if (axiosError.request) {
        // Request was made but no response
        return new Error(
          'Network Error: Could not connect to the API endpoint. Please check your URL and internet connection.'
        );
      }
    }

    // Generic error
    return new Error('An unexpected error occurred');
  }
}

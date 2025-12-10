import axios, { AxiosInstance, AxiosError } from 'axios';
import { createParser, ParsedEvent, ReconnectInterval } from 'eventsource-parser';
import {
  Model,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ProviderType,
  ProviderCapabilities,
  OpenRouterConfig,
  APIError,
} from '../../../types/api.types';
import { ToolCall } from '../../../types/message.types';
import { IAPIProvider } from '../provider.interface';
import { StreamCallbacks } from '../streaming.service';

/**
 * OpenRouter API Provider
 * Implements IAPIProvider for OpenRouter integration
 */
export class OpenRouterProvider implements IAPIProvider {
  private axiosInstance: AxiosInstance;
  private config: OpenRouterConfig;
  private static readonly BASE_URL = 'https://openrouter.ai/api/v1';

  constructor(config: OpenRouterConfig) {
    this.config = config;
    this.axiosInstance = this.createAxiosInstance(config);
  }

  private createAxiosInstance(config: OpenRouterConfig): AxiosInstance {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    };

    // Add optional OpenRouter-specific headers for dashboard tracking
    if (config.siteUrl) {
      headers['HTTP-Referer'] = config.siteUrl;
    }
    if (config.siteName) {
      headers['X-Title'] = config.siteName;
    }

    return axios.create({
      baseURL: OpenRouterProvider.BASE_URL,
      headers,
      timeout: 30000, // 30 seconds
    });
  }

  getProviderType(): ProviderType {
    return 'openrouter';
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsFileUpload: false,  // OpenRouter doesn't support file uploads
      supportsToolCalling: true,
      supportsStreaming: true,
      requiresCustomHeaders: true,
    };
  }

  async getModels(): Promise<Model[]> {
    try {
      const response = await this.axiosInstance.get<{ data: any[] }>('/models');

      // Transform OpenRouter model format to our standard Model type
      return response.data.data.map((model: any) => ({
        id: model.id,
        name: model.name || model.id,
        object: 'model',
        created: Date.now(),
        owned_by: model.created_by || 'openrouter',
      }));
    } catch (error) {
      throw this.handleError(error);
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
    abortSignal?: AbortSignal
  ): Promise<void> {
    const { onChunk, onComplete, onError, onToolCalls } = callbacks;

    try {
      // Prepare headers
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      };

      if (this.config.siteUrl) {
        headers['HTTP-Referer'] = this.config.siteUrl;
      }
      if (this.config.siteName) {
        headers['X-Title'] = this.config.siteName;
      }

      const response = await fetch(`${OpenRouterProvider.BASE_URL}/chat/completions`, {
        method: 'POST',
        headers,
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

            if (content) {
              onChunk(content);
            }

            // Accumulate tool call deltas
            if (toolCallDeltas && onToolCalls) {
              for (const toolCallDelta of toolCallDeltas) {
                const index = toolCallDelta.index;
                const existing = accumulatedToolCalls.get(index);

                console.log('[OpenRouter] Tool call delta:', JSON.stringify(toolCallDelta));

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
              console.log('[OpenRouter] Accumulated tool calls:', Array.from(accumulatedToolCalls.values()));
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
                console.log('[OpenRouter] Sending accumulated tool calls:', JSON.stringify(toolCallsArray, null, 2));
                onToolCalls(toolCallsArray);
              }
              onComplete();
            }
          } catch (error) {
            console.error('Failed to parse SSE chunk:', error);
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
      await this.getModels();
      return true;
    } catch (error) {
      console.error('OpenRouter connection test failed:', error);
      return false;
    }
  }

  updateConfig(config: OpenRouterConfig): void {
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

        return new Error(`OpenRouter API Error: ${message}`);
      } else if (axiosError.request) {
        // Request was made but no response
        return new Error(
          'Network Error: Could not connect to OpenRouter. Please check your internet connection.'
        );
      }
    }

    // Generic error
    return new Error('An unexpected error occurred with OpenRouter');
  }
}

import axios, { AxiosInstance, AxiosError } from 'axios';
import {
  Model,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ProviderType,
  ProviderCapabilities,
  OpenRouterConfig,
  APIError,
} from '../../../types/api.types';
import { IAPIProvider } from '../provider.interface';
import { describeApiError, streamOpenAICompatible, type StreamCallbacks } from '../sse-parser';

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

  /**
   * OpenRouter expresses reasoning effort as `reasoning: { effort }` rather than
   * the OpenAI `reasoning_effort` field, so translate it here.
   */
  private buildRequestBody(request: ChatCompletionRequest, extra: Record<string, unknown>) {
    const { reasoning_effort, ...rest } = request;
    return {
      ...rest,
      ...(reasoning_effort ? { reasoning: { effort: reasoning_effort } } : {}),
      ...extra,
    };
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
        context_length: model.context_length,
      }));
    } catch (error) {
      throw this.handleError(error);
    }
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    try {
      const response = await this.axiosInstance.post<ChatCompletionResponse>(
        '/chat/completions',
        this.buildRequestBody(request, { stream: false })
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
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
    };
    // Optional OpenRouter-specific headers for dashboard tracking
    if (this.config.siteUrl) {
      headers['HTTP-Referer'] = this.config.siteUrl;
    }
    if (this.config.siteName) {
      headers['X-Title'] = this.config.siteName;
    }

    await streamOpenAICompatible(
      {
        url: `${OpenRouterProvider.BASE_URL}/chat/completions`,
        headers,
        body: this.buildRequestBody(request, {
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: abortSignal,
      },
      callbacks
    );
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.getModels();
      return true;
    } catch (error) {
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
          describeApiError(axiosError.response.data) ||
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

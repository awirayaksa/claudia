import axios, { AxiosInstance, AxiosError } from 'axios';
import {
  Model,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ProviderType,
  ProviderCapabilities,
  CustomProviderConfig,
  APIError,
} from '../../../types/api.types';
import { IAPIProvider } from '../provider.interface';
import { streamOpenAICompatible, type StreamCallbacks } from '../sse-parser';

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
    // Normalize baseUrl - remove trailing slash and /api suffix to prevent duplication
    const normalizedBaseUrl = this.config.baseUrl.replace(/\/+$/, '').replace(/\/api$/i, '');

    await streamOpenAICompatible(
      {
        url: `${normalizedBaseUrl}/chat/completions`,
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        body: { ...request, stream: true, stream_options: { include_usage: true } },
        signal: abortSignal,
      },
      callbacks
    );
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

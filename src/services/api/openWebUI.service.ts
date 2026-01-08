import axios, { AxiosInstance, AxiosError } from 'axios';
import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelsResponse,
  Model,
  APIError,
} from '../../types/api.types';

export class OpenWebUIService {
  private axiosInstance: AxiosInstance;

  constructor(baseUrl: string, apiKey: string) {
    // Normalize baseUrl - remove trailing slash and /api suffix to prevent duplication
    let normalizedBaseUrl = baseUrl.replace(/\/+$/, ''); // Remove trailing slashes
    // Remove /api suffix if present (case-insensitive) to prevent /api/api duplication
    normalizedBaseUrl = normalizedBaseUrl.replace(/\/api$/i, '');
    this.axiosInstance = axios.create({
      baseURL: normalizedBaseUrl,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      timeout: 30000, // 30 seconds
    });
  }

  /**
   * Update the API configuration
   */
  updateConfig(baseUrl: string, apiKey: string): void {
    // Normalize baseUrl - remove trailing slash and /api suffix to prevent duplication
    let normalizedBaseUrl = baseUrl.replace(/\/+$/, ''); // Remove trailing slashes
    // Remove /api suffix if present (case-insensitive) to prevent /api/api duplication
    normalizedBaseUrl = normalizedBaseUrl.replace(/\/api$/i, '');
    this.axiosInstance = axios.create({
      baseURL: normalizedBaseUrl,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      timeout: 30000,
    });
  }

  /**
   * Test the connection to Open WebUI
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.getModels();
      return true;
    } catch (error) {
      console.error('Connection test failed:', error);
      return false;
    }
  }

  /**
   * Get available models from Open WebUI
   */
  async getModels(): Promise<Model[]> {
    try {
      const response = await this.axiosInstance.get<ModelsResponse>('/api/models');
      return response.data.data;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Send a chat completion request (non-streaming)
   */
  async chatCompletion(
    request: ChatCompletionRequest
  ): Promise<ChatCompletionResponse> {
    try {
      const response = await this.axiosInstance.post<ChatCompletionResponse>(
        '/api/chat/completions',
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

  /**
   * Upload a file to Open WebUI
   */
  async uploadFile(file: File, onProgress?: (progress: number) => void): Promise<string> {
    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await this.axiosInstance.post<{ id: string; url: string }>(
        '/api/v1/files',
        formData,
        {
          headers: {
            'Content-Type': 'multipart/form-data',
          },
          onUploadProgress: (progressEvent) => {
            if (onProgress && progressEvent.total) {
              const progress = (progressEvent.loaded / progressEvent.total) * 100;
              onProgress(progress);
            }
          },
        }
      );

      return response.data.id;
    } catch (error) {
      throw this.handleError(error);
    }
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
          'Network Error: Could not connect to Open WebUI. Please check your URL and internet connection.'
        );
      }
    }

    // Generic error
    return new Error('An unexpected error occurred');
  }
}

// Singleton instance
let apiServiceInstance: OpenWebUIService | null = null;

/**
 * Get or create the OpenWebUI service instance
 */
export function getOpenWebUIService(baseUrl?: string, apiKey?: string): OpenWebUIService {
  if (!apiServiceInstance && baseUrl && apiKey) {
    apiServiceInstance = new OpenWebUIService(baseUrl, apiKey);
  } else if (apiServiceInstance && baseUrl && apiKey) {
    apiServiceInstance.updateConfig(baseUrl, apiKey);
  }

  if (!apiServiceInstance) {
    throw new Error('OpenWebUI service not initialized. Please configure API settings.');
  }

  return apiServiceInstance;
}

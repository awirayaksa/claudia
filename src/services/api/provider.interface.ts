import {
  Model,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ProviderType,
  ProviderCapabilities
} from '../../types/api.types';
import { StreamCallbacks } from './streaming.service';

/**
 * API Provider Interface
 * All API providers must implement this interface to be compatible with Claudia
 */
export interface IAPIProvider {
  /**
   * Fetch available models from the provider
   */
  getModels(): Promise<Model[]>;

  /**
   * Send a chat completion request (non-streaming)
   */
  chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;

  /**
   * Send a streaming chat completion request
   * @param request - The chat completion request
   * @param callbacks - Callbacks for handling streaming events
   * @param abortSignal - Optional signal to abort the request
   * @param traceId - Optional trace ID for logging correlation
   */
  streamChatCompletion(
    request: ChatCompletionRequest,
    callbacks: StreamCallbacks,
    abortSignal?: AbortSignal,
    traceId?: string
  ): Promise<void>;

  /**
   * Test the connection to the provider
   * @returns true if connection is successful, false otherwise
   */
  testConnection(): Promise<boolean>;

  /**
   * Update the provider configuration
   * @param config - The new configuration
   */
  updateConfig(config: any): void;

  /**
   * Get the provider's capabilities
   * @returns Provider capabilities (features supported)
   */
  getCapabilities(): ProviderCapabilities;

  /**
   * Get the provider type identifier
   * @returns The provider type
   */
  getProviderType(): ProviderType;

  /**
   * Upload a file to the provider (optional feature)
   * Check capabilities.supportsFileUpload before calling
   * @param file - The file to upload
   * @param onProgress - Optional progress callback
   * @returns The uploaded file ID or URL
   */
  uploadFile?(file: File, onProgress?: (progress: number) => void): Promise<string>;
}

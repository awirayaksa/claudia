import {
  Model,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ProviderType,
  ProviderCapabilities,
  OpenWebUIConfig,
} from '../../../types/api.types';
import { IAPIProvider } from '../provider.interface';
import { OpenWebUIService } from '../openWebUI.service';
import { streamChatCompletion, StreamCallbacks } from '../streaming.service';

/**
 * Open WebUI API Provider
 * Wraps the existing OpenWebUIService to implement the IAPIProvider interface
 */
export class OpenWebUIProvider implements IAPIProvider {
  private service: OpenWebUIService;
  private config: OpenWebUIConfig;

  constructor(config: OpenWebUIConfig) {
    console.log('[OpenWebUIProvider] Constructor - input baseUrl:', config.baseUrl);
    this.config = config;
    this.service = new OpenWebUIService(config.baseUrl, config.apiKey);
    console.log('[OpenWebUIProvider] Constructor - this.config.baseUrl:', this.config.baseUrl);
  }

  getProviderType(): ProviderType {
    return 'openwebui';
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsFileUpload: true,
      supportsToolCalling: true,
      supportsStreaming: true,
      requiresCustomHeaders: false,
    };
  }

  async getModels(): Promise<Model[]> {
    return this.service.getModels();
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    return this.service.chatCompletion(request);
  }

  async streamChatCompletion(
    request: ChatCompletionRequest,
    callbacks: StreamCallbacks,
    abortSignal?: AbortSignal,
    traceId?: string
  ): Promise<void> {
    return streamChatCompletion(
      this.config.baseUrl,
      this.config.apiKey,
      request,
      callbacks,
      abortSignal,
      traceId
    );
  }

  async testConnection(): Promise<boolean> {
    return this.service.testConnection();
  }

  updateConfig(config: OpenWebUIConfig): void {
    console.log('[OpenWebUIProvider] updateConfig - input baseUrl:', config.baseUrl);
    this.config = config;
    this.service.updateConfig(config.baseUrl, config.apiKey);
    console.log('[OpenWebUIProvider] updateConfig - this.config.baseUrl:', this.config.baseUrl);
  }

  async uploadFile(file: File, onProgress?: (progress: number) => void): Promise<string> {
    return this.service.uploadFile(file, onProgress);
  }
}

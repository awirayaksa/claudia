import axios, { AxiosInstance, AxiosError } from 'axios';
import { createParser, ParsedEvent, ReconnectInterval } from 'eventsource-parser';
import { isAbortError, onceTerminal, readErrorMessage, streamOpenAICompatible } from '../sse-parser';
import {
  Model,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ProviderType,
  ProviderCapabilities,
  OpencodeGoConfig,
  APIError,
} from '../../../types/api.types';
import { MessageUsage } from '../../../types/statistics.types';
import { IAPIProvider } from '../provider.interface';
import type { StreamCallbacks } from '../sse-parser';
import { toAnthropicEffort } from '../../../utils/effort-utils';

const OPENCODE_GO_MODELS: Model[] = [
  // OpenAI-compatible models
  { id: 'glm-5.1', name: 'GLM-5.1', object: 'model', created: 0, owned_by: 'opencode-go' },
  { id: 'glm-5', name: 'GLM-5', object: 'model', created: 0, owned_by: 'opencode-go' },
  { id: 'kimi-k2.5', name: 'Kimi K2.5', object: 'model', created: 0, owned_by: 'opencode-go' },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', object: 'model', created: 0, owned_by: 'opencode-go' },
  { id: 'mimo-v2-pro', name: 'MiMo-V2-Pro', object: 'model', created: 0, owned_by: 'opencode-go' },
  { id: 'mimo-v2-omni', name: 'MiMo-V2-Omni', object: 'model', created: 0, owned_by: 'opencode-go' },
  { id: 'mimo-v2.5-pro', name: 'MiMo-V2.5-Pro', object: 'model', created: 0, owned_by: 'opencode-go' },
  { id: 'mimo-v2.5', name: 'MiMo-V2.5', object: 'model', created: 0, owned_by: 'opencode-go' },
  { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', object: 'model', created: 0, owned_by: 'opencode-go' },
  { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', object: 'model', created: 0, owned_by: 'opencode-go' },
  // Anthropic-compatible models
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', object: 'model', created: 0, owned_by: 'opencode-go' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', object: 'model', created: 0, owned_by: 'opencode-go' },
  { id: 'minimax-m2.7', name: 'MiniMax M2.7', object: 'model', created: 0, owned_by: 'opencode-go' },
  { id: 'minimax-m2.5', name: 'MiniMax M2.5', object: 'model', created: 0, owned_by: 'opencode-go' },
];

const ANTHROPIC_MODEL_IDS = new Set([
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'minimax-m2.7',
  'minimax-m2.5',
]);

export class OpencodeGoProvider implements IAPIProvider {
  private axiosInstance: AxiosInstance;
  private config: OpencodeGoConfig;

  constructor(config: OpencodeGoConfig) {
    this.config = config;
    this.axiosInstance = this.createAxiosInstance(config);
  }

  private normalizeBaseUrl(url: string): string {
    return url
      .replace(/\/+$/, '') // Remove trailing slashes
      .replace(/\/api$/i, '') // Remove /api suffix
      .replace(/\/v1$/i, ''); // Remove /v1 suffix (prevents double /v1 in requests)
  }

  private normalizeModelId(modelId: string): string {
    // Strip opencode-go/ prefix if present (e.g. opencode-go/kimi-k2.6 → kimi-k2.6)
    if (modelId.startsWith('opencode-go/')) {
      return modelId.slice('opencode-go/'.length);
    }
    // Strip other common provider prefixes (e.g. moonshotai/kimi-k2.6 → kimi-k2.6)
    const prefixSeparator = modelId.indexOf('/');
    if (prefixSeparator > 0 && prefixSeparator < modelId.length - 1) {
      // Check if prefix looks like a provider slug (alphanumeric + dashes)
      const prefix = modelId.slice(0, prefixSeparator);
      if (/^[a-z0-9-]+$/.test(prefix)) {
        return modelId.slice(prefixSeparator + 1);
      }
    }
    return modelId;
  }

  private createAxiosInstance(config: OpencodeGoConfig): AxiosInstance {
    return axios.create({
      baseURL: this.normalizeBaseUrl(config.baseUrl),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      timeout: 30000,
      httpAgent: config.http?.httpAgent,
      httpsAgent: config.http?.httpsAgent,
    });
  }

  getProviderType(): ProviderType {
    return 'opencode-go';
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsFileUpload: false,
      supportsToolCalling: true,
      supportsStreaming: true,
      requiresCustomHeaders: false,
      toolsFirstTurnOnly: true,
    };
  }

  async getModels(): Promise<Model[]> {
    const isAnthropic = this.config.apiCompatibility === 'anthropic';
    return OPENCODE_GO_MODELS.filter((m) => {
      const isAnthropicModel = ANTHROPIC_MODEL_IDS.has(m.id);
      return isAnthropic ? isAnthropicModel : !isAnthropicModel;
    });
  }

  /**
   * Anthropic-style endpoints take `output_config.effort`. Without an explicit
   * choice we keep the long-standing 'high' default.
   */
  private anthropicEffort(request: ChatCompletionRequest): 'low' | 'medium' | 'high' {
    return request.reasoning_effort ? toAnthropicEffort(request.reasoning_effort) : 'high';
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const normalizedRequest = { ...request, model: this.normalizeModelId(request.model) };
    try {
      if (this.config.apiCompatibility === 'anthropic') {
        return await this.chatCompletionAnthropic(normalizedRequest);
      }
      const response = await this.axiosInstance.post<ChatCompletionResponse>(
        '/v1/chat/completions',
        { ...normalizedRequest, stream: false }
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  private async chatCompletionAnthropic(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const systemMessages = request.messages.filter((m) => m.role === 'system');
    const nonSystemMessages = request.messages.filter((m) => m.role !== 'system');
    const systemText = systemMessages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');

    const anthropicBody: Record<string, unknown> = {
      model: request.model,
      messages: nonSystemMessages.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : m.content,
      })),
      max_tokens: request.max_tokens ?? 1024,
      stream: false,
      thinking: { type: 'enabled' },
      output_config: { effort: this.anthropicEffort(request) },
    };
    if (systemText) anthropicBody.system = systemText;

    console.log('[OpencodeGoProvider] Anthropic non-streaming request body:', JSON.stringify(anthropicBody));

    const baseUrl = this.normalizeBaseUrl(this.config.baseUrl);
    const response = await (this.config.http?.fetch ?? fetch)(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(anthropicBody),
    });

    if (!response.ok) {
      let msg = `HTTP ${response.status}: ${response.statusText}`;
      try {
        const err = await response.json();
        msg = err.error?.message || msg;
      } catch { /* ignore */ }
      throw new Error(msg);
    }

    const data: any = await response.json();
    console.log('[OpencodeGoProvider] Anthropic non-streaming response:', JSON.stringify(data));
    let text = '';
    let reasoning = '';
    for (const block of data.content || []) {
      if (block.type === 'text') {
        text += block.text ?? '';
      } else if (block.type === 'thinking' || block.type === 'reasoning') {
        reasoning += block.thinking ?? block.reasoning ?? '';
      }
    }
    return {
      id: data.id || '',
      object: 'chat.completion',
      created: Date.now(),
      model: data.model || request.model,
      choices: [{ index: 0, message: { role: 'assistant', content: text, reasoning: reasoning || undefined }, finish_reason: data.stop_reason || 'stop' }],
      usage: data.usage ? {
        prompt_tokens: data.usage.input_tokens ?? 0,
        completion_tokens: data.usage.output_tokens ?? 0,
        total_tokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
      } : undefined,
    };
  }

  async streamChatCompletion(
    request: ChatCompletionRequest,
    callbacks: StreamCallbacks,
    abortSignal?: AbortSignal,
    _traceId?: string
  ): Promise<void> {
    const normalizedRequest = { ...request, model: this.normalizeModelId(request.model) };
    if (this.config.apiCompatibility === 'anthropic') {
      return this.streamChatCompletionAnthropic(normalizedRequest, callbacks, abortSignal);
    }
    return this.streamChatCompletionOpenAI(normalizedRequest, callbacks, abortSignal);
  }

  private async streamChatCompletionOpenAI(
    request: ChatCompletionRequest,
    callbacks: StreamCallbacks,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const baseUrl = this.normalizeBaseUrl(this.config.baseUrl);
    const body = { ...request, stream: true };
    console.log('[OpencodeGoProvider] Request body:', JSON.stringify(body));

    await streamOpenAICompatible(
      {
        url: `${baseUrl}/v1/chat/completions`,
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        body,
        signal: abortSignal,
        fetchImpl: this.config.http?.fetch,
      },
      {
        ...callbacks,
        onError: (error) => {
          console.error('[OpencodeGoProvider] API error:', error.message);
          callbacks.onError(error);
        },
      }
    );
  }

  private async streamChatCompletionAnthropic(
    request: ChatCompletionRequest,
    callbacks: StreamCallbacks,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const cb = onceTerminal(callbacks);
    const { onChunk, onReasoning, onUsage } = cb;
    // Anthropic stop_reason → StreamEndReason
    let stopReason: 'stop' | 'tool_calls' | 'length' = 'stop';

    const systemMessages = request.messages.filter((m) => m.role === 'system');
    const nonSystemMessages = request.messages.filter((m) => m.role !== 'system');
    const systemText = systemMessages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');

    const anthropicBody: Record<string, unknown> = {
      model: request.model,
      messages: nonSystemMessages.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : m.content,
      })),
      max_tokens: request.max_tokens ?? 1024,
      stream: true,
      thinking: { type: 'enabled' },
      output_config: { effort: this.anthropicEffort(request) },
    };
    if (systemText) anthropicBody.system = systemText;

    console.log('[OpencodeGoProvider] Anthropic streaming request body:', JSON.stringify(anthropicBody));

    const baseUrl = this.normalizeBaseUrl(this.config.baseUrl);

    try {
      const response = await (this.config.http?.fetch ?? fetch)(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(anthropicBody),
        signal: abortSignal,
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }

      if (!response.body) throw new Error('No response body received');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      const parser = createParser((event: ParsedEvent | ReconnectInterval) => {
        if (event.type !== 'event') return;
        const eventName = (event as ParsedEvent).event;
        const data = event.data;

        try {
          console.log('[OpencodeGoProvider] Anthropic SSE event:', eventName, data);
          if (eventName === 'content_block_start') {
            const json = JSON.parse(data);
            if (json.content_block?.type === 'thinking' && json.content_block?.thinking && onReasoning) {
              onReasoning(json.content_block.thinking);
            } else if (json.content_block?.type === 'reasoning' && json.content_block?.reasoning && onReasoning) {
              onReasoning(json.content_block.reasoning);
            }
          } else if (eventName === 'content_block_delta') {
            const json = JSON.parse(data);
            if (json.delta?.type === 'text_delta' && json.delta?.text) {
              onChunk(json.delta.text);
            } else if (json.delta?.type === 'thinking_delta' && json.delta?.thinking && onReasoning) {
              onReasoning(json.delta.thinking);
            } else if (json.delta?.reasoning && onReasoning) {
              onReasoning(json.delta.reasoning);
            } else if (json.delta?.reasoning_content && onReasoning) {
              onReasoning(json.delta.reasoning_content);
            } else if (json.delta?.text) {
              // Some proxies send plain text deltas without the text_delta wrapper
              onChunk(json.delta.text);
            }
          } else if (eventName === 'message_delta') {
            const json = JSON.parse(data);
            const reason = json.delta?.stop_reason;
            if (reason === 'max_tokens') stopReason = 'length';
            else if (reason === 'tool_use') stopReason = 'tool_calls';
            if (json.usage && onUsage) {
              const usage: MessageUsage = {
                prompt_tokens: json.usage.input_tokens ?? 0,
                completion_tokens: json.usage.output_tokens ?? 0,
                total_tokens: (json.usage.input_tokens ?? 0) + (json.usage.output_tokens ?? 0),
              };
              onUsage(usage);
            }
          } else if (eventName === 'message_stop') {
            cb.onComplete(stopReason);
          }

          // Fallback: some proxies send OpenAI-format events even on Anthropic endpoints
          if (eventName === 'message' || eventName === '') {
            const json = JSON.parse(data);
            if (json.choices) {
              const delta = json.choices[0]?.delta;
              if (delta?.content) onChunk(delta.content);
              if ((delta?.reasoning ?? delta?.reasoning_content) && onReasoning) {
                onReasoning(delta.reasoning ?? delta.reasoning_content);
              }
              if (json.usage && onUsage) onUsage(json.usage);
            }
            if (json.delta && !json.choices) {
              // Direct delta format (some proxies)
              if (json.delta.content) onChunk(json.delta.content);
              if ((json.delta.reasoning ?? json.delta.reasoning_content ?? json.delta.thinking) && onReasoning) {
                onReasoning(json.delta.reasoning ?? json.delta.reasoning_content ?? json.delta.thinking);
              }
            }
          }
        } catch { /* continue on parse error */ }
      });

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }
      // No-op when message_stop already completed the stream
      cb.onComplete(stopReason);
    } catch (error) {
      if (isAbortError(error) || abortSignal?.aborted) {
        cb.onComplete('aborted');
      } else {
        cb.onError(error instanceof Error ? error : new Error('Unknown streaming error'));
      }
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.chatCompletion({
        model: this.normalizeModelId(this.config.selectedModel),
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      });
      return true;
    } catch {
      return false;
    }
  }

  updateConfig(config: OpencodeGoConfig): void {
    // Defensive copy to avoid holding a reference to external (e.g. Redux) state objects
    this.config = { ...config };
    this.axiosInstance = this.createAxiosInstance(this.config);
  }

  private handleError(error: unknown): Error {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<APIError>;
      if (axiosError.response) {
        const message = axiosError.response.data?.error?.message || axiosError.response.statusText || 'Unknown server error';
        return new Error(`API Error: ${message}`);
      } else if (axiosError.request) {
        return new Error('Network Error: Could not connect to the API endpoint. Please check your URL and internet connection.');
      }
    }
    return new Error('An unexpected error occurred');
  }
}

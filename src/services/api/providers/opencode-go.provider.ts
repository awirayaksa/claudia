import { v4 as uuidv4 } from 'uuid';
import { createParser, ParsedEvent, ReconnectInterval } from 'eventsource-parser';
import { isAbortError, onceTerminal, readErrorMessage, streamOpenAICompatible } from '../sse-parser';
import {
  Model,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ProviderType,
  ProviderCapabilities,
  OpencodeGoConfig,
  RequestOptions,
} from '../../../types/api.types';
import { MessageUsage } from '../../../types/statistics.types';
import { IAPIProvider } from '../provider.interface';
import type { StreamCallbacks } from '../sse-parser';
import { toAnthropicEffort } from '../../../utils/effort-utils';

/**
 * OpenCode Go routes and caches by conversation: every chat request carries a
 * stable id per conversation (https://opencode.ai/v2/docs/console/go/).
 */
export const OPENCODE_SESSION_HEADER = 'x-opencode-session';

const MODELS_TIMEOUT_MS = 15_000;

/** An entry of the service's GET /v1/models (only the fields we read). */
interface UpstreamModel {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  created?: unknown;
  owned_by?: unknown;
  context_length?: unknown;
  limit?: { context?: unknown };
  modalities?: { output?: unknown };
}

/** Chat models that answer in text, whatever their native API: the service translates. */
function isTextModel(m: UpstreamModel): boolean {
  if (typeof m.id !== 'string' || !m.id.trim()) return false;
  if (m.type !== undefined && m.type !== 'chat') return false;
  const output = m.modalities?.output;
  return !Array.isArray(output) || output.includes('text');
}

function toModel(m: UpstreamModel): Model {
  const id = (m.id as string).trim();
  const context = typeof m.limit?.context === 'number' ? m.limit.context : m.context_length;
  return {
    id,
    name: typeof m.name === 'string' && m.name.trim() ? m.name : id,
    object: 'model',
    created: typeof m.created === 'number' ? m.created : 0,
    owned_by: typeof m.owned_by === 'string' ? m.owned_by : 'opencode-go',
    ...(typeof context === 'number' ? { context_length: context } : {}),
  };
}

function networkError(error: unknown): Error {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return new Error('Network Error: The API endpoint did not answer in time.');
  }
  return new Error('Network Error: Could not connect to the API endpoint. Please check your URL and internet connection.');
}

export class OpencodeGoProvider implements IAPIProvider {
  private config: OpencodeGoConfig;

  constructor(config: OpencodeGoConfig) {
    // Defensive copy to avoid holding a reference to external (e.g. Redux) state objects
    this.config = { ...config };
  }

  private normalizeBaseUrl(url: string): string {
    return url
      .replace(/\/+$/, '') // Remove trailing slashes
      .replace(/\/api$/i, '') // Remove /api suffix
      .replace(/\/v1$/i, ''); // Remove /v1 suffix (prevents double /v1 in requests)
  }

  /** The model id the service expects, without a provider prefix. */
  normalizeModelId(modelId: string): string {
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

  private get baseUrl(): string {
    return this.normalizeBaseUrl(this.config.baseUrl);
  }

  /** The configured transport (the server's SSRF guard), else the global fetch. */
  private fetch(url: string, init: RequestInit): Promise<Response> {
    return (this.config.http?.fetch ?? fetch)(url, init);
  }

  /**
   * Authorization and client identification. Browsers do not let pages set
   * User-Agent, so the desktop app sets it in its main process instead.
   */
  private baseHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      ...(this.config.userAgent ? { 'User-Agent': this.config.userAgent } : {}),
    };
  }

  /** Headers of a chat request. A request outside a conversation gets a session of its own. */
  private chatHeaders(options?: RequestOptions): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...this.baseHeaders(),
      [OPENCODE_SESSION_HEADER]: options?.sessionId?.trim() || uuidv4(),
    };
  }

  /** POST a JSON body; throws with the service's reason when it fails. */
  private async post(path: string, body: unknown, options?: RequestOptions): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.chatHeaders(options),
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw networkError(error);
    }
    if (!response.ok) throw new Error(`API Error: ${await readErrorMessage(response)}`);
    return response;
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

  /** The text models the configured service lists at GET /v1/models. */
  async getModels(): Promise<Model[]> {
    const url = `${this.baseUrl}/v1/models`;
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: 'GET',
        headers: this.baseHeaders(),
        signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(MODELS_TIMEOUT_MS) : undefined,
      });
    } catch (error) {
      throw networkError(error);
    }
    if (!response.ok) {
      throw new Error(`Could not load models: ${await readErrorMessage(response)}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Could not load models: ${url} did not return JSON.`);
    }
    const data = (payload as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) {
      throw new Error(`Could not load models: ${url} did not return a model list.`);
    }
    const models = (data as UpstreamModel[]).filter(isTextModel).map(toModel);
    if (models.length === 0) {
      throw new Error(`Could not load models: ${url} returned no text models.`);
    }
    return models;
  }

  /**
   * Anthropic-style endpoints take `output_config.effort`. Without an explicit
   * choice we keep the long-standing 'high' default.
   */
  private anthropicEffort(request: ChatCompletionRequest): 'low' | 'medium' | 'high' {
    return request.reasoning_effort ? toAnthropicEffort(request.reasoning_effort) : 'high';
  }

  async chatCompletion(request: ChatCompletionRequest, options?: RequestOptions): Promise<ChatCompletionResponse> {
    const normalizedRequest = { ...request, model: this.normalizeModelId(request.model) };
    if (this.config.apiCompatibility === 'anthropic') {
      return this.chatCompletionAnthropic(normalizedRequest, options);
    }
    const response = await this.post('/v1/chat/completions', { ...normalizedRequest, stream: false }, options);
    return (await response.json()) as ChatCompletionResponse;
  }

  private async chatCompletionAnthropic(
    request: ChatCompletionRequest,
    options?: RequestOptions
  ): Promise<ChatCompletionResponse> {
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

    const response = await this.post('/v1/messages', anthropicBody, options);
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
    _traceId?: string,
    options?: RequestOptions
  ): Promise<void> {
    const normalizedRequest = { ...request, model: this.normalizeModelId(request.model) };
    if (this.config.apiCompatibility === 'anthropic') {
      return this.streamChatCompletionAnthropic(normalizedRequest, callbacks, abortSignal, options);
    }
    return this.streamChatCompletionOpenAI(normalizedRequest, callbacks, abortSignal, options);
  }

  private async streamChatCompletionOpenAI(
    request: ChatCompletionRequest,
    callbacks: StreamCallbacks,
    abortSignal?: AbortSignal,
    options?: RequestOptions
  ): Promise<void> {
    const body = { ...request, stream: true };
    console.log('[OpencodeGoProvider] Request body:', JSON.stringify(body));

    await streamOpenAICompatible(
      {
        url: `${this.baseUrl}/v1/chat/completions`,
        headers: this.chatHeaders(options),
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
    abortSignal?: AbortSignal,
    options?: RequestOptions
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

    try {
      const response = await this.fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: this.chatHeaders(options),
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

  /**
   * Sends a minimal chat request to `model`. The model list is public, so only
   * a chat tells whether the key, endpoint and model work. Throws with the
   * service's reason.
   */
  async verifyConnection(model: string): Promise<void> {
    await this.chatCompletion({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 16,
    });
  }

  async testConnection(): Promise<boolean> {
    try {
      const model = this.config.selectedModel?.trim() || (await this.getModels())[0].id;
      await this.verifyConnection(model);
      return true;
    } catch {
      return false;
    }
  }

  updateConfig(config: OpencodeGoConfig): void {
    // Defensive copy to avoid holding a reference to external (e.g. Redux) state objects
    this.config = { ...config };
  }
}

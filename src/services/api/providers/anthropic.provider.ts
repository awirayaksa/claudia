/**
 * Native Anthropic Messages API provider: streaming, tool use, images and
 * extended thinking (from the reasoning effort). Takes and returns the
 * OpenAI-shaped requests and callbacks the rest of Claudia uses.
 */
import { createParser, type ParsedEvent, type ReconnectInterval } from 'eventsource-parser';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ContentPart,
  Model,
  ProviderCapabilities,
  ProviderHttp,
  ProviderType,
} from '../../../types/api.types';
import type { ToolCall } from '../../../types/message.types';
import type { MessageUsage } from '../../../types/statistics.types';
import type { IAPIProvider } from '../provider.interface';
import { isAbortError, onceTerminal, readErrorMessage, type StreamCallbacks } from '../sse-parser';

export interface AnthropicConfig {
  apiKey: string;
  /** Default https://api.anthropic.com */
  baseUrl?: string;
  http?: ProviderHttp;
}

const API_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 8192;
/** Thinking budget per reasoning effort. */
const THINKING_BUDGET: Record<string, number> = { minimal: 1024, low: 2048, medium: 8192, high: 16_384, xhigh: 32_000 };

type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: Block[];
}

function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return (content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('');
}

function partsToBlocks(content: ChatMessage['content']): Block[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return (content ?? []).flatMap((p: ContentPart): Block[] => {
    if (p.type === 'text') return p.text ? [{ type: 'text', text: p.text }] : [];
    const url = p.image_url.url;
    const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
    return [data ? { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } } : { type: 'image', source: { type: 'url', url } }];
  });
}

/** OpenAI messages → Anthropic system text and alternating user/assistant turns. */
export function toAnthropicMessages(messages: ChatMessage[]): { system: string; messages: AnthropicMessage[] } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => textOf(m.content))
    .filter(Boolean)
    .join('\n\n');
  const out: AnthropicMessage[] = [];
  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    // Consecutive turns of one role are merged (tool results follow as one user turn)
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: textOf(m.content) || '(empty)' }]);
    } else if (m.role === 'assistant') {
      const blocks = partsToBlocks(m.content);
      for (const c of m.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = c.function.arguments ? JSON.parse(c.function.arguments) : {};
        } catch {
          input = {};
        }
        blocks.push({ type: 'tool_use', id: c.id, name: c.function.name, input });
      }
      push('assistant', blocks);
    } else {
      push('user', partsToBlocks(m.content));
    }
  }
  // The conversation must start with a user turn
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: [{ type: 'text', text: '(continued)' }] });
  return { system, messages: out };
}

export function toAnthropicRequest(request: ChatCompletionRequest, stream: boolean): Record<string, unknown> {
  const { system, messages } = toAnthropicMessages(request.messages);
  const budget = request.reasoning_effort ? THINKING_BUDGET[request.reasoning_effort] : undefined;
  let maxTokens = request.max_tokens ?? DEFAULT_MAX_TOKENS;
  if (budget && maxTokens <= budget) maxTokens = budget + DEFAULT_MAX_TOKENS;
  const body: Record<string, unknown> = { model: request.model, max_tokens: maxTokens, messages, stream };
  if (system) body.system = system;
  if (budget) body.thinking = { type: 'enabled', budget_tokens: budget };
  // Extended thinking only allows the default temperature
  else if (request.temperature !== undefined) body.temperature = Math.min(1, request.temperature);
  if (request.top_p !== undefined && !budget) body.top_p = request.top_p;
  if (request.tools?.length) {
    body.tools = request.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description ?? '',
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }));
    const choice = request.tool_choice;
    if (choice === 'none') body.tool_choice = { type: 'none' };
    else if (choice && typeof choice === 'object') body.tool_choice = { type: 'tool', name: choice.function.name };
    else body.tool_choice = { type: 'auto' };
  }
  return body;
}

/** The parts of Anthropic's stream events we read. */
interface StreamEvent {
  type: string;
  index: number;
  message?: { usage?: { input_tokens?: number } };
  content_block?: { type: string; id: string; name: string };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
  usage?: { output_tokens?: number };
  error?: { message?: string };
}

const endReason = (stop: string | null | undefined): 'stop' | 'tool_calls' | 'length' =>
  stop === 'tool_use' ? 'tool_calls' : stop === 'max_tokens' ? 'length' : 'stop';

export class AnthropicProvider implements IAPIProvider {
  constructor(private config: AnthropicConfig) {}

  private get base(): string {
    return (this.config.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '').replace(/\/v1$/, '');
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', 'x-api-key': this.config.apiKey, 'anthropic-version': API_VERSION };
  }

  private get fetch(): typeof fetch {
    return this.config.http?.fetch ?? fetch;
  }

  getProviderType(): ProviderType {
    return 'anthropic';
  }

  getCapabilities(): ProviderCapabilities {
    return { supportsFileUpload: false, supportsToolCalling: true, supportsStreaming: true, requiresCustomHeaders: true };
  }

  async getModels(): Promise<Model[]> {
    const res = await this.fetch(`${this.base}/v1/models?limit=1000`, { headers: this.headers() });
    if (!res.ok) throw new Error(await readErrorMessage(res));
    const json = (await res.json()) as { data?: Array<{ id: string; display_name?: string; created_at?: string }> };
    return (json.data ?? []).map((m) => ({
      id: m.id,
      name: m.display_name || m.id,
      object: 'model',
      created: m.created_at ? Math.floor(Date.parse(m.created_at) / 1000) : 0,
      owned_by: 'anthropic',
    }));
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const res = await this.fetch(`${this.base}/v1/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(toAnthropicRequest(request, false)),
    });
    if (!res.ok) throw new Error(await readErrorMessage(res));
    const json = (await res.json()) as {
      id: string;
      model: string;
      content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown; thinking?: string }>;
      stop_reason: string;
      usage?: { input_tokens: number; output_tokens: number };
    };
    const text = json.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    const reasoning = json.content.filter((b) => b.type === 'thinking').map((b) => b.thinking ?? '').join('');
    const toolCalls: ToolCall[] = json.content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id!, type: 'function', function: { name: b.name!, arguments: JSON.stringify(b.input ?? {}) } }));
    return {
      id: json.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: json.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text, ...(reasoning ? { reasoning } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
          finish_reason: endReason(json.stop_reason),
        },
      ],
      ...(json.usage
        ? { usage: { prompt_tokens: json.usage.input_tokens, completion_tokens: json.usage.output_tokens, total_tokens: json.usage.input_tokens + json.usage.output_tokens } }
        : {}),
    } as ChatCompletionResponse;
  }

  async streamChatCompletion(request: ChatCompletionRequest, callbacks: StreamCallbacks, abortSignal?: AbortSignal): Promise<void> {
    const cb = onceTerminal(callbacks);
    try {
      const res = await this.fetch(`${this.base}/v1/messages`, {
        method: 'POST',
        headers: { ...this.headers(), Accept: 'text/event-stream' },
        body: JSON.stringify(toAnthropicRequest(request, true)),
        signal: abortSignal,
      });
      if (!res.ok) throw new Error(await readErrorMessage(res));
      if (!res.body) throw new Error('No response body received');

      const tools = new Map<number, { id: string; name: string; json: string }>();
      const usage: MessageUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      let stop: string | null = null;
      let failure: Error | null = null;

      const parser = createParser((event: ParsedEvent | ReconnectInterval) => {
        if (event.type !== 'event') return;
        let data: StreamEvent;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        switch (data.type) {
          case 'message_start':
            usage.prompt_tokens = data.message?.usage?.input_tokens ?? 0;
            break;
          case 'content_block_start':
            if (data.content_block?.type === 'tool_use') {
              tools.set(data.index, { id: data.content_block.id, name: data.content_block.name, json: '' });
            }
            break;
          case 'content_block_delta': {
            const d = data.delta ?? {};
            if (d.type === 'text_delta' && d.text) cb.onChunk(d.text);
            else if (d.type === 'thinking_delta' && d.thinking) cb.onReasoning?.(d.thinking);
            else if (d.type === 'input_json_delta') {
              const t = tools.get(data.index);
              if (t) t.json += d.partial_json ?? '';
            }
            break;
          }
          case 'message_delta':
            if (data.delta?.stop_reason) stop = data.delta.stop_reason;
            if (data.usage?.output_tokens !== undefined) usage.completion_tokens = data.usage.output_tokens;
            break;
          case 'error':
            failure = new Error(data.error?.message ?? 'The Anthropic stream failed.');
            break;
        }
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
        if (failure) break;
      }
      if (failure) throw failure;

      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
      cb.onUsage?.(usage);
      const calls: ToolCall[] = [...tools.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, t]) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.json || '{}' } }));
      if (calls.length) cb.onToolCalls?.(calls);
      cb.onComplete(calls.length ? 'tool_calls' : endReason(stop));
    } catch (error) {
      if (isAbortError(error) || abortSignal?.aborted) cb.onComplete('aborted');
      else cb.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.getModels();
      return true;
    } catch {
      return false;
    }
  }

  updateConfig(config: AnthropicConfig): void {
    this.config = config;
  }
}

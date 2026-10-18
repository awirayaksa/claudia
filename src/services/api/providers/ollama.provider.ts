/**
 * Native Ollama provider: /api/chat (newline-delimited JSON stream) with
 * tools, images and thinking, and /api/tags for the model list. Takes and
 * returns the OpenAI-shaped requests the rest of Claudia uses.
 */
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  Model,
  ProviderCapabilities,
  ProviderHttp,
  ProviderType,
} from '../../../types/api.types';
import type { ToolCall } from '../../../types/message.types';
import type { IAPIProvider } from '../provider.interface';
import { isAbortError, onceTerminal, readErrorMessage, type StreamCallbacks } from '../sse-parser';

export interface OllamaConfig {
  /** Default http://localhost:11434 */
  baseUrl?: string;
  /** For Ollama behind a proxy that wants one. */
  apiKey?: string;
  http?: ProviderHttp;
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
}

/** The parts of an /api/chat response (or stream line) we read. */
interface OllamaChatResponse {
  model?: string;
  message?: { content?: string; thinking?: string; tool_calls?: Array<{ function: { name: string; arguments: unknown } }> };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export function toOllamaMessages(messages: ChatMessage[]): OllamaMessage[] {
  const names = new Map<string, string>();
  return messages.map((m) => {
    let content = '';
    const images: string[] = [];
    if (typeof m.content === 'string') content = m.content;
    else {
      for (const p of m.content ?? []) {
        if (p.type === 'text') content += p.text;
        else {
          const data = /^data:[^;,]+;base64,(.*)$/s.exec(p.image_url.url);
          if (data) images.push(data[1]);
        }
      }
    }
    const out: OllamaMessage = { role: m.role, content, ...(images.length ? { images } : {}) };
    if (m.role === 'assistant' && m.tool_calls?.length) {
      out.tool_calls = m.tool_calls.map((c) => {
        names.set(c.id, c.function.name);
        let args: Record<string, unknown> = {};
        try {
          args = c.function.arguments ? JSON.parse(c.function.arguments) : {};
        } catch {
          args = {};
        }
        return { function: { name: c.function.name, arguments: args } };
      });
    }
    if (m.role === 'tool') out.tool_name = names.get(m.tool_call_id ?? '') ?? m.name;
    return out;
  });
}

export function toOllamaRequest(request: ChatCompletionRequest, stream: boolean): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (request.temperature !== undefined) options.temperature = request.temperature;
  if (request.top_p !== undefined) options.top_p = request.top_p;
  if (request.max_tokens !== undefined) options.num_predict = request.max_tokens;
  if (request.frequency_penalty !== undefined) options.frequency_penalty = request.frequency_penalty;
  if (request.presence_penalty !== undefined) options.presence_penalty = request.presence_penalty;
  return {
    model: request.model,
    messages: toOllamaMessages(request.messages),
    stream,
    ...(request.tools?.length && request.tool_choice !== 'none' ? { tools: request.tools } : {}),
    ...(Object.keys(options).length ? { options } : {}),
    // gpt-oss takes a level, other thinking models true/false
    ...(request.reasoning_effort
      ? { think: /gpt-oss/i.test(request.model) ? (request.reasoning_effort === 'xhigh' ? 'high' : request.reasoning_effort === 'minimal' ? 'low' : request.reasoning_effort) : true }
      : {}),
  };
}

export class OllamaProvider implements IAPIProvider {
  constructor(private config: OllamaConfig) {}

  private get base(): string {
    return (this.config.baseUrl || 'http://localhost:11434').replace(/\/+$/, '').replace(/\/(api|v1)$/, '');
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}) };
  }

  private get fetch(): typeof fetch {
    return this.config.http?.fetch ?? fetch;
  }

  getProviderType(): ProviderType {
    return 'ollama';
  }

  getCapabilities(): ProviderCapabilities {
    return { supportsFileUpload: false, supportsToolCalling: true, supportsStreaming: true, requiresCustomHeaders: false };
  }

  async getModels(): Promise<Model[]> {
    const res = await this.fetch(`${this.base}/api/tags`, { headers: this.headers() });
    if (!res.ok) throw new Error(await readErrorMessage(res));
    const json = (await res.json()) as { models?: Array<{ name: string; model?: string; modified_at?: string }> };
    return (json.models ?? []).map((m) => ({
      id: m.model ?? m.name,
      name: m.name,
      object: 'model',
      created: m.modified_at ? Math.floor(Date.parse(m.modified_at) / 1000) : 0,
      owned_by: 'ollama',
    }));
  }

  private toolCalls(raw: Array<{ function: { name: string; arguments: unknown } }> | undefined, offset: number): ToolCall[] {
    return (raw ?? []).map((c, i) => ({
      id: `call_${offset + i}`,
      type: 'function',
      function: { name: c.function.name, arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}) },
    }));
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const res = await this.fetch(`${this.base}/api/chat`, { method: 'POST', headers: this.headers(), body: JSON.stringify(toOllamaRequest(request, false)) });
    if (!res.ok) throw new Error(await readErrorMessage(res));
    const json = (await res.json()) as OllamaChatResponse;
    const calls = this.toolCalls(json.message?.tool_calls, 0);
    const prompt = json.prompt_eval_count ?? 0;
    const completion = json.eval_count ?? 0;
    return {
      id: `ollama-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: json.model ?? request.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: json.message?.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) },
          finish_reason: calls.length ? 'tool_calls' : json.done_reason === 'length' ? 'length' : 'stop',
        },
      ],
      usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
    } as ChatCompletionResponse;
  }

  async streamChatCompletion(request: ChatCompletionRequest, callbacks: StreamCallbacks, abortSignal?: AbortSignal): Promise<void> {
    const cb = onceTerminal(callbacks);
    try {
      const res = await this.fetch(`${this.base}/api/chat`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(toOllamaRequest(request, true)),
        signal: abortSignal,
      });
      if (!res.ok) throw new Error(await readErrorMessage(res));
      if (!res.body) throw new Error('No response body received');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const calls: ToolCall[] = [];
      let doneReason: string | null = null;
      const handle = (line: string) => {
        if (!line.trim()) return;
        const json = JSON.parse(line);
        if (json.error) throw new Error(String(json.error));
        const msg = json.message ?? {};
        if (msg.thinking) cb.onReasoning?.(msg.thinking);
        if (msg.content) cb.onChunk(msg.content);
        if (msg.tool_calls?.length) calls.push(...this.toolCalls(msg.tool_calls, calls.length));
        if (json.done) {
          doneReason = json.done_reason ?? 'stop';
          const prompt = json.prompt_eval_count ?? 0;
          const completion = json.eval_count ?? 0;
          cb.onUsage?.({ prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion });
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          handle(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
      handle(buf + decoder.decode());
      if (calls.length) cb.onToolCalls?.(calls);
      cb.onComplete(calls.length ? 'tool_calls' : doneReason === 'length' ? 'length' : 'stop');
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

  updateConfig(config: OllamaConfig): void {
    this.config = config;
  }
}

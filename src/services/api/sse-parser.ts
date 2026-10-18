/**
 * The one OpenAI-compatible chat-completion stream parser, shared by every
 * provider (desktop renderer and web server). Uses only `fetch` and
 * `eventsource-parser`, so it runs in the browser and on Node.
 */
import { createParser, ParsedEvent, ReconnectInterval } from 'eventsource-parser';
import type { ToolCall } from '../../types/message.types';
import type { MessageUsage } from '../../types/statistics.types';

/** Why a stream ended. */
export type StreamEndReason = 'stop' | 'tool_calls' | 'length' | 'aborted' | 'error';

export interface StreamCallbacks {
  onChunk: (content: string) => void;
  /**
   * The stream ended without an error. Called at most once, and never
   * together with `onError`.
   */
  onComplete: (reason?: Exclude<StreamEndReason, 'error'>) => void;
  /** The request or stream failed. Called at most once, and never together with `onComplete`. */
  onError: (error: Error) => void;
  /** Every tool call of the turn, once, after the model finished emitting them. */
  onToolCalls?: (toolCalls: ToolCall[]) => void;
  onReasoning?: (reasoning: string) => void;
  onUsage?: (usage: MessageUsage) => void;
}

/** Map an OpenAI `finish_reason` onto a StreamEndReason. */
export function toEndReason(finishReason: string | null | undefined, hadToolCalls: boolean): 'stop' | 'tool_calls' | 'length' {
  if (finishReason === 'tool_calls' || finishReason === 'function_call') return 'tool_calls';
  if (finishReason === 'length') return 'length';
  if (!finishReason && hadToolCalls) return 'tool_calls';
  return 'stop';
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

type ParserHandlers = Pick<StreamCallbacks, 'onChunk' | 'onReasoning' | 'onUsage' | 'onToolCalls'>;

/**
 * Incremental parser for OpenAI-compatible SSE. Feed it decoded text; call
 * `finish()` when the body ends.
 */
export class OpenAIStreamParser {
  private readonly toolCalls = new Map<number, ToolCall>();
  private toolCallsEmitted = false;
  private finishReason: string | null = null;
  private doneMarker = false;
  private readonly parser;

  constructor(private readonly handlers: ParserHandlers) {
    this.parser = createParser((event: ParsedEvent | ReconnectInterval) => {
      if (event.type === 'event') this.onData(event.data);
    });
  }

  /** True once the `[DONE]` marker arrived. */
  get done(): boolean {
    return this.doneMarker;
  }

  feed(text: string): void {
    if (!this.doneMarker) this.parser.feed(text);
  }

  /** Emit tool calls still pending and report why the stream ended. */
  finish(): 'stop' | 'tool_calls' | 'length' {
    this.emitToolCalls();
    return toEndReason(this.finishReason, this.toolCalls.size > 0);
  }

  private onData(data: string): void {
    // A chunk can hold frames after the marker; they don't belong to this reply
    if (this.doneMarker) return;
    if (data === '[DONE]') {
      this.doneMarker = true;
      return;
    }

    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      return; // skip malformed frames and keep going
    }

    const choice = json.choices?.[0];
    const delta = choice?.delta;

    if (delta?.content) this.handlers.onChunk(delta.content);

    const reasoning = delta?.reasoning ?? delta?.reasoning_content;
    if (reasoning) this.handlers.onReasoning?.(reasoning);

    if (json.usage) this.handlers.onUsage?.(json.usage);

    if (Array.isArray(delta?.tool_calls)) {
      for (const d of delta.tool_calls) this.accumulateToolCall(d);
    }

    if (choice?.finish_reason) {
      this.finishReason = choice.finish_reason;
      // Usage can still follow in a later chunk, so only the tool calls go now
      this.emitToolCalls();
    }
  }

  private accumulateToolCall(d: any): void {
    const index: number = d.index ?? 0;
    const existing = this.toolCalls.get(index);
    if (!existing) {
      this.toolCalls.set(index, {
        id: d.id || '',
        type: d.type || 'function',
        function: { name: d.function?.name || '', arguments: d.function?.arguments || '' },
      });
      return;
    }
    if (d.function?.arguments) existing.function.arguments += d.function.arguments;
    if (d.id && !existing.id) existing.id = d.id;
    if (d.function?.name && !existing.function.name) existing.function.name = d.function.name;
  }

  private emitToolCalls(): void {
    if (this.toolCallsEmitted || this.toolCalls.size === 0) return;
    this.toolCallsEmitted = true;
    this.handlers.onToolCalls?.(
      [...this.toolCalls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => ({
          ...tc,
          // Empty arguments are not valid JSON; send an empty object instead
          function: { ...tc.function, arguments: tc.function.arguments || '{}' },
        }))
    );
  }
}

/** Best error message from a failed HTTP response. */
export async function readErrorMessage(response: Response): Promise<string> {
  const fallback = `HTTP ${response.status}: ${response.statusText}`;
  try {
    const text = await response.text();
    try {
      const data = JSON.parse(text);
      return data.error?.message || data.message || data.detail || fallback;
    } catch {
      return text.trim() ? `${fallback} - ${text.trim().slice(0, 300)}` : fallback;
    }
  } catch {
    return fallback;
  }
}

/** Wraps callbacks so exactly one terminal callback runs. */
export function onceTerminal(callbacks: StreamCallbacks): StreamCallbacks & { readonly ended: boolean } {
  let ended = false;
  return {
    ...callbacks,
    get ended() {
      return ended;
    },
    onComplete: (reason) => {
      if (ended) return;
      ended = true;
      callbacks.onComplete(reason);
    },
    onError: (error) => {
      if (ended) return;
      ended = true;
      callbacks.onError(error);
    },
  };
}

/** Read an OpenAI-compatible SSE body to the end. */
export async function readOpenAIStream(
  body: ReadableStream<Uint8Array>,
  handlers: ParserHandlers
): Promise<'stop' | 'tool_calls' | 'length'> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new OpenAIStreamParser(handlers);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
      if (parser.done) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    parser.feed(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  return parser.finish();
}

export interface OpenAIStreamRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
  /** Custom fetch (e.g. the server's SSRF-guarded fetch). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * POST a streaming chat completion and drive `callbacks`. Exactly one of
 * `onComplete(reason)` or `onError(error)` runs. Resolves with the reason the
 * stream ended; never rejects.
 */
export async function streamOpenAICompatible(
  req: OpenAIStreamRequest,
  callbacks: StreamCallbacks
): Promise<StreamEndReason> {
  const cb = onceTerminal(callbacks);
  try {
    const response = await (req.fetchImpl ?? fetch)(req.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...req.headers },
      body: JSON.stringify(req.body),
      signal: req.signal,
    });

    if (!response.ok) {
      throw new Error(await readErrorMessage(response));
    }
    if (!response.body) {
      throw new Error('No response body received');
    }

    const reason = await readOpenAIStream(response.body, cb);
    cb.onComplete(reason);
    return reason;
  } catch (error) {
    if (isAbortError(error) || req.signal?.aborted) {
      cb.onComplete('aborted');
      return 'aborted';
    }
    cb.onError(error instanceof Error ? error : new Error('Unknown streaming error'));
    return 'error';
  }
}

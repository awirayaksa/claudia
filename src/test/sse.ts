import { vi } from 'vitest';

/** One SSE frame: `data:` only, or a named `event:` plus `data:`. */
export type SSEFrame = string | { event: string; data: string };

export function sseBody(frames: SSEFrame[]): string {
  return frames
    .map((f) => (typeof f === 'string' ? `data: ${f}\n\n` : `event: ${f.event}\ndata: ${f.data}\n\n`))
    .join('');
}

/**
 * A Response whose body streams `text` in small pieces, so parsers are
 * exercised across chunk boundaries.
 */
export function streamingResponse(text: string, chunkSize = 7, init?: ResponseInit): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' }, ...init });
}

/** OpenAI-style chunk JSON with a single choice. */
export function openAIChunk(
  delta: Record<string, unknown>,
  extra: { finish_reason?: string | null; usage?: Record<string, number> } = {}
): string {
  return JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: extra.finish_reason ?? null }],
    ...(extra.usage ? { usage: extra.usage } : {}),
  });
}

/** Install a fetch mock that answers each call with the next queued response. */
export function mockFetchSequence(responses: Array<Response | (() => Response)>) {
  const queue = [...responses];
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const next = queue.shift();
    if (!next) throw new Error('Unexpected fetch call');
    return typeof next === 'function' ? next() : next;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Collects every StreamCallbacks invocation for assertions. */
export function recordingCallbacks() {
  const rec = {
    chunks: [] as string[],
    reasoning: [] as string[],
    usage: [] as unknown[],
    toolCalls: [] as unknown[][],
    completeCount: 0,
    reasons: [] as Array<string | undefined>,
    errors: [] as Error[],
  };
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const callbacks = {
    onChunk: (c: string) => rec.chunks.push(c),
    onReasoning: (r: string) => rec.reasoning.push(r),
    onUsage: (u: unknown) => rec.usage.push(u),
    onToolCalls: (t: unknown[]) => rec.toolCalls.push(t),
    onComplete: (reason?: string) => {
      rec.completeCount++;
      rec.reasons.push(reason);
      resolveDone();
    },
    onError: (e: Error) => {
      rec.errors.push(e);
      resolveDone();
    },
  };
  return { rec, callbacks, done };
}

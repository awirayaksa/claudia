/**
 * Characterization tests for the OpenAI-compatible stream parsers.
 *
 * Every provider is fed the same scripted SSE stream, so the tests pin down
 * the behaviour they share today: text, reasoning, usage and tool-call
 * accumulation, HTTP errors and aborts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { streamChatCompletion } from '../streaming.service';
import { CustomProvider } from './custom.provider';
import { OpenRouterProvider } from './openrouter.provider';
import { OpencodeGoProvider } from './opencode-go.provider';
import { OpenWebUIProvider } from './openwebui.provider';
import type { IAPIProvider } from '../provider.interface';
import type { StreamCallbacks } from '../streaming.service';
import type { ChatCompletionRequest } from '../../../types/api.types';
import {
  sseBody,
  streamingResponse,
  openAIChunk,
  mockFetchSequence,
  recordingCallbacks,
} from '../../../test/sse';

type StreamFn = (req: ChatCompletionRequest, cb: StreamCallbacks, signal?: AbortSignal) => Promise<void>;

const request: ChatCompletionRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hi' }],
};

const providers: Array<{ name: string; url: string; stream: () => StreamFn }> = [
  {
    name: 'streaming.service (Open WebUI)',
    url: 'http://owui.test/api/chat/completions',
    stream: () => (req, cb, signal) => streamChatCompletion('http://owui.test/api/', 'k', req, cb, signal),
  },
  {
    name: 'OpenWebUIProvider',
    url: 'http://owui.test/api/chat/completions',
    stream: () => {
      const p: IAPIProvider = new OpenWebUIProvider({ baseUrl: 'http://owui.test', apiKey: 'k', selectedModel: 'm' });
      return (req, cb, signal) => p.streamChatCompletion(req, cb, signal);
    },
  },
  {
    name: 'CustomProvider',
    url: 'http://custom.test/v1/chat/completions',
    stream: () => {
      const p = new CustomProvider({ baseUrl: 'http://custom.test/v1/', apiKey: 'k', selectedModel: 'm' });
      return (req, cb, signal) => p.streamChatCompletion(req, cb, signal);
    },
  },
  {
    name: 'OpenRouterProvider',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    stream: () => {
      const p = new OpenRouterProvider({ apiKey: 'k', selectedModel: 'm' });
      return (req, cb, signal) => p.streamChatCompletion(req, cb, signal);
    },
  },
  {
    name: 'OpencodeGoProvider (openai)',
    url: 'https://go.test/v1/chat/completions',
    stream: () => {
      const p = new OpencodeGoProvider({
        baseUrl: 'https://go.test/v1',
        apiKey: 'k',
        selectedModel: 'm',
        apiCompatibility: 'openai',
      });
      return (req, cb, signal) => p.streamChatCompletion(req, cb, signal);
    },
  },
];

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe.each(providers)('$name stream parsing', ({ url, stream }) => {
  it('streams text, reasoning and usage, hitting the expected endpoint', async () => {
    const fetchMock = mockFetchSequence([
      streamingResponse(
        sseBody([
          openAIChunk({ role: 'assistant', reasoning_content: 'think ' }),
          openAIChunk({ reasoning: 'more' }),
          openAIChunk({ content: 'Hello' }),
          openAIChunk({ content: ', world' }),
          openAIChunk({}, { finish_reason: 'stop' }),
          JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } }),
          '[DONE]',
        ])
      ),
    ]);
    const { rec, callbacks } = recordingCallbacks();

    await stream()(request, callbacks);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(url);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.stream).toBe(true);
    expect(body.model).toBe('test-model');

    expect(rec.chunks.join('')).toBe('Hello, world');
    expect(rec.reasoning.join('')).toBe('think more');
    expect(rec.usage).toContainEqual({ prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 });
    expect(rec.toolCalls).toHaveLength(0);
    expect(rec.errors).toHaveLength(0);
    // [DONE] and the end of the body used to complete twice
    expect(rec.completeCount).toBe(1);
    expect(rec.reasons).toEqual(['stop']);
  });

  it('reports usage once even when it rides on the finish chunk', async () => {
    mockFetchSequence([
      streamingResponse(
        sseBody([
          openAIChunk({ content: 'x' }),
          openAIChunk({}, { finish_reason: 'length', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }),
          '[DONE]',
        ])
      ),
    ]);
    const { rec, callbacks } = recordingCallbacks();

    await stream()(request, callbacks);

    expect(rec.usage).toEqual([{ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }]);
    expect(rec.reasons).toEqual(['length']);
  });

  it('completes once when the body ends without [DONE]', async () => {
    mockFetchSequence([streamingResponse(sseBody([openAIChunk({ content: 'a' }, { finish_reason: 'stop' })]))]);
    const { rec, callbacks } = recordingCallbacks();

    await stream()(request, callbacks);

    expect(rec.chunks).toEqual(['a']);
    expect(rec.reasons).toEqual(['stop']);
  });

  it('accumulates streamed tool-call deltas and emits them once on finish_reason', async () => {
    mockFetchSequence([
      streamingResponse(
        sseBody([
          openAIChunk({
            tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '' } }],
          }),
          openAIChunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
          openAIChunk({ tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }),
          openAIChunk({ tool_calls: [{ index: 1, id: 'call_b', function: { name: 'list_dir' } }] }),
          openAIChunk({}, { finish_reason: 'tool_calls' }),
          '[DONE]',
        ])
      ),
    ]);
    const { rec, callbacks } = recordingCallbacks();

    await stream()(request, callbacks);

    expect(rec.reasons).toEqual(['tool_calls']);
    expect(rec.toolCalls).toHaveLength(1);
    expect(rec.toolCalls[0]).toEqual([
      { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
      // Empty arguments are normalised to '{}'
      { id: 'call_b', type: 'function', function: { name: 'list_dir', arguments: '{}' } },
    ]);
  });

  it('skips malformed JSON frames and keeps going', async () => {
    mockFetchSequence([
      streamingResponse(sseBody(['{not json', openAIChunk({ content: 'ok' }), '[DONE]'])),
    ]);
    const { rec, callbacks } = recordingCallbacks();

    await stream()(request, callbacks);

    expect(rec.chunks).toEqual(['ok']);
    expect(rec.errors).toHaveLength(0);
  });

  it('reports HTTP errors through onError using the error body message', async () => {
    mockFetchSequence([
      new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401, statusText: 'Unauthorized' }),
    ]);
    const { rec, callbacks } = recordingCallbacks();

    await stream()(request, callbacks);

    expect(rec.errors.map((e) => e.message)).toEqual(['bad key']);
    expect(rec.completeCount).toBe(0);
  });

  it('treats an abort as completion, not an error', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        controller.abort();
        if (init?.signal?.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        throw new Error('signal not forwarded');
      })
    );
    const { rec, callbacks } = recordingCallbacks();

    await stream()(request, callbacks, controller.signal);

    expect(rec.errors).toHaveLength(0);
    expect(rec.reasons).toEqual(['aborted']);
  });
});

describe('OpenRouterProvider request shape', () => {
  it('translates reasoning_effort into reasoning.effort', async () => {
    const fetchMock = mockFetchSequence([streamingResponse(sseBody(['[DONE]']))]);
    const p = new OpenRouterProvider({ apiKey: 'k', selectedModel: 'm', siteName: 'Claudia' });
    const { callbacks } = recordingCallbacks();

    await p.streamChatCompletion({ ...request, reasoning_effort: 'high' }, callbacks);

    const init = fetchMock.mock.calls[0][1]!;
    const body = JSON.parse(String(init.body));
    expect(body.reasoning).toEqual({ effort: 'high' });
    expect(body.reasoning_effort).toBeUndefined();
    expect((init.headers as Record<string, string>)['X-Title']).toBe('Claudia');
  });
});

describe('OpencodeGoProvider (anthropic) stream parsing', () => {
  const make = () =>
    new OpencodeGoProvider({
      baseUrl: 'https://go.test',
      apiKey: 'k',
      selectedModel: 'm',
      apiCompatibility: 'anthropic',
    });

  it('maps Anthropic events to text, reasoning and usage', async () => {
    const fetchMock = mockFetchSequence([
      streamingResponse(
        sseBody([
          { event: 'message_start', data: JSON.stringify({ type: 'message_start' }) },
          {
            event: 'content_block_start',
            data: JSON.stringify({ content_block: { type: 'thinking', thinking: 'Let me ' } }),
          },
          {
            event: 'content_block_delta',
            data: JSON.stringify({ delta: { type: 'thinking_delta', thinking: 'think' } }),
          },
          { event: 'content_block_delta', data: JSON.stringify({ delta: { type: 'text_delta', text: 'Answer' } }) },
          {
            event: 'message_delta',
            data: JSON.stringify({ usage: { input_tokens: 10, output_tokens: 4 } }),
          },
          { event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) },
        ])
      ),
    ]);
    const { rec, callbacks } = recordingCallbacks();

    await make().streamChatCompletion(
      {
        model: 'opencode-go/deepseek-v4-pro',
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hi' },
        ],
        reasoning_effort: 'low',
      },
      callbacks
    );

    expect(String(fetchMock.mock.calls[0][0])).toBe('https://go.test/v1/messages');
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.model).toBe('deepseek-v4-pro');
    expect(body.system).toBe('sys');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.output_config).toEqual({ effort: 'low' });

    expect(rec.reasoning.join('')).toBe('Let me think');
    expect(rec.chunks.join('')).toBe('Answer');
    expect(rec.usage).toEqual([{ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }]);
    expect(rec.reasons).toEqual(['stop']);
  });

  it('completes once when the stream ends without message_stop', async () => {
    mockFetchSequence([
      streamingResponse(
        sseBody([{ event: 'content_block_delta', data: JSON.stringify({ delta: { type: 'text_delta', text: 'x' } }) }])
      ),
    ]);
    const { rec, callbacks } = recordingCallbacks();

    await make().streamChatCompletion(request, callbacks);

    expect(rec.chunks).toEqual(['x']);
    expect(rec.completeCount).toBe(1);
  });
});

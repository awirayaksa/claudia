/**
 * opencode Go: the session header on every chat request (#68), models from the
 * service's own list (#69), and a connection check that really chats (#70).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpencodeGoProvider, OPENCODE_SESSION_HEADER } from './opencode-go.provider';
import type { OpencodeGoConfig } from '../../../types/api.types';
import { sseBody, streamingResponse, openAIChunk, mockFetchSequence, recordingCallbacks } from '../../../test/sse';

const make = (config: Partial<OpencodeGoConfig> = {}) =>
  new OpencodeGoProvider({
    baseUrl: 'https://go.test',
    apiKey: 'k',
    selectedModel: 'kimi-k2.7-code',
    apiCompatibility: 'openai',
    ...config,
  });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const openAIReply = () =>
  json({ id: 'c', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
const anthropicReply = () => json({ id: 'm', model: 'm', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
const openAIStream = () => streamingResponse(sseBody([openAIChunk({ content: 'ok' }, { finish_reason: 'stop' }), '[DONE]']));
const anthropicStream = () =>
  streamingResponse(
    sseBody([
      { event: 'content_block_delta', data: JSON.stringify({ delta: { type: 'text_delta', text: 'ok' } }) },
      { event: 'message_stop', data: '{}' },
    ])
  );

type Call = [RequestInfo | URL, RequestInit | undefined];
const headersOf = (call: Call) => (call[1]?.headers ?? {}) as Record<string, string>;
const bodyOf = (call: Call) => JSON.parse(String(call[1]?.body));

const request = { model: 'kimi-k2.7-code', messages: [{ role: 'user' as const, content: 'hi' }] };

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('session header (#68)', () => {
  const paths = [
    {
      name: 'OpenAI format, not streaming',
      compat: 'openai' as const,
      reply: openAIReply,
      send: (p: OpencodeGoProvider, sessionId?: string) => p.chatCompletion(request, { sessionId }),
    },
    {
      name: 'Anthropic format, not streaming',
      compat: 'anthropic' as const,
      reply: anthropicReply,
      send: (p: OpencodeGoProvider, sessionId?: string) => p.chatCompletion(request, { sessionId }),
    },
    {
      name: 'OpenAI format, streaming',
      compat: 'openai' as const,
      reply: openAIStream,
      send: async (p: OpencodeGoProvider, sessionId?: string) => {
        const { rec, callbacks, done } = recordingCallbacks();
        await p.streamChatCompletion(request, callbacks, undefined, undefined, { sessionId });
        await done;
        expect(rec.errors).toEqual([]);
      },
    },
    {
      name: 'Anthropic format, streaming',
      compat: 'anthropic' as const,
      reply: anthropicStream,
      send: async (p: OpencodeGoProvider, sessionId?: string) => {
        const { rec, callbacks, done } = recordingCallbacks();
        await p.streamChatCompletion(request, callbacks, undefined, undefined, { sessionId });
        await done;
        expect(rec.errors).toEqual([]);
      },
    },
  ];

  for (const path of paths) {
    describe(path.name, () => {
      it('sends the conversation id, the same on every request of a conversation', async () => {
        const fetchMock = mockFetchSequence([path.reply(), path.reply(), path.reply()]);
        const p = make({ apiCompatibility: path.compat });

        await path.send(p, 'conv-a');
        await path.send(p, 'conv-a');
        await path.send(p, 'conv-b');

        const sessions = fetchMock.mock.calls.map((c) => headersOf(c as Call)[OPENCODE_SESSION_HEADER]);
        expect(sessions).toEqual(['conv-a', 'conv-a', 'conv-b']);
      });

      it('keeps session metadata out of the JSON body', async () => {
        const fetchMock = mockFetchSequence([path.reply()]);
        await path.send(make({ apiCompatibility: path.compat }), 'conv-a');

        const raw = String(fetchMock.mock.calls[0][1]?.body);
        expect(raw).not.toContain('conv-a');
        expect(Object.keys(bodyOf(fetchMock.mock.calls[0] as Call))).not.toContain('sessionId');
      });

      it('gives a request outside a conversation a session of its own', async () => {
        const fetchMock = mockFetchSequence([path.reply(), path.reply()]);
        const p = make({ apiCompatibility: path.compat });

        await path.send(p);
        await path.send(p);

        const [a, b] = fetchMock.mock.calls.map((c) => headersOf(c as Call)[OPENCODE_SESSION_HEADER]);
        expect(a).toMatch(/^[0-9a-f-]{36}$/);
        expect(b).toMatch(/^[0-9a-f-]{36}$/);
        expect(a).not.toBe(b);
      });
    });
  }

  it('names the client in User-Agent where it is configured (the server)', async () => {
    const fetchMock = mockFetchSequence([openAIReply()]);
    await make({ userAgent: 'Claudia-Web/1.2.3' }).chatCompletion(request, { sessionId: 's' });
    expect(headersOf(fetchMock.mock.calls[0] as Call)['User-Agent']).toBe('Claudia-Web/1.2.3');
  });

  it('sets no User-Agent without one (the desktop sets it in its main process)', async () => {
    const fetchMock = mockFetchSequence([openAIReply()]);
    await make().chatCompletion(request, { sessionId: 's' });
    expect(headersOf(fetchMock.mock.calls[0] as Call)).not.toHaveProperty('User-Agent');
  });
});

describe('getModels (#69)', () => {
  const listing = {
    object: 'list',
    data: [
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', type: 'chat', limit: { context: 262144 }, modalities: { output: ['text'] } },
      // Native API is Anthropic messages: still listed in OpenAI format, the service translates
      { id: 'minimax-m3', name: 'MiniMax M3', type: 'chat', api: { messages: {} }, modalities: { output: ['text'] } },
      { id: 'image-gen', type: 'image', modalities: { output: ['image'] } },
      { id: 'speaker', type: 'chat', modalities: { output: ['audio'] } },
      { name: 'no id' },
    ],
  };

  it('lists the text models the configured service returns, whatever the API format', async () => {
    const fetchMock = mockFetchSequence([json(listing), json(listing)]);

    const openai = await make({ baseUrl: 'https://go.test/v1/' }).getModels();
    const anthropic = await make({ apiCompatibility: 'anthropic' }).getModels();

    expect(String(fetchMock.mock.calls[0][0])).toBe('https://go.test/v1/models');
    expect(headersOf(fetchMock.mock.calls[0] as Call).Authorization).toBe('Bearer k');
    expect(openai.map((m) => m.id)).toEqual(['kimi-k2.7-code', 'minimax-m3']);
    expect(openai[0]).toMatchObject({ name: 'Kimi K2.7 Code', context_length: 262144 });
    expect(anthropic.map((m) => m.id)).toEqual(['kimi-k2.7-code', 'minimax-m3']);
  });

  it('accepts plain OpenAI-style entries', async () => {
    mockFetchSequence([json({ data: [{ id: 'glm-5.3', object: 'model', owned_by: 'zai' }] })]);
    expect(await make().getModels()).toEqual([
      { id: 'glm-5.3', name: 'glm-5.3', object: 'model', created: 0, owned_by: 'zai' },
    ]);
  });

  it('reports an HTTP error with the service reason', async () => {
    mockFetchSequence([json({ error: { message: 'Invalid API key' } }, 401)]);
    await expect(make().getModels()).rejects.toThrow(/Could not load models: .*Invalid API key/);
  });

  it('reports an answer that is not a model list', async () => {
    mockFetchSequence([json({ models: [] })]);
    await expect(make().getModels()).rejects.toThrow('did not return a model list');
  });

  it('reports a list without text models', async () => {
    mockFetchSequence([json({ data: [{ id: 'image-gen', type: 'image' }] })]);
    await expect(make().getModels()).rejects.toThrow('returned no text models');
  });

  it('reports an unreachable endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    await expect(make({ baseUrl: 'http://127.0.0.1:1' }).getModels()).rejects.toThrow(/Network Error/);
  });
});

describe('connection check (#70)', () => {
  it('sends a minimal chat with the session header to the given model', async () => {
    const fetchMock = mockFetchSequence([openAIReply()]);

    await make().verifyConnection('opencode-go/kimi-k2.7-code');

    const call = fetchMock.mock.calls[0] as Call;
    expect(String(call[0])).toBe('https://go.test/v1/chat/completions');
    expect(headersOf(call)[OPENCODE_SESSION_HEADER]).toBeTruthy();
    expect(bodyOf(call)).toMatchObject({ model: 'kimi-k2.7-code', stream: false, messages: [{ role: 'user', content: 'hi' }] });
  });

  it('fails on invalid credentials', async () => {
    mockFetchSequence([json({ error: { message: 'Invalid API key.' } }, 401)]);
    await expect(make({ apiKey: 'invalid-key' }).verifyConnection('kimi-k2.7-code')).rejects.toThrow('Invalid API key.');
  });

  it('fails on an invalid model', async () => {
    mockFetchSequence([json({ error: { message: 'Model not-a-model is not supported' } }, 400)]);
    await expect(make().verifyConnection('not-a-model')).rejects.toThrow('not-a-model is not supported');
  });

  it('fails on an unreachable endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    await expect(make({ baseUrl: 'http://127.0.0.1:1' }).verifyConnection('m')).rejects.toThrow(/Network Error/);
  });

  it('testConnection discovers a model when none is set, then chats with it', async () => {
    const fetchMock = mockFetchSequence([json({ data: [{ id: 'glm-5.3', type: 'chat' }] }), openAIReply()]);

    expect(await make({ selectedModel: '' }).testConnection()).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://go.test/v1/models');
    expect(bodyOf(fetchMock.mock.calls[1] as Call).model).toBe('glm-5.3');
  });

  it('testConnection is false when the chat fails, even though the models listed', async () => {
    mockFetchSequence([json({ error: { message: 'Invalid API key.' } }, 401)]);
    expect(await make().testConnection()).toBe(false);
  });
});

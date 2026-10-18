import { describe, it, expect, vi } from 'vitest';
import { OpenAIStreamParser, onceTerminal, readErrorMessage, streamOpenAICompatible, toEndReason } from './sse-parser';
import { mockFetchSequence, openAIChunk, recordingCallbacks, sseBody, streamingResponse } from '../../test/sse';

describe('toEndReason', () => {
  it('maps finish reasons', () => {
    expect(toEndReason('stop', false)).toBe('stop');
    expect(toEndReason('tool_calls', true)).toBe('tool_calls');
    expect(toEndReason('function_call', true)).toBe('tool_calls');
    expect(toEndReason('length', false)).toBe('length');
    expect(toEndReason('content_filter', false)).toBe('stop');
    // No finish_reason but tool calls arrived
    expect(toEndReason(null, true)).toBe('tool_calls');
    expect(toEndReason(undefined, false)).toBe('stop');
  });
});

describe('OpenAIStreamParser', () => {
  const make = () => {
    const out = { text: '', reasoning: '', usage: [] as unknown[], calls: [] as unknown[] };
    const parser = new OpenAIStreamParser({
      onChunk: (t) => (out.text += t),
      onReasoning: (r) => (out.reasoning += r),
      onUsage: (u) => out.usage.push(u),
      onToolCalls: (c) => out.calls.push(c),
    });
    return { parser, out };
  };

  it('handles frames split at any byte boundary', () => {
    const { parser, out } = make();
    const body = sseBody([openAIChunk({ content: 'Héllo ' }), openAIChunk({ content: 'wörld' }), '[DONE]']);
    for (let i = 0; i < body.length; i += 3) parser.feed(body.slice(i, i + 3));
    expect(out.text).toBe('Héllo wörld');
    expect(parser.done).toBe(true);
    expect(parser.finish()).toBe('stop');
  });

  it('ignores frames after [DONE]', () => {
    const { parser, out } = make();
    parser.feed(sseBody(['[DONE]', openAIChunk({ content: 'late' })]));
    expect(out.text).toBe('');
  });

  it('emits tool calls on finish() when the provider never sent a finish_reason', () => {
    const { parser, out } = make();
    parser.feed(sseBody([openAIChunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{}' } }] })]));
    expect(out.calls).toHaveLength(0);
    expect(parser.finish()).toBe('tool_calls');
    expect(out.calls).toEqual([[{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }]]);
    // Not twice
    parser.finish();
    expect(out.calls).toHaveLength(1);
  });

  it('orders tool calls by index', () => {
    const { parser, out } = make();
    parser.feed(
      sseBody([
        openAIChunk({ tool_calls: [{ index: 1, id: 'b', function: { name: 'second', arguments: '' } }] }),
        openAIChunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'first', arguments: '' } }] }),
        openAIChunk({}, { finish_reason: 'tool_calls' }),
      ])
    );
    expect((out.calls[0] as any[]).map((c) => c.id)).toEqual(['a', 'b']);
  });
});

describe('onceTerminal', () => {
  it('lets only the first terminal callback through', () => {
    const onComplete = vi.fn();
    const onError = vi.fn();
    const cb = onceTerminal({ onChunk: vi.fn(), onComplete, onError });
    cb.onComplete('stop');
    cb.onError(new Error('late'));
    cb.onComplete('aborted');
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith('stop');
    expect(onError).not.toHaveBeenCalled();
    expect(cb.ended).toBe(true);
  });
});

describe('readErrorMessage', () => {
  it('prefers the JSON error message, then detail, then a body snippet', async () => {
    expect(await readErrorMessage(new Response('{"error":{"message":"nope"}}', { status: 400 }))).toBe('nope');
    expect(await readErrorMessage(new Response('{"detail":"Not found"}', { status: 404 }))).toBe('Not found');
    expect(await readErrorMessage(new Response('upstream down', { status: 502, statusText: 'Bad Gateway' }))).toBe(
      'HTTP 502: Bad Gateway - upstream down'
    );
    expect(await readErrorMessage(new Response('', { status: 500, statusText: 'Internal' }))).toBe('HTTP 500: Internal');
  });
});

describe('streamOpenAICompatible', () => {
  it('resolves with the end reason and never rejects', async () => {
    mockFetchSequence([streamingResponse(sseBody([openAIChunk({}, { finish_reason: 'stop' }), '[DONE]']))]);
    const { callbacks } = recordingCallbacks();
    await expect(
      streamOpenAICompatible({ url: 'http://x/chat', headers: {}, body: {} }, callbacks)
    ).resolves.toBe('stop');

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    const r = recordingCallbacks();
    await expect(
      streamOpenAICompatible({ url: 'http://x/chat', headers: {}, body: {} }, r.callbacks)
    ).resolves.toBe('error');
    expect(r.rec.errors.map((e) => e.message)).toEqual(['fetch failed']);
    expect(r.rec.completeCount).toBe(0);
  });

  it('uses a custom fetch when given', async () => {
    const fetchImpl = vi.fn(async () => streamingResponse(sseBody(['[DONE]'])));
    const { callbacks } = recordingCallbacks();
    await streamOpenAICompatible({ url: 'http://x/chat', headers: { A: 'b' }, body: { m: 1 }, fetchImpl }, callbacks);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/chat',
      expect.objectContaining({ method: 'POST', body: '{"m":1}', headers: { 'Content-Type': 'application/json', A: 'b' } })
    );
  });
});

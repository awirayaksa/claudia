/**
 * Desktop context compaction through the chat slice: a long chat is sent with
 * its oldest exchanges summarized, the summary is stored on the last message
 * it covers and reused, and Stop reaches the summary.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeChatStore, scriptedProvider, stubPlatform, textResult } from '../../test/chat-harness';
import type { Message } from '../../types/message.types';

const providerRef: { current: any } = { current: null };
vi.mock('../../services/api/provider.service', () => ({
  getAPIProvider: () => providerRef.current,
}));

// Imported after the mock is registered
const { sendStreamingMessageWithTools, addMessage, abortStreaming } = await import('./chatSlice');

let seq = 0;
const msg = (role: Message['role'], content: string): Message => ({ id: `m${++seq}`, role, content, timestamp: '2026-11-20T00:00:00.000Z' });
/** Ten exchanges of about 400 tokens each: past 80% of what an 8,000-token window allows a prompt. */
const longChat = (): Message[] =>
  Array.from({ length: 10 }, (_, i) => [msg('user', `question ${i + 1} ` + 'q'.repeat(800)), msg('assistant', `answer ${i + 1} ` + 'a'.repeat(800))]).flat();

function storeWithLongChat() {
  const store = makeChatStore();
  store.dispatch({ type: 'settings/setApiConfig', payload: { modelContextLengths: { m: 8_000 } } });
  const history = longChat();
  for (const m of history) store.dispatch(addMessage(m));
  return { store, history };
}

const summaryReply = (text: string) => ({
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  stubPlatform(async () => textResult(''));
});

describe('context compaction (desktop)', () => {
  it('summarizes the oldest exchanges, stores the summary, and reuses it on the next send', async () => {
    const { provider, requests } = scriptedProvider([{ text: 'reply one' }, { text: 'reply two' }]);
    provider.chatCompletion.mockResolvedValue(summaryReply('SUMMARY'));
    providerRef.current = provider;
    const { store, history } = storeWithLongChat();

    await store.dispatch(sendStreamingMessageWithTools({ content: 'next', model: 'm' }) as any);

    expect(provider.chatCompletion).toHaveBeenCalled();
    const summaryCalls = provider.chatCompletion.mock.calls.length;
    // Stored on the last message of the six exchanges folded
    const stored = store.getState().chat.messages;
    expect(stored[11].compaction).toEqual({ summary: 'SUMMARY', turns: 6 });
    expect(stored.filter((m) => m.compaction)).toHaveLength(1);
    expect(store.getState().chat.isCompacting).toBe(false);

    // The request: the summary, the last four exchanges word for word, the new message
    const sent = requests[0].messages;
    expect(sent[0]).toMatchObject({ role: 'system' });
    expect(String(sent[0].content)).toContain('SUMMARY');
    expect(sent.slice(1, -1).map((m) => m.content)).toEqual(history.slice(12).map((m) => m.content));
    expect(sent[sent.length - 1]).toEqual({ role: 'user', content: 'next' });

    // Next send: the stored summary is reused, nothing is summarized again
    await store.dispatch(sendStreamingMessageWithTools({ content: 'and then', model: 'm' }) as any);
    expect(provider.chatCompletion).toHaveBeenCalledTimes(summaryCalls);
    expect(String(requests[1].messages[0].content)).toContain('SUMMARY');
    expect(requests[1].messages.some((m) => String(m.content).startsWith('question 1 '))).toBe(false);
  });

  it('leaves out the oldest exchanges, whole, when summaries are off', async () => {
    const { provider, requests } = scriptedProvider([{ text: 'reply' }]);
    providerRef.current = provider;
    const { store } = storeWithLongChat();
    store.dispatch({ type: 'settings/setPreferences', payload: { contextCompaction: false } });

    await store.dispatch(sendStreamingMessageWithTools({ content: 'next', model: 'm' }) as any);

    expect(provider.chatCompletion).not.toHaveBeenCalled();
    // ~4,000 tokens of history don't fit in 3,600: the oldest exchanges are left out, whole
    const sent = requests[0].messages;
    expect(sent[0].role).toBe('user');
    expect(String(sent[0].content)).not.toContain('question 1 ');
    expect(sent[sent.length - 1]).toEqual({ role: 'user', content: 'next' });
    expect(store.getState().chat.messages.some((m) => m.compaction)).toBe(false);
  });

  it('stops while summarizing: nothing is sent', async () => {
    const { provider, requests } = scriptedProvider([{ text: 'never' }]);
    providerRef.current = provider;
    const { store } = storeWithLongChat();
    provider.chatCompletion.mockImplementation(async () => {
      store.dispatch(abortStreaming());
      return summaryReply('PARTIAL');
    });

    await store.dispatch(sendStreamingMessageWithTools({ content: 'next', model: 'm' }) as any);

    expect(requests).toHaveLength(0);
    const { isStreaming, isCompacting, error } = store.getState().chat;
    expect(isStreaming).toBe(false);
    expect(isCompacting).toBe(false);
    expect(error).toBeNull();
  });
});

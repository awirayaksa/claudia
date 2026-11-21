import { describe, it, expect, vi } from 'vitest';
import type { Message } from '../../types/message.types';
import type { ChatCompletionRequest, ChatMessage } from '../../types/api.types';
import type { IAPIProvider } from '../api/provider.interface';
import { latestMessageCompaction, messageTurns, messagesTranscript, prepareHistory, type PrepareHistoryInput } from './history-compaction';

// A model with an 8,000-token window: prompts may use 3,600 tokens, a summary starts at 2,880
const MODEL = 'test-model';
const LENGTHS = { [MODEL]: 8_000 };

let seq = 0;
const msg = (role: Message['role'], content: string, extra: Partial<Message> = {}): Message => ({
  id: `m${++seq}`,
  role,
  content,
  timestamp: '2026-11-20T00:00:00.000Z',
  ...extra,
});
/** One exchange of about 400 tokens. */
const exchange = (n: number): Message[] => [msg('user', `question ${n} ` + 'q'.repeat(800)), msg('assistant', `answer ${n} ` + 'a'.repeat(800))];
const chat = (n: number): Message[] => Array.from({ length: n }, (_, i) => exchange(i + 1)).flat();

function fakeProvider(reply: (req: ChatCompletionRequest) => string | Error = () => 'SUMMARY') {
  const chatCompletion = vi.fn(async (req: ChatCompletionRequest) => {
    const out = reply(req);
    if (out instanceof Error) throw out;
    return {
      id: 'x',
      object: 'chat.completion',
      created: 0,
      model: req.model,
      choices: [{ index: 0, message: { role: 'assistant', content: out }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
  });
  return { provider: { chatCompletion } as unknown as IAPIProvider, chatCompletion };
}

function input(history: Message[], over: Partial<PrepareHistoryInput> = {}): PrepareHistoryInput {
  return {
    history,
    system: [{ role: 'system', content: 'Be helpful.' }],
    current: [{ role: 'user', content: 'the new question' }],
    model: MODEL,
    modelContextLengths: LENGTHS,
    compaction: { enabled: true },
    provider: fakeProvider().provider,
    ...over,
  };
}

const texts = (messages: ChatMessage[]) => messages.map((m) => (typeof m.content === 'string' ? m.content : ''));

describe('messageTurns', () => {
  it('starts an exchange at each user message and keeps tool rounds with it', () => {
    const call = { id: 'c1', type: 'function' as const, function: { name: 'search', arguments: '{}' } };
    const turns = messageTurns([
      msg('user', 'a'),
      msg('assistant', '', { toolCalls: [call] }),
      msg('tool', 'found', { tool_call_id: 'c1' }),
      msg('assistant', 'done'),
      msg('user', 'b'),
    ]);
    expect(turns.map((t) => t.map((m) => m.role))).toEqual([['user', 'assistant', 'tool', 'assistant'], ['user']]);
  });
});

describe('messagesTranscript', () => {
  it('names who spoke, lists attachments and tool calls, and shortens long tool results', () => {
    const call = { id: 'c1', type: 'function' as const, function: { name: 'search', arguments: '{"q":"x"}' } };
    const text = messagesTranscript([
      msg('user', 'Find x', { attachments: [{ id: 'f', type: 'file', name: 'notes.pdf', size: 1, mimeType: 'application/pdf' }] }),
      msg('assistant', '', { toolCalls: [call], reasoning: 'secret thoughts' }),
      msg('tool', 'r'.repeat(5_000), { tool_call_id: 'c1' }),
      msg('assistant', 'Here it is.'),
    ]);
    expect(text).toContain('User: Find x\n[attached file: notes.pdf]');
    expect(text).toContain('[called search({"q":"x"})]');
    expect(text).toContain('[tool result: ' + 'r'.repeat(1_500) + ' […]]');
    expect(text).toContain('Assistant: Here it is.');
    expect(text).not.toContain('secret thoughts');
  });
});

describe('prepareHistory', () => {
  it('sends everything as before when the model window is unknown', async () => {
    const { provider, chatCompletion } = fakeProvider();
    const history = chat(30);
    const out = await prepareHistory(input(history, { model: 'some-unknown-model', provider }));
    expect(out.messages).toHaveLength(1 + history.length + 1);
    expect(out.compaction).toBeUndefined();
    expect(chatCompletion).not.toHaveBeenCalled();
  });

  it('leaves the history alone below the threshold', async () => {
    const { provider, chatCompletion } = fakeProvider();
    const history = chat(5); // ~2,000 tokens, under 80% of 3,600
    const out = await prepareHistory(input(history, { provider }));
    expect(out.messages).toHaveLength(1 + history.length + 1);
    expect(out.compaction).toBeUndefined();
    expect(chatCompletion).not.toHaveBeenCalled();
  });

  it('summarizes the oldest exchanges, keeps the last four word for word, and stores the summary on the last one folded', async () => {
    const { provider, chatCompletion } = fakeProvider();
    const history = chat(10); // ~4,000 tokens
    const out = await prepareHistory(input(history, { provider }));

    // ~9,800 characters to read, at most ~7,200 per call (half the window): two calls, the second building on the first
    const prompts = chatCompletion.mock.calls.map((c) => String(c[0].messages[1].content));
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('question 1 ');
    expect(prompts[1]).toContain('Summary of the conversation so far:\nSUMMARY');
    expect(prompts[1]).toContain('answer 6 ');
    expect(prompts.join('\n')).not.toContain('question 7 ');

    expect(out.compaction).toEqual({ messageId: history[11].id, summary: 'SUMMARY', turns: 6 });
    const sent = texts(out.messages);
    expect(sent[0]).toBe('Be helpful.');
    expect(sent[1]).toContain('this is the summary:\n\nSUMMARY');
    expect(sent.slice(2, -1)).toEqual(history.slice(12).map((m) => m.content));
    expect(sent[sent.length - 1]).toBe('the new question');
    expect(out.droppedTurns).toBe(0);
  });

  it('never splits a tool call from its results', async () => {
    const { provider } = fakeProvider();
    const call = { id: 'c1', type: 'function' as const, function: { name: 'search', arguments: '{}' } };
    const history = [
      ...chat(5),
      msg('user', 'look it up ' + 'q'.repeat(800)),
      msg('assistant', '', { toolCalls: [call] }),
      msg('tool', 'r'.repeat(800), { tool_call_id: 'c1' }),
      msg('assistant', 'found it ' + 'a'.repeat(800)),
      ...chat(4),
    ];
    const out = await prepareHistory(input(history, { provider }));
    const sent = out.messages;
    sent.forEach((m, i) => {
      if (m.role === 'tool') expect(sent[i - 1].tool_calls?.[0].id).toBe(m.tool_call_id);
    });
    // The tool round was folded whole: the summary is stored on its last message
    expect(out.compaction?.messageId).toBe(history[13].id);
  });

  it('reuses a stored summary without calling the model', async () => {
    const { provider, chatCompletion } = fakeProvider();
    const history = chat(6);
    history[5] = { ...history[5], compaction: { summary: 'EARLIER', turns: 3 } };
    const out = await prepareHistory(input(history, { provider }));

    expect(chatCompletion).not.toHaveBeenCalled();
    expect(out.compaction).toBeUndefined();
    const sent = texts(out.messages);
    expect(sent[1]).toContain('EARLIER');
    expect(sent.slice(2, -1)).toEqual(history.slice(6).map((m) => m.content));
    expect(latestMessageCompaction(history).rest).toHaveLength(6);
  });

  it('folds an earlier summary into the new one and counts every exchange it covers', async () => {
    const { provider, chatCompletion } = fakeProvider(() => 'NEWER');
    const history = [...chat(3), ...chat(10)];
    history[5] = { ...history[5], compaction: { summary: 'EARLIER', turns: 3 } };
    const out = await prepareHistory(input(history, { provider }));

    expect(String(chatCompletion.mock.calls[0][0].messages[1].content)).toContain('Summary of the conversation so far:\nEARLIER');
    expect(out.compaction).toEqual({ messageId: history[17].id, summary: 'NEWER', turns: 9 });
    expect(texts(out.messages).join('\n')).not.toContain('EARLIER');
  });

  it('leaves out the oldest exchanges when summarizing fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { provider } = fakeProvider(() => new Error('rate limited'));
    const history = chat(12); // ~4,900 tokens: more than the 3,600 that fit
    const out = await prepareHistory(input(history, { provider }));

    expect(out.compaction).toBeUndefined();
    expect(out.droppedTurns).toBeGreaterThan(0);
    expect(texts(out.messages).join('\n')).not.toContain('summary');
    expect(warn).toHaveBeenCalled();
  });

  it('only leaves out the oldest exchanges when summaries are turned off', async () => {
    const { provider, chatCompletion } = fakeProvider();
    const history = chat(12);
    history[5] = { ...history[5], compaction: { summary: 'EARLIER', turns: 3 } };
    const out = await prepareHistory(input(history, { provider, compaction: { enabled: false } }));

    expect(chatCompletion).not.toHaveBeenCalled();
    expect(out.droppedTurns).toBeGreaterThan(0);
    expect(texts(out.messages).join('\n')).not.toContain('EARLIER');
  });

  it('follows the threshold setting', async () => {
    const { provider, chatCompletion } = fakeProvider();
    // ~2,000 tokens: under the default 80%, over 50%
    await prepareHistory(input(chat(5), { provider, compaction: { enabled: true, threshold: 0.5 } }));
    expect(chatCompletion).toHaveBeenCalledTimes(1);
  });

  it('stops when the user stops', async () => {
    const controller = new AbortController();
    controller.abort();
    const { provider } = fakeProvider();
    await expect(prepareHistory(input(chat(10), { provider, signal: controller.signal }))).rejects.toThrow('Stopped.');
  });
});

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CONTEXT_WINDOW,
  estimateMessageTokens,
  estimateTextTokens,
  fitToContext,
  groupTurns,
  planCompaction,
  promptLimit,
  SUMMARY_TOKENS,
} from './context-budget';
import type { ChatMessage } from '../../types/api.types';

const user = (text: string): ChatMessage => ({ role: 'user', content: text });
const assistant = (text: string): ChatMessage => ({ role: 'assistant', content: text });
const words = (n: number) => 'word '.repeat(n); // ~1.25 tokens per word

describe('estimates', () => {
  it('counts about four characters per token and a fixed cost per image', () => {
    expect(estimateTextTokens('abcdefgh')).toBe(2);
    expect(
      estimateMessageTokens({
        role: 'user',
        content: [
          { type: 'text', text: 'abcd' },
          { type: 'image_url', image_url: { url: 'data:x' } },
        ],
      })
    ).toBe(4 + 1 + 1000);
  });

  it('counts tool calls and echoed reasoning', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      reasoning_content: 'abcd',
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'abcd', arguments: 'abcdabcd' } }],
    };
    expect(estimateMessageTokens(msg)).toBe(4 + 1 + (1 + 2 + 4));
  });
});

describe('groupTurns', () => {
  it('starts a group at every user message and keeps tool rounds together', () => {
    const msgs: ChatMessage[] = [
      user('a'),
      { role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c', content: 'r' },
      assistant('b'),
      user('c'),
      assistant('d'),
    ];
    expect(groupTurns(msgs).map((g) => g.length)).toEqual([4, 2]);
  });
});

describe('fitToContext', () => {
  it('keeps everything when it fits', () => {
    const r = fitToContext({
      model: 'gpt-4o',
      system: [{ role: 'system', content: 'Be brief.' }],
      history: [user('hi'), assistant('hello')],
      current: [user('how are you')],
    });
    expect(r.window).toBe(128_000);
    expect(r.droppedTurns).toBe(0);
    expect(r.trimmedContext).toBe(false);
    expect(r.overflow).toBe(false);
    expect(r.messages.map((m) => m.content)).toEqual(['Be brief.', 'hi', 'hello', 'how are you']);
  });

  it('drops the oldest whole turns first', () => {
    const history = [user(words(1000)), assistant(words(1000)), user('recent'), assistant('reply')];
    const r = fitToContext({
      model: 'unknown',
      contextWindow: 3_000,
      outputReserve: 500,
      system: [],
      history,
      current: [user('now')],
    });
    expect(r.droppedTurns).toBe(1);
    expect(r.messages.map((m) => m.content)).toEqual(['recent', 'reply', 'now']);
    expect(r.estimatedTokens).toBeLessThanOrEqual(3_000 - 500);
  });

  it('uses the default window for unknown models and the provider-reported one when given', () => {
    expect(fitToContext({ model: 'mystery', system: [], history: [], current: [user('x')] }).window).toBe(
      DEFAULT_CONTEXT_WINDOW
    );
    expect(
      fitToContext({ model: 'mystery', modelContextLengths: { mystery: 1_000_000 }, system: [], history: [], current: [] })
        .window
    ).toBe(1_000_000);
  });

  it('adds memories and documents as system messages, trimming documents to their share', () => {
    const r = fitToContext({
      model: 'm',
      contextWindow: 4_000,
      outputReserve: 1_000,
      system: [{ role: 'system', content: 'S' }],
      memories: ['Likes tea'],
      documents: [
        { title: '[1] big.pdf', text: 'a'.repeat(20_000) },
        { title: '[2] small.txt', text: 'b'.repeat(2_000) },
      ],
      history: [],
      current: [user('q')],
    });
    expect(r.trimmedContext).toBe(true);
    expect(r.messages[0].content).toBe('S');
    expect(r.messages[1].content).toBe('Things you remember about the user:\n- Likes tea');
    const docs = String(r.messages[2].content);
    expect(docs).toContain('<source title="[1] big.pdf">');
    expect(docs).toContain('[…trimmed to fit the context window]');
    expect(r.messages.at(-1)!.content).toBe('q');
    expect(r.estimatedTokens).toBeLessThanOrEqual(4_000 - 1_000);
  });

  it('prefers recent history over documents only up to half of the free space', () => {
    const r = fitToContext({
      model: 'm',
      contextWindow: 6_000,
      outputReserve: 1_000,
      system: [],
      documents: [{ title: 'd', text: 'z'.repeat(40_000) }],
      history: [user(words(400)), assistant(words(400))],
      current: [user('q')],
    });
    // The recent turn survives even though the document alone could fill the window
    expect(r.droppedTurns).toBe(0);
    expect(r.trimmedContext).toBe(true);
  });

  it('flags overflow when the current turn alone is too big', () => {
    const r = fitToContext({
      model: 'm',
      contextWindow: 1_000,
      outputReserve: 100,
      system: [],
      history: [user('old')],
      current: [user(words(2_000))],
    });
    expect(r.overflow).toBe(true);
    expect(r.droppedTurns).toBe(1);
    expect(r.messages).toHaveLength(1);
  });
});

describe('planCompaction', () => {
  const base = { limit: 10_000, fixedTokens: 500 };

  it('folds nothing while the prompt is under the threshold', () => {
    expect(planCompaction({ ...base, turnTokens: [1000, 1000, 1000, 1000, 1000, 1000, 1000] })).toBe(0);
    expect(planCompaction({ ...base, turnTokens: [2000, 2000, 2000, 1000], threshold: 0.9 })).toBe(0);
  });

  it('folds the oldest turns until about half the limit is left', () => {
    // 500 + 10 × 1000 = 10 500 > 8 000; with the summary's room, fold until ≤ 5 000
    const fold = planCompaction({ ...base, turnTokens: Array(10).fill(1000), keepRecentTurns: 2 });
    expect(fold).toBe(7);
    // The last four turns stay by default
    expect(planCompaction({ ...base, turnTokens: Array(10).fill(1000) })).toBe(6);
    expect(500 + SUMMARY_TOKENS + (10 - fold) * 1000).toBeLessThanOrEqual(5000);
  });

  it('honours the threshold', () => {
    const turns = Array(8).fill(800); // 500 + 6 400 = 6 900
    expect(planCompaction({ ...base, turnTokens: turns })).toBe(0);
    expect(planCompaction({ ...base, turnTokens: turns, threshold: 0.6 })).toBeGreaterThan(0);
  });

  it('never folds the most recent turns, even when they alone are too big', () => {
    expect(planCompaction({ ...base, turnTokens: [3000, 3000, 3000, 3000], keepRecentTurns: 4 })).toBe(0);
    expect(planCompaction({ ...base, turnTokens: [3000, 3000, 3000, 3000, 3000], keepRecentTurns: 2 })).toBe(3);
  });

  it('works on the turns of groupTurns, so tool calls stay with their results', () => {
    const msgs: ChatMessage[] = [
      user(words(2000)),
      { role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c', content: words(2000) },
      assistant('done'),
      user('next'),
      assistant('ok'),
    ];
    const turns = groupTurns(msgs);
    const { limit } = promptLimit({ model: 'x', contextWindow: 8_000 });
    const fold = planCompaction({ limit, fixedTokens: 10, turnTokens: turns.map((t) => t.reduce((s, m) => s + estimateMessageTokens(m), 0)), keepRecentTurns: 1 });
    expect(fold).toBe(1);
    // The folded turn holds the whole tool round
    expect(turns.slice(0, fold).flat().map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });
});

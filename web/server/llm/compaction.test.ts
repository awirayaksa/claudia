/**
 * Context compaction end to end: a chat that outgrows a small context window
 * has its oldest turns summarized, the summary is reused, and a failed
 * summary falls back to dropping turns.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { chatFixture, type ChatFixture } from '../test/chat-fixture';
import { messages, usageEvents } from '../db/schema';
import { chunkText, latestCompaction, nodeTurns, transcriptOf } from './compaction';
import type { MessageNode } from '../../../src/types/turn.types';

let f: ChatFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

// 1 200-token window: about 540 tokens of prompt, compaction above ~430
const SMALL = 'mock/gpt-small';
// ~100 tokens whatever the tag; a turn is ~210
const words = (tag: string) => `${tag} `.repeat(Math.ceil(400 / (tag.length + 1))).slice(0, 400).trim();

async function setup() {
  f = await chatFixture({ models: ['gpt-test', { id: 'gpt-small', context_length: 1200 }] });
  await f.admin.patch('/api/me/settings', { preferences: { visualExplanations: false } });
  await f.admin.patch('/api/admin/settings/tasks', { generateTitles: false, generateFollowUps: false, titleModel: null });
  await f.admin.patch('/api/admin/settings/compaction', { enabled: true, threshold: 0.8, keepRecentTurns: 1, model: null });
  return f;
}

async function turn(fx: ChatFixture, chatId: string, parentId: string | null, content: string, reply: string, extra: object = {}) {
  fx.mock.push({ text: [reply] });
  const res = await fx.admin.post(`/api/chats/${chatId}/completions`, { parentId, modelIds: [SMALL], content, ...extra });
  expect(res.statusCode).toBe(202);
  const started = res.json();
  const events = await fx.readRun(fx.admin, started.runId);
  return { ...started, events };
}

const streamed = (fx: ChatFixture) => fx.mock.requests.filter((r) => r.stream);
const summaryCalls = (fx: ChatFixture) => fx.mock.requests.filter((r) => !r.stream && String(r.messages[0].content).includes('compress a conversation'));

describe('context compaction', () => {
  it('summarizes the oldest turns near the limit, stores the summary and reuses it', async () => {
    const fx = await setup();
    const chatId = await fx.newChat(fx.admin);
    const t1 = await turn(fx, chatId, null, words('one'), words('uno'));
    const t2 = await turn(fx, chatId, t1.assistantMessageIds[0], words('two'), words('dos'));
    expect(summaryCalls(fx)).toHaveLength(0);

    fx.mock.completions.push({ content: 'SUMMARY: the user said one, the assistant said uno.' });
    const t3 = await turn(fx, chatId, t2.assistantMessageIds[0], words('three'), words('tres'));

    // One summary call, over the first turn only (the last one stays word for word)
    expect(summaryCalls(fx)).toHaveLength(1);
    const prompt = String(summaryCalls(fx)[0].messages[1].content);
    expect(prompt).toContain('User: one one');
    expect(prompt).toContain('Assistant: uno uno');
    expect(prompt).not.toContain('two two');

    const sent = streamed(fx)[2].messages;
    expect(sent[0].role).toBe('system');
    expect(sent[0].content).toContain('SUMMARY: the user said one');
    expect(sent.slice(1).map((m: any) => m.content)).toEqual([words('two'), words('dos'), words('three')]);
    expect(t3.events.some((e: any) => e.event.type === 'run.notice' && e.event.code === 'history_compacted')).toBe(true);
    expect(t3.events.some((e: any) => e.event.type === 'run.notice' && e.event.code === 'history_trimmed')).toBe(false);

    // Stored on the last node it covers, and shown to the client there
    const [row] = await fx.db.db.select().from(messages).where(eq(messages.id, t1.assistantMessageIds[0]));
    expect(row.meta.compaction).toMatchObject({ summary: 'SUMMARY: the user said one, the assistant said uno.', turns: 1, modelId: SMALL });
    const chat = (await fx.admin.get(`/api/chats/${chatId}`)).json().chat;
    expect(chat.messages.find((m: any) => m.id === t1.assistantMessageIds[0]).compaction).toEqual({
      summary: 'SUMMARY: the user said one, the assistant said uno.',
      turns: 1,
    });
    const usage = await fx.db.db.select().from(usageEvents).where(eq(usageEvents.kind, 'compaction'));
    expect(usage).toHaveLength(1);

    // Answering turn 3 again reuses the summary instead of making a new one
    await turn(fx, chatId, t3.userMessageId, '', words('otra'), { regenerate: true });
    expect(summaryCalls(fx)).toHaveLength(1);
    expect(streamed(fx)[3].messages[0].content).toContain('SUMMARY: the user said one');
  });

  it('folds an earlier summary into the next one', async () => {
    const fx = await setup();
    const chatId = await fx.newChat(fx.admin);
    let parent: string | null = null;
    fx.mock.completions.push({ content: 'FIRST SUMMARY' }, { content: 'SECOND SUMMARY' });
    for (const tag of ['a', 'b', 'c', 'd', 'e']) {
      const t: any = await turn(fx, chatId, parent, words(tag), words(tag.toUpperCase()));
      parent = t.assistantMessageIds[0];
    }
    const calls = summaryCalls(fx);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(String(calls[1].messages[1].content)).toContain('Summary of the conversation so far:\nFIRST SUMMARY');
    // Only the newest summary is sent
    const last = streamed(fx).at(-1)!.messages;
    expect(last.filter((m: any) => m.role === 'system').map((m: any) => m.content).join('\n')).not.toContain('FIRST SUMMARY');
  });

  it('drops the oldest turns as before when compaction is off or the summary fails', async () => {
    const fx = await setup();
    await fx.admin.patch('/api/admin/settings/compaction', { enabled: false, threshold: 0.8, keepRecentTurns: 1, model: null });
    const chatId = await fx.newChat(fx.admin);
    let parent: string | null = null;
    for (const tag of ['a', 'b', 'c']) parent = (await turn(fx, chatId, parent, words(tag), words(tag.toUpperCase()))).assistantMessageIds[0];
    expect(summaryCalls(fx)).toHaveLength(0);

    // On, but the summarizer answers with nothing: the run still goes through
    await fx.admin.patch('/api/admin/settings/compaction', { enabled: true, threshold: 0.8, keepRecentTurns: 1, model: null });
    fx.mock.completions.push({ content: '   ' });
    const t = await turn(fx, chatId, parent, words('d'), words('D'));
    expect(summaryCalls(fx)).toHaveLength(1);
    expect(t.events.at(-1).event).toMatchObject({ type: 'run.completed', status: 'completed' });
    expect(t.events.some((e: any) => e.event.code === 'history_trimmed')).toBe(true);
    const rows = await fx.db.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(rows.some((r) => r.meta.compaction)).toBe(false);
  });
});

describe('compaction helpers', () => {
  const node = (id: string, role: 'user' | 'assistant', parts: MessageNode['parts'], extra: Partial<MessageNode> = {}): MessageNode => ({
    id,
    chatId: 'c',
    parentId: null,
    role,
    parts,
    status: 'completed',
    createdAt: '',
    ...extra,
  });

  it('groups turns, finds the deepest summary and writes a transcript', () => {
    const path = [
      node('u1', 'user', [{ type: 'text', text: 'hi' }]),
      node('a1', 'assistant', [
        { type: 'reasoning', text: 'secret thoughts' },
        { type: 'tool_call', callId: 'x', alias: 'f', serverId: 's', tool: 'search', args: '{"q":"x"}' },
        { type: 'tool_result', callId: 'x', content: 'found' },
        { type: 'text', text: 'hello' },
      ], { compaction: { summary: 'S1', turns: 1 } }),
      node('u2', 'user', [{ type: 'text', text: 'more' }, { type: 'file', fileId: 'f', name: 'a.csv', mime: 'text/csv', size: 1 }]),
      node('a2', 'assistant', [{ type: 'text', text: 'ok' }]),
    ];
    expect(nodeTurns(path).map((t) => t.map((n) => n.id))).toEqual([['u1', 'a1'], ['u2', 'a2']]);
    expect(latestCompaction(path)).toEqual({ summary: 'S1', rest: path.slice(2) });
    const text = transcriptOf(path);
    expect(text).toContain('[called search({"q":"x"})]');
    expect(text).toContain('[tool result: found]');
    expect(text).toContain('[attached file: a.csv]');
    expect(text).not.toContain('secret thoughts');
  });

  it('cuts long transcripts at paragraph breaks', () => {
    const text = Array.from({ length: 10 }, (_, i) => `p${i} ${'x'.repeat(90)}`).join('\n\n');
    const chunks = chunkText(text, 300);
    expect(chunks.every((c) => c.length <= 300)).toBe(true);
    expect(chunks.join('\n\n')).toBe(text);
  });
});

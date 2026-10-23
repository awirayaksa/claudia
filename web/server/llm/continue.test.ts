/**
 * A reply cut off at the output limit says so, and continuing it carries on
 * in the same message: the text joins up and the usage adds up.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { chatFixture, type ChatFixture } from '../test/chat-fixture';
import { messages, usageEvents } from '../db/schema';
import { continuationMessages } from './chat-orchestrator';
import type { MessageNode } from '../../../src/types/turn.types';

let f: ChatFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const usage = (p: number, c: number) => ({ prompt_tokens: p, completion_tokens: c, total_tokens: p + c });

describe('continuing a cut-off reply', () => {
  it('marks the cut, then carries on in the same message', async () => {
    f = await chatFixture();
    const fx = f;
    await fx.admin.patch('/api/admin/settings/tasks', { generateTitles: false, generateFollowUps: false, titleModel: null });
    const chatId = await fx.newChat(fx.admin);
    fx.mock.push({ text: ['```python\nfor i in range(3):\n    pri'], finishReason: 'length', usage: usage(10, 20) });
    const first = (await fx.admin.post(`/api/chats/${chatId}/completions`, { parentId: null, modelIds: ['mock/gpt-test'], content: 'Write a loop' })).json();
    const events = await fx.readRun(fx.admin, first.runId);
    expect((events.find((e) => e.event.type === 'message.completed')!.event as any).stopReason).toBe('length');
    const reply = first.assistantMessageIds[0];
    let chat = (await fx.admin.get(`/api/chats/${chatId}`)).json().chat;
    expect(chat.messages.find((m: any) => m.id === reply).stopReason).toBe('length');

    // Continue: the same node, the reply so far, and a request to carry on
    fx.mock.push({ text: ['nt(i)\n```'], usage: usage(40, 5) });
    const res = await fx.admin.post(`/api/chats/${chatId}/completions`, { parentId: first.userMessageId, continueId: reply, modelIds: ['mock/gpt-test'] });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().assistantMessageIds).toEqual([reply]);
    const more = await fx.readRun(fx.admin, res.json().runId);
    expect(more.filter((e) => e.event.type === 'message.created').map((e) => (e.event as any).message.id)).toEqual([reply]);

    const sent = fx.mock.requests.filter((r) => r.stream)[1].messages;
    expect(sent.at(-2)).toEqual({ role: 'assistant', content: '```python\nfor i in range(3):\n    pri' });
    expect(sent.at(-1).role).toBe('user');
    expect(sent.at(-1).content).toContain('cut off');

    chat = (await fx.admin.get(`/api/chats/${chatId}`)).json().chat;
    expect(chat.messages.filter((m: any) => m.role === 'assistant')).toHaveLength(1);
    const node = chat.messages.find((m: any) => m.id === reply);
    // One text part, so the split code block renders as one
    expect(node.parts).toEqual([{ type: 'text', text: '```python\nfor i in range(3):\n    print(i)\n```' }]);
    expect(node.stopReason).toBeUndefined();
    expect(node.usage).toMatchObject({ prompt_tokens: 50, completion_tokens: 25 });
    // Each run is recorded once, with its own tokens
    const recorded = await fx.db.db.select().from(usageEvents).where(eq(usageEvents.chatId, chatId));
    expect(recorded.map((u) => u.completionTokens).sort()).toEqual([20, 5]);
    const [row] = await fx.db.db.select().from(messages).where(eq(messages.id, reply));
    expect(row.status).toBe('completed');

    // Only a finished reply of this chat can be continued
    expect((await fx.admin.post(`/api/chats/${chatId}/completions`, { parentId: null, continueId: first.userMessageId, modelIds: ['mock/gpt-test'] })).statusCode).toBe(400);
  });

  it('uses a prefill for Anthropic and an instruction elsewhere', () => {
    const reply: MessageNode = {
      id: 'a',
      chatId: 'c',
      parentId: 'u',
      role: 'assistant',
      parts: [{ type: 'text', text: 'The answer is \n' }],
      status: 'completed',
      createdAt: '',
    };
    expect(continuationMessages(reply, true)).toEqual([{ role: 'assistant', content: 'The answer is' }]);
    const plain = continuationMessages(reply, false);
    expect(plain[0]).toEqual({ role: 'assistant', content: 'The answer is \n' });
    expect(plain[1].role).toBe('user');
  });
});

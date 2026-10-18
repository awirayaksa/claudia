import { describe, it, expect } from 'vitest';
import reducer, { runCleared, runEvent, runFollowed, type RunState } from './run-slice';
import { toDisplayMessage, visiblePath } from './to-display';
import type { RunEvent } from '@shared/run-events';
import type { MessageNode } from '@/types/turn.types';

const node = (id: string, parentId: string | null, role: MessageNode['role'], parts: MessageNode['parts'] = []): MessageNode => ({
  id,
  chatId: 'c',
  parentId,
  role,
  parts,
  status: 'completed',
  createdAt: '2026-01-01T00:00:00.000Z',
});

function play(events: RunEvent[], start: RunState = {}): RunState {
  let s = reducer(start, runFollowed({ chatId: 'c', runId: 'r' }));
  events.forEach((event, i) => {
    s = reducer(s, runEvent({ chatId: 'c', envelope: { seq: i + 1, event } }));
  });
  return s;
}

describe('run slice', () => {
  it('builds the live reply from events', () => {
    const s = play([
      { type: 'run.started', runId: 'r', chatId: 'c', userMessageId: 'u', assistantMessageIds: ['a'] },
      { type: 'message.created', message: node('u', null, 'user', [{ type: 'text', text: 'hi' }]) },
      { type: 'message.created', message: { ...node('a', 'u', 'assistant'), status: 'streaming' } },
      { type: 'message.reasoning', messageId: 'a', text: 'hm' },
      { type: 'message.delta', messageId: 'a', text: 'Hel' },
      { type: 'message.delta', messageId: 'a', text: 'lo' },
      { type: 'run.notice', code: 'history_trimmed', message: 'trimmed' },
      { type: 'chat.updated', chatId: 'c', title: 'Greeting' },
    ]);
    const live = s.c;
    expect(live.leafId).toBe('a');
    expect(live.nodes.a.parts).toEqual([
      { type: 'reasoning', text: 'hm' },
      { type: 'text', text: 'Hello' },
    ]);
    expect(live.notices).toEqual(['trimmed']);
    expect(live.title).toBe('Greeting');
    expect(live.done).toBe(false);
  });

  it('takes the final parts on completion and ignores replayed events', () => {
    let s = play([
      { type: 'message.created', message: { ...node('a', null, 'assistant'), status: 'streaming' } },
      { type: 'message.delta', messageId: 'a', text: 'x' },
    ]);
    // A reconnect replays seq 2 again: no double text
    s = reducer(s, runEvent({ chatId: 'c', envelope: { seq: 2, event: { type: 'message.delta', messageId: 'a', text: 'x' } } }));
    expect(s.c.nodes.a.parts).toEqual([{ type: 'text', text: 'x' }]);
    s = reducer(
      s,
      runEvent({
        chatId: 'c',
        envelope: { seq: 3, event: { type: 'message.completed', messageId: 'a', status: 'stopped', parts: [{ type: 'text', text: 'xy' }] } },
      })
    );
    s = reducer(s, runEvent({ chatId: 'c', envelope: { seq: 4, event: { type: 'run.completed', runId: 'r', status: 'stopped' } } }));
    expect(s.c.nodes.a).toMatchObject({ status: 'stopped', parts: [{ type: 'text', text: 'xy' }] });
    expect(s.c.done).toBe(true);
    expect(reducer(s, runCleared({ chatId: 'c', runId: 'r' }))).toEqual({});
  });
});

describe('display conversion', () => {
  it('follows the visible path through siblings', () => {
    const nodes = [node('u1', null, 'user'), node('a1', 'u1', 'assistant'), node('a1b', 'u1', 'assistant'), node('u2', 'a1', 'user')];
    expect(visiblePath(nodes, 'u2').map((n) => n.id)).toEqual(['u1', 'a1', 'u2']);
    expect(visiblePath(nodes, 'a1b').map((n) => n.id)).toEqual(['u1', 'a1b']);
    expect(visiblePath(nodes, null)).toEqual([]);
  });

  it('turns an assistant turn into the desktop message shape', () => {
    const msg = toDisplayMessage({
      ...node('a', 'u', 'assistant', [
        { type: 'reasoning', text: 'r' },
        { type: 'text', text: 'Checking.' },
        { type: 'tool_call', callId: 'c1', alias: 'web__search', serverId: 's', tool: 'search', args: '{}' },
        { type: 'tool_result', callId: 'c1', content: 'found' },
        { type: 'text', text: 'Done.' },
      ]),
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    expect(msg).toMatchObject({
      role: 'assistant',
      content: 'Checking.\n\nDone.',
      reasoning: 'r',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{}' } }],
      toolResults: [{ tool_call_id: 'c1', name: 'search', content: 'found', serverId: 's', hasUI: false }],
      usage: { total_tokens: 3 },
    });
  });

  it('shows the error of a failed reply', () => {
    expect(toDisplayMessage({ ...node('a', null, 'assistant'), status: 'error', error: 'HTTP 500' }).error).toBe('HTTP 500');
  });
});

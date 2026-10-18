/**
 * The turn model must send providers exactly what the desktop sends for the
 * same conversation.
 */
import { describe, it, expect } from 'vitest';
import { buildAPIMessage, toOpenAIMessages, turnsFromDesktopMessages, uiResourceConfirmation } from './message-builder';
import type { Message } from '../../types/message.types';
import type { MessageNode } from '../../types/turn.types';

const ts = '2026-01-01T00:00:00.000Z';
const call = (id: string, name: string, args = '{}') => ({ id, type: 'function' as const, function: { name, arguments: args } });

/** A desktop conversation with two tool rounds, reasoning and a UI result. */
const desktop: Message[] = [
  { id: 'u1', role: 'user', content: 'Plan my trip', timestamp: ts },
  {
    id: 'a1',
    role: 'assistant',
    content: 'Let me look.',
    reasoning: 'need weather',
    timestamp: ts,
    toolCalls: [call('c1', 'weather', '{"city":"Oslo"}'), call('c2', 'web__search', '{"q":"oslo"}')],
    toolResults: [
      { tool_call_id: 'c1', role: 'tool', name: 'weather', content: 'Sunny', serverId: 's1' },
      { tool_call_id: 'c2', role: 'tool', name: 'search', content: 'Results', serverId: 's2' },
    ],
  },
  { id: 't1', role: 'tool', content: 'Sunny', tool_call_id: 'c1', name: 'weather', timestamp: ts },
  { id: 't2', role: 'tool', content: 'x'.repeat(5000), tool_call_id: 'c2', name: 'search', timestamp: ts },
  {
    id: 'a2',
    role: 'assistant',
    content: '',
    reasoning: 'show a map',
    timestamp: ts,
    toolCalls: [call('c3', 'map')],
  },
  {
    id: 't3',
    role: 'tool',
    content: uiResourceConfirmation('map'),
    tool_call_id: 'c3',
    name: 'map',
    timestamp: ts,
    toolResults: [
      {
        tool_call_id: 'c3',
        role: 'tool',
        name: 'map',
        content: 'x',
        hasUI: true,
        uiResource: { uri: 'ui://map/1', mimeType: 'text/html', text: '<b>map</b>' },
      },
    ],
  },
  {
    id: 'a3',
    role: 'assistant',
    content: 'Oslo will be sunny.',
    reasoning: 'done',
    timestamp: ts,
    usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
  },
  { id: 'u2', role: 'user', content: 'Thanks', timestamp: ts, effort: 'low' },
  { id: 'a4', role: 'assistant', content: 'You are welcome.', timestamp: ts },
];

describe('turnsFromDesktopMessages', () => {
  const turns = turnsFromDesktopMessages(desktop, 'chat-1');

  it('makes one assistant node per run of assistant and tool records', () => {
    expect(turns.map((t) => [t.id, t.role, t.parentId])).toEqual([
      ['u1', 'user', null],
      ['a1', 'assistant', 'u1'],
      ['u2', 'user', 'a1'],
      ['a4', 'assistant', 'u2'],
    ]);
    expect(turns[2].effort).toBe('low');
    expect(turns[1].usage).toEqual({ prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 });
  });

  it('keeps parts in the order they happened, with where each tool ran', () => {
    expect(turns[1].parts.map((p) => p.type)).toEqual([
      'reasoning', 'text', 'tool_call', 'tool_call', 'tool_result', 'tool_result',
      'reasoning', 'tool_call', 'tool_result',
      'reasoning', 'text',
    ]);
    expect(turns[1].parts[3]).toEqual({
      type: 'tool_call', callId: 'c2', alias: 'web__search', serverId: 's2', tool: 'search', args: '{"q":"oslo"}',
    });
    expect(turns[1].parts[8]).toMatchObject({ type: 'tool_result', callId: 'c3', uiResource: { uri: 'ui://map/1' } });
  });

  it('produces exactly the messages the desktop builder sends', () => {
    expect(toOpenAIMessages(turns)).toEqual(desktop.map(buildAPIMessage));
  });
});

describe('toOpenAIMessages', () => {
  const node = (role: MessageNode['role'], parts: MessageNode['parts'], extra: Partial<MessageNode> = {}): MessageNode => ({
    id: Math.random().toString(36).slice(2),
    chatId: 'c',
    parentId: null,
    role,
    parts,
    status: 'completed',
    createdAt: ts,
    ...extra,
  });

  it('resolves file parts into inline text and images, skipping unresolved ones', () => {
    const msgs = toOpenAIMessages(
      [
        node('user', [
          { type: 'text', text: 'Compare' },
          { type: 'file', fileId: 'f1', name: 'a.pdf', mime: 'application/pdf' },
          { type: 'file', fileId: 'f2', name: 'b.png', mime: 'image/png' },
          { type: 'file', fileId: 'f3', name: 'c.bin', mime: 'application/octet-stream' },
        ]),
      ],
      {
        resolveFile: (p) =>
          p.fileId === 'f1'
            ? { kind: 'text', text: 'PDF text', truncated: true }
            : p.fileId === 'f2'
              ? { kind: 'image', url: 'data:image/png;base64,AA' }
              : null,
      }
    );
    expect(msgs).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Compare\n\n<attachment name="a.pdf">\nPDF text\n[The rest of this file was cut off because it is too long.]\n</attachment>',
          },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
        ],
      },
    ]);
  });

  it('answers a tool call that has no result (run stopped mid-tool)', () => {
    const msgs = toOpenAIMessages([
      node('user', [{ type: 'text', text: 'go' }]),
      node('assistant', [{ type: 'tool_call', callId: 'c1', alias: 'x', serverId: 's', tool: 'x', args: '' }], { status: 'stopped' }),
    ]);
    expect(msgs.slice(1)).toEqual([
      { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"error":"No result: the run was stopped."}' },
    ]);
  });

  it('drops an empty assistant turn and keeps system text', () => {
    expect(
      toOpenAIMessages([
        node('system', [{ type: 'text', text: 'Be brief.' }]),
        node('user', [{ type: 'text', text: 'hi' }]),
        node('assistant', [], { status: 'error', error: 'HTTP 500' }),
      ])
    ).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('ignores citations when sending history', () => {
    expect(
      toOpenAIMessages([
        node('assistant', [
          { type: 'text', text: 'Revenue grew [1].' },
          { type: 'citation', index: 1, source: { kind: 'file', id: 'f', title: 'Q3.pdf' } },
        ]),
      ])
    ).toEqual([{ role: 'assistant', content: 'Revenue grew [1].' }]);
  });
});

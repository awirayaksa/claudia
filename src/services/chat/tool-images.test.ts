import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../types/api.types';
import type { MessageNode } from '../../types/turn.types';
import { toOpenAIMessages } from './message-builder';
import { OMITTED_IMAGE, elideStaleResults, hasToolImages, hoistToolImages, limitToolImages, stripToolImages } from './tool-images';
import { toAnthropicMessages } from '../api/providers/anthropic.provider';
import { normalizeToolResult } from '../mcp/tool-format';

const img = (n: number) => ({ type: 'image_url' as const, image_url: { url: `data:image/jpeg;base64,AAA${n}` } });
const call = (id: string): ChatMessage => ({ role: 'assistant', tool_calls: [{ id, type: 'function', function: { name: 'browser_screenshot', arguments: '{}' } }] });
const shot = (id: string, n: number): ChatMessage => ({ role: 'tool', tool_call_id: id, content: [{ type: 'text', text: `page ${n}` }, img(n)] });

describe('toOpenAIMessages with tool images', () => {
  const node: MessageNode = {
    id: 'a',
    chatId: 'c',
    parentId: null,
    role: 'assistant',
    status: 'completed',
    createdAt: '',
    parts: [
      { type: 'tool_call', callId: 'c1', alias: 'browser_screenshot', serverId: 'builtin-browser-001', tool: 'browser_screenshot', args: '{}' },
      { type: 'tool_result', callId: 'c1', content: 'x'.repeat(10_000), images: [{ fileId: 'f1', mime: 'image/jpeg' }] },
      { type: 'text', text: 'done' },
    ],
  };

  it('puts the resolved image in the tool message and applies the per-call length', () => {
    const out = toOpenAIMessages([node], {
      resolveToolImage: (i) => (i.fileId === 'f1' ? 'data:image/jpeg;base64,QQ' : null),
      toolResultChars: (c) => (c.serverId === 'builtin-browser-001' ? 16_000 : 4000),
    });
    const tool = out.find((m) => m.role === 'tool')!;
    expect(Array.isArray(tool.content)).toBe(true);
    const parts = tool.content as Array<{ type: string; text?: string }>;
    expect(parts[0].text).toHaveLength(10_000);
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QQ' } });
  });

  it('leaves the image out when it cannot be resolved', () => {
    const out = toOpenAIMessages([node]);
    const tool = out.find((m) => m.role === 'tool')!;
    expect(typeof tool.content).toBe('string');
    expect((tool.content as string).length).toBe(4000);
  });
});

describe('limitToolImages', () => {
  it('keeps the newest images and notes the dropped ones', () => {
    const msgs = [call('a'), shot('a', 1), call('b'), shot('b', 2), call('c'), shot('c', 3)];
    const out = limitToolImages(msgs, 2);
    expect(out[1].content).toBe(`page 1\n${OMITTED_IMAGE}`);
    expect(out[3]).toBe(msgs[3]);
    expect(out[5]).toBe(msgs[5]);
  });
});

describe('hoistToolImages', () => {
  it('moves a round of images to one user message after its last tool answer', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'look' },
      { role: 'assistant', tool_calls: [
        { id: 'a', type: 'function', function: { name: 's', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 's', arguments: '{}' } },
      ] },
      shot('a', 1),
      shot('b', 2),
    ];
    const out = hoistToolImages(msgs);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user']);
    expect(typeof out[2].content).toBe('string');
    expect(out[2].content).toContain('page 1');
    const images = (out[4].content as Array<{ type: string }>).filter((p) => p.type === 'image_url');
    expect(images).toHaveLength(2);
    expect(hasToolImages(out)).toBe(false);
  });
});

describe('stripToolImages', () => {
  it('replaces images with a note', () => {
    const out = stripToolImages([call('a'), shot('a', 1)], 'no images here');
    expect(out[1].content).toBe('page 1\nno images here');
  });
});

describe('elideStaleResults', () => {
  it('shrinks older results of the given calls to their first line', () => {
    const msgs: ChatMessage[] = ['a', 'b', 'c'].flatMap((id) => [call(id), { role: 'tool', tool_call_id: id, content: `Tab 1 · ${id}\nlots of page text` } as ChatMessage]);
    const out = elideStaleResults(msgs, new Set(['a', 'b', 'c']), 2, '[old]');
    expect(out[1].content).toBe('Tab 1 · a\n[old]');
    expect(out[3].content).toBe(msgs[3].content);
    expect(out[5].content).toBe(msgs[5].content);
  });
});

describe('Anthropic tool results with images', () => {
  it('sends image blocks inside tool_result', () => {
    const { messages } = toAnthropicMessages([{ role: 'user', content: 'go' }, call('a'), shot('a', 1)]);
    const result = messages[2].content[0] as { type: string; content: unknown };
    expect(result.type).toBe('tool_result');
    expect(result.content).toEqual([
      { type: 'text', text: 'page 1' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA1' } },
    ]);
  });
});

describe('normalizeToolResult images', () => {
  it('collects image items and keeps a marker in the text', () => {
    const r = normalizeToolResult({ content: [{ type: 'text', text: 'shot' }, { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' }] });
    expect(r.content).toBe('shot\n[Image: image/jpeg]');
    expect(r.images).toEqual([{ mime: 'image/jpeg', data: 'QUJD' }]);
  });
});

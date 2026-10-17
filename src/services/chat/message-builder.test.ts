/**
 * Characterization tests for how stored chat messages are turned into
 * OpenAI-compatible request messages, including the strict-provider rules
 * (Kimi, DeepSeek and strict proxies).
 */
import { describe, it, expect } from 'vitest';
import { buildAPIMessage, buildMessageContent } from './message-builder';
import type { Message } from '../../types/message.types';

const base = { id: 'm1', timestamp: '2026-01-01T00:00:00.000Z' };
const toolCall = { id: 'call_1', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } };

describe('buildMessageContent', () => {
  it('returns plain text when there are no image attachments', () => {
    expect(buildMessageContent('hello')).toBe('hello');
    expect(
      buildMessageContent('hello', [{ id: 'a', type: 'file', name: 'a.pdf', size: 1, mimeType: 'application/pdf' }])
    ).toBe('hello');
  });

  it('ignores image attachments without inline data', () => {
    expect(buildMessageContent('hi', [{ id: 'a', type: 'image', name: 'a.png', size: 1, mimeType: 'image/png' }])).toBe(
      'hi'
    );
  });

  it('builds multi-part content for images', () => {
    expect(
      buildMessageContent('look', [
        { id: 'a', type: 'image', name: 'a.png', size: 1, mimeType: 'image/png', data: 'data:image/png;base64,AAA' },
      ])
    ).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ]);
  });

  it('inlines extracted document text after the message', () => {
    expect(
      buildMessageContent('Summarize this', [
        { id: 'a', type: 'file', name: 'q3 "final".pdf', size: 1, mimeType: 'application/pdf', extractedText: 'Revenue up.' },
        { id: 'b', type: 'file', name: 'notes.txt', size: 1, mimeType: 'text/plain', extractedText: 'x', textTruncated: true },
        { id: 'c', type: 'file', name: 'remote.pdf', size: 1, mimeType: 'application/pdf', remoteFileId: 'f1' },
      ])
    ).toBe(
      'Summarize this\n\n' +
        "<attachment name=\"q3 'final'.pdf\">\nRevenue up.\n</attachment>\n\n" +
        '<attachment name="notes.txt">\nx\n[The rest of this file was cut off because it is too long.]\n</attachment>'
    );
  });

  it('puts inlined document text in the text part next to images', () => {
    expect(
      buildMessageContent('', [
        { id: 'a', type: 'file', name: 'a.txt', size: 1, mimeType: 'text/plain', extractedText: 'doc' },
        { id: 'b', type: 'image', name: 'b.png', size: 1, mimeType: 'image/png', data: 'data:x' },
      ])
    ).toEqual([
      { type: 'text', text: '<attachment name="a.txt">\ndoc\n</attachment>' },
      { type: 'image_url', image_url: { url: 'data:x' } },
    ]);
  });

  it('omits the text part when text is empty', () => {
    expect(
      buildMessageContent('', [
        { id: 'a', type: 'image', name: 'a.png', size: 1, mimeType: 'image/png', data: 'data:x' },
      ])
    ).toEqual([{ type: 'image_url', image_url: { url: 'data:x' } }]);
  });
});

describe('buildAPIMessage', () => {
  it('passes user and assistant text through', () => {
    expect(buildAPIMessage({ ...base, role: 'user', content: 'hi' })).toEqual({ role: 'user', content: 'hi' });
    expect(buildAPIMessage({ ...base, role: 'assistant', content: 'hello' })).toEqual({
      role: 'assistant',
      content: 'hello',
    });
  });

  it('omits content entirely on assistant messages with tool calls, even when there is text', () => {
    const msg: Message = { ...base, role: 'assistant', content: 'Let me check', toolCalls: [toolCall] };
    const api = buildAPIMessage(msg);
    expect(api).toEqual({ role: 'assistant', tool_calls: [toolCall] });
    expect('content' in api).toBe(false);
  });

  it('does not send an empty tool_calls array', () => {
    const api = buildAPIMessage({ ...base, role: 'assistant', content: 'x', toolCalls: [] });
    expect(api).toEqual({ role: 'assistant', content: 'x' });
  });

  it('echoes reasoning back as reasoning_content on assistant messages', () => {
    expect(buildAPIMessage({ ...base, role: 'assistant', content: 'a', reasoning: 'r' })).toEqual({
      role: 'assistant',
      content: 'a',
      reasoning_content: 'r',
    });
    expect(
      buildAPIMessage({ ...base, role: 'assistant', content: '', reasoning: 'r', toolCalls: [toolCall] })
    ).toEqual({ role: 'assistant', tool_calls: [toolCall], reasoning_content: 'r' });
  });

  it('does not add reasoning_content to user messages', () => {
    expect(buildAPIMessage({ ...base, role: 'user', content: 'a', reasoning: 'r' })).toEqual({
      role: 'user',
      content: 'a',
    });
  });

  it('replaces empty tool content with {} and drops the name field', () => {
    expect(
      buildAPIMessage({ ...base, role: 'tool', content: '  ', tool_call_id: 'call_1', name: 'read_file' })
    ).toEqual({ role: 'tool', content: '{}', tool_call_id: 'call_1' });
  });

  it('truncates long tool content to 4000 characters with an ellipsis', () => {
    const api = buildAPIMessage({ ...base, role: 'tool', content: 'x'.repeat(5000), tool_call_id: 'c' });
    expect(api.content).toHaveLength(4000);
    expect(String(api.content).endsWith('...')).toBe(true);
  });

  it('keeps name on non-tool messages', () => {
    expect(buildAPIMessage({ ...base, role: 'user', content: 'a', name: 'bob' })).toEqual({
      role: 'user',
      content: 'a',
      name: 'bob',
    });
  });
});

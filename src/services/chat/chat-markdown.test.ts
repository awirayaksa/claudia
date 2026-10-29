import { describe, it, expect } from 'vitest';
import { chatToMarkdown } from './chat-markdown';
import type { MessageNode } from '../../types/turn.types';

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

const path = [
  node('u', 'user', [{ type: 'text', text: 'Plot the sales' }, { type: 'file', fileId: 'f1', name: 'sales.csv', mime: 'text/csv' }]),
  node(
    'a',
    'assistant',
    [
      { type: 'reasoning', text: 'Load it first.' },
      { type: 'tool_call', callId: 'c1', alias: 'run_code', serverId: 'claudia', tool: 'run_code', args: '{"code":"print(1)"}' },
      { type: 'tool_result', callId: 'c1', content: '{"stdout":"1"}' },
      { type: 'text', text: 'Here is the chart:\n\n```python\nprint(```)\n```' },
      { type: 'file', fileId: 'f2', name: 'chart.png', mime: 'image/png' },
      { type: 'citation', index: 1, source: { kind: 'url', title: 'Sales report', url: 'https://example.com/r' } },
    ],
    { modelId: 'mock/gpt-test' }
  ),
];

describe('chatToMarkdown', () => {
  it('writes each turn with its attachments, folded tools and sources', () => {
    const md = chatToMarkdown({ title: 'Sales', path, modelName: () => 'GPT Test', exportedAt: new Date('2026-10-20T00:00:00Z') });
    expect(md).toMatch(/^# Sales\n\n_Exported from Claudia on 2026-10-20_/);
    expect(md).toContain('## You\n\nPlot the sales\n\n- 📎 sales.csv');
    expect(md).toContain('## GPT Test');
    expect(md).toContain('<details>\n<summary>Thinking</summary>');
    expect(md).toContain('<summary>Tool: run_code</summary>');
    expect(md).toContain('"code": "print(1)"');
    expect(md).toContain('- 📎 chart.png');
    expect(md).toContain('1. [Sales report](https://example.com/r)');
  });

  it('quotes instead of folding for PDF, and embeds images when given a reference', () => {
    const md = chatToMarkdown({ title: 'Sales', path, folding: 'quote', imageRef: (f) => `img-${f.fileId}` });
    expect(md).not.toContain('<details>');
    expect(md).toContain('> **Tool: run_code**');
    expect(md).toContain('![chart.png](img-f2)');
  });

  it("uses fences that the content's own backticks can't close", () => {
    const md = chatToMarkdown({
      title: 'x',
      path: [node('a', 'assistant', [{ type: 'tool_call', callId: 'c', alias: 't', serverId: 's', tool: 't', args: '{}' }, { type: 'tool_result', callId: 'c', content: 'a ``` b' }])],
    });
    expect(md).toContain('````\na ``` b\n````');
  });
});

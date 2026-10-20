import { describe, expect, it } from 'vitest';
import type { MessageNode } from '@/types/turn.types';
import { toDisplayMessage } from './to-display';

const reply = (parts: MessageNode['parts']): MessageNode =>
  ({ id: 'm1', chatId: 'c', parentId: null, role: 'assistant', parts, status: 'completed', createdAt: 0 }) as unknown as MessageNode;

describe('reply attachments', () => {
  it('link the files a tool wrote in the workspace, named by their path', () => {
    const message = toDisplayMessage(
      reply([
        { type: 'workspace_file', path: 'reports/2026/q3.md', size: 4 },
        { type: 'workspace_file', path: 'diagrams/flow.png', size: 900 },
        { type: 'text', text: 'Saved.' },
      ])
    );
    expect(message.attachments).toEqual([
      expect.objectContaining({
        name: 'reports/2026/q3.md',
        type: 'file',
        mimeType: 'text/markdown',
        size: 4,
        url: '/api/workspace-files/content?path=reports%2F2026%2Fq3.md',
      }),
      expect.objectContaining({ name: 'diagrams/flow.png', type: 'image', mimeType: 'image/png' }),
    ]);
  });
});

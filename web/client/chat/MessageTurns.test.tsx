// @vitest-environment jsdom
/** Below replies: the "memory updated" chip (with undo) and the divider where earlier turns were summarized. */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { createWebStore } from '../store';
import '../i18n';
import { MessageTurns } from './MessageTurns';
import type { MessageNode } from '@/types/turn.types';

beforeAll(() => {
  window.matchMedia ??= ((query: string) =>
    ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) as unknown as MediaQueryList);
});

const node = (id: string, role: 'user' | 'assistant', text: string, extra: Partial<MessageNode> = {}): MessageNode => ({
  id,
  chatId: 'c',
  parentId: null,
  role,
  parts: [{ type: 'text', text }],
  status: 'completed',
  createdAt: '2026-10-20T08:00:00.000Z',
  ...extra,
});

function renderTurns(path: MessageNode[], onUndoMemory = vi.fn()) {
  render(
    <Provider store={createWebStore()}>
      <MemoryRouter>
        <MessageTurns nodes={path} path={path} running={false} modelName={() => undefined} onUndoMemory={onUndoMemory} />
      </MemoryRouter>
    </Provider>
  );
  return onUndoMemory;
}

describe('message turns', () => {
  it('lists memory changes under the reply and undoes one', () => {
    const add = { id: 'ch1', action: 'add' as const, memoryId: 'm1', topic: 'work', content: 'Works at Acme', undone: false };
    const gone = { id: 'ch2', action: 'delete' as const, memoryId: 'm2', topic: 'work', content: 'Works at Initech', undone: true };
    const undo = renderTurns([node('u', 'user', 'I work at Acme now'), node('a', 'assistant', 'Noted.', { parentId: 'u', memoryChanges: [add, gone] })]);

    fireEvent.click(screen.getByRole('button', { name: /Memory updated/ }));
    expect(screen.getByText('Works at Acme')).toBeInTheDocument();
    expect(screen.getByText('Undone')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledWith(add);
  });

  it('shows where earlier turns were summarized, and the summary on request', () => {
    renderTurns([
      node('u1', 'user', 'First'),
      node('a1', 'assistant', 'One', { parentId: 'u1', compaction: { summary: 'They talked about one.', turns: 1 } }),
      node('u2', 'user', 'Second', { parentId: 'a1' }),
    ]);
    const divider = screen.getByTestId('compaction-divider');
    expect(divider).toHaveTextContent('The first exchange was summarized to fit the context');
    fireEvent.click(screen.getByText('The first exchange was summarized to fit the context'));
    expect(screen.getByText('They talked about one.')).toBeVisible();
  });
});

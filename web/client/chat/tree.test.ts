import { describe, it, expect } from 'vitest';
import type { MessageNode } from '@/types/turn.types';
import { childrenOf, leafUnder, modelColumns, siblingsOf } from './tree';

let clock = 0;
const node = (id: string, parentId: string | null, role: MessageNode['role'], extra: Partial<MessageNode> = {}): MessageNode => ({
  id,
  chatId: 'c',
  parentId,
  role,
  parts: [],
  status: 'completed',
  createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, clock++)).toISOString(),
  ...extra,
});

describe('message tree', () => {
  // u1 → a1, a1' (regenerated); a1 → u2 → a2; u1' (an edit of u1) → a3
  const nodes = [
    node('u1', null, 'user'),
    node('a1', 'u1', 'assistant'),
    node('u2', 'a1', 'user'),
    node('a2', 'u2', 'assistant'),
    node('a1b', 'u1', 'assistant'),
    node('u1b', null, 'user'),
    node('a3', 'u1b', 'assistant'),
  ];

  it('lists versions oldest first', () => {
    expect(siblingsOf(nodes, nodes[0]).map((n) => n.id)).toEqual(['u1', 'u1b']);
    expect(siblingsOf(nodes, nodes[1]).map((n) => n.id)).toEqual(['a1', 'a1b']);
    expect(childrenOf(nodes, 'u2').map((n) => n.id)).toEqual(['a2']);
  });

  it('follows the newest child down to a leaf', () => {
    expect(leafUnder(nodes, 'a1')).toBe('a2');
    expect(leafUnder(nodes, 'u1')).toBe('a1b');
    expect(leafUnder(nodes, 'u1b')).toBe('a3');
    expect(leafUnder(nodes, 'a2')).toBe('a2');
  });

  it('groups a multi-model turn into one column per model', () => {
    const turn = node('q', null, 'user', { models: ['m1', 'm2'] });
    const replies = [
      node('r1', 'q', 'assistant', { modelId: 'm1' }),
      node('r2', 'q', 'assistant', { modelId: 'm2' }),
      node('r1b', 'q', 'assistant', { modelId: 'm1' }),
    ];
    const cols = modelColumns([turn, ...replies], turn)!;
    expect(cols.map((c) => [c.modelId, c.versions.map((v) => v.id)])).toEqual([
      ['m1', ['r1', 'r1b']],
      ['m2', ['r2']],
    ]);
    expect(modelColumns(nodes, nodes[0])).toBeNull();
  });
});

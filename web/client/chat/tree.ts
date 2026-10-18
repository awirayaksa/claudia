/**
 * Navigating the message tree: siblings are versions (edits of a message,
 * regenerated or multi-model replies); the visible path ends at the chat's
 * current leaf.
 */
import type { MessageNode } from '@/types/turn.types';

const byAge = (a: MessageNode, b: MessageNode) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

export function childrenOf(nodes: MessageNode[], parentId: string | null): MessageNode[] {
  return nodes.filter((n) => n.parentId === parentId).sort(byAge);
}

/** The node's versions (itself included), oldest first. */
export function siblingsOf(nodes: MessageNode[], node: MessageNode): MessageNode[] {
  return childrenOf(nodes, node.parentId).filter((n) => n.role === node.role);
}

/** Where the path through `nodeId` ends: follow the newest child down. */
export function leafUnder(nodes: MessageNode[], nodeId: string): string {
  const kids = new Map<string, MessageNode[]>();
  for (const n of nodes) {
    if (!n.parentId) continue;
    const list = kids.get(n.parentId) ?? [];
    list.push(n);
    kids.set(n.parentId, list);
  }
  let id = nodeId;
  const seen = new Set<string>();
  for (;;) {
    seen.add(id);
    const next = (kids.get(id) ?? []).sort(byAge).at(-1);
    if (!next || seen.has(next.id)) return id;
    id = next.id;
  }
}

export interface ModelColumn {
  modelId: string;
  /** This model's answers to the turn, oldest first. */
  versions: MessageNode[];
}

/**
 * A turn asked of several models shows their answers side by side, one
 * column per model (each with its own versions). Null for a single-model turn.
 */
export function modelColumns(nodes: MessageNode[], userNode: MessageNode): ModelColumn[] | null {
  if (!userNode.models || userNode.models.length < 2) return null;
  const replies = childrenOf(nodes, userNode.id).filter((n) => n.role === 'assistant');
  const order = [...userNode.models, ...replies.map((r) => r.modelId ?? '')].filter((m, i, all) => all.indexOf(m) === i);
  return order
    .map((modelId) => ({ modelId, versions: replies.filter((r) => (r.modelId ?? '') === modelId) }))
    .filter((c) => c.versions.length > 0);
}

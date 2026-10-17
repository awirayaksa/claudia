/**
 * Turn nodes → the desktop's flat `Message` shape, so the shared ChatMessage
 * component renders them unchanged (linear UI; Phase 2 adds versions).
 */
import type { Message, ToolCall, ToolResult } from '@/types/message.types';
import type { MessageNode, PartOf } from '@/types/turn.types';

/** Root → leaf over all known nodes. */
export function visiblePath(nodes: MessageNode[], leafId: string | null): MessageNode[] {
  if (!leafId) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: MessageNode[] = [];
  const seen = new Set<string>();
  let cur = byId.get(leafId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return out.reverse();
}

export function nodeText(node: MessageNode, type: 'text' | 'reasoning' = 'text', separator = '\n\n'): string {
  return node.parts
    .filter((p): p is PartOf<'text'> | PartOf<'reasoning'> => p.type === type)
    .map((p) => p.text)
    .filter(Boolean)
    .join(separator);
}

export function toDisplayMessage(node: MessageNode): Message {
  if (node.role !== 'assistant') {
    return {
      id: node.id,
      role: node.role,
      content: nodeText(node, 'text', ''),
      timestamp: node.createdAt,
      attachments: node.parts
        .filter((p): p is PartOf<'file'> => p.type === 'file')
        .map((p) => ({
          id: p.fileId,
          type: p.mime.startsWith('image/') ? ('image' as const) : ('file' as const),
          name: p.name,
          size: p.size ?? 0,
          mimeType: p.mime,
        })),
      ...(node.effort ? { effort: node.effort } : {}),
    };
  }

  const calls = node.parts.filter((p): p is PartOf<'tool_call'> => p.type === 'tool_call');
  const results = node.parts.filter((p): p is PartOf<'tool_result'> => p.type === 'tool_result');
  const toolCalls: ToolCall[] = calls.map((c) => ({
    id: c.callId,
    type: 'function',
    function: { name: c.tool || c.alias, arguments: c.args },
  }));
  const toolResults: ToolResult[] = results.map((r) => {
    const call = calls.find((c) => c.callId === r.callId);
    return {
      tool_call_id: r.callId,
      role: 'tool',
      name: call?.tool || call?.alias || '',
      content: r.content,
      isError: r.isError,
      hasUI: !!r.uiResource,
      uiResource: r.uiResource,
      serverId: call?.serverId,
    };
  });

  return {
    id: node.id,
    role: 'assistant',
    content: nodeText(node),
    timestamp: node.createdAt,
    reasoning: nodeText(node, 'reasoning', '') || undefined,
    ...(toolCalls.length ? { toolCalls, toolResults } : {}),
    ...(node.usage ? { usage: node.usage } : {}),
    ...(node.status === 'error' ? { error: node.error ?? 'The reply failed.' } : {}),
  };
}

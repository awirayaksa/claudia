/**
 * Claudia desktop conversations (`conversations/[<projectId>/]<id>.json`)
 * and projects (`projects/<id>.json`). The desktop stores a reply as flat
 * records (assistant with tool calls → tool results → assistant); each run of
 * them between two user messages becomes one assistant node, as in the web
 * app. Attachments lived on the desktop's disk, so only their names come along.
 */
import type { ExportedChat } from '../chats';
import type { MessagePart } from '../../../src/types/turn.types';
import { clip, cleanTitle, finishChat, toIso, type Message } from './common';

interface DesktopMessage {
  id?: string;
  role?: string;
  content?: unknown;
  timestamp?: string;
  attachments?: Array<{ name?: string; mimeType?: string; size?: number }>;
  error?: string;
  toolCalls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  toolResults?: Array<{ tool_call_id?: string; content?: unknown; isError?: boolean; serverId?: string }>;
  tool_call_id?: string;
  reasoning?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
  effort?: string;
}

export interface DesktopConversation {
  id: string;
  projectId: string | null;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  model?: string;
  messages: DesktopMessage[];
  starred?: boolean;
}

export interface DesktopProject {
  id: string;
  name: string;
  settings?: { systemPrompt?: string };
}

export function isDesktopConversation(v: unknown): v is DesktopConversation {
  const o = v as Record<string, unknown>;
  return !!o && typeof o === 'object' && typeof o.id === 'string' && Array.isArray(o.messages) && 'projectId' in o;
}

export function isDesktopProject(v: unknown): v is DesktopProject {
  const o = v as Record<string, unknown>;
  return (
    !!o && typeof o === 'object' && typeof o.id === 'string' && typeof o.name === 'string' && !!o.settings && typeof o.settings === 'object' && !('messages' in o)
  );
}

const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);

const text = (c: unknown) => (typeof c === 'string' ? c : c == null ? '' : JSON.stringify(c));

function addUsage(a: Message['usage'], b: DesktopMessage['usage']): Message['usage'] {
  if (!b) return a;
  if (!a) return { ...b };
  return {
    prompt_tokens: (a.prompt_tokens ?? 0) + (b.prompt_tokens ?? 0),
    completion_tokens: (a.completion_tokens ?? 0) + (b.completion_tokens ?? 0),
    total_tokens: (a.total_tokens ?? 0) + (b.total_tokens ?? 0),
    ...(a.cost !== undefined || b.cost !== undefined ? { cost: (a.cost ?? 0) + (b.cost ?? 0) } : {}),
  };
}

export function convertDesktopConversation(conv: DesktopConversation, projectNames: Map<string, string>): ExportedChat {
  const now = toIso(conv.updatedAt, new Date().toISOString());
  const out: Message[] = [];
  let parentId: string | null = null;
  let reply: Message | null = null;
  const seenResults = new Set<string>();

  const closeReply = () => {
    if (reply) {
      out.push(reply);
      parentId = reply.id;
      reply = null;
    }
  };

  conv.messages.forEach((m, i) => {
    const id = `${conv.id}:${i}`;
    const createdAt = toIso(m.timestamp, now);
    if (m.role === 'user') {
      closeReply();
      const parts: MessagePart[] = [];
      const body = text(m.content);
      if (body) parts.push({ type: 'text', text: clip(body) });
      for (const a of m.attachments ?? []) {
        parts.push({ type: 'file', fileId: '', name: a.name ?? 'file', mime: a.mimeType ?? 'application/octet-stream', ...(a.size ? { size: a.size } : {}) });
      }
      out.push({
        id,
        parentId,
        role: 'user',
        parts,
        status: 'completed',
        ...(m.effort && EFFORTS.has(m.effort) ? { effort: m.effort as Message['effort'] } : {}),
        createdAt,
      });
      parentId = id;
      return;
    }
    if (m.role !== 'assistant' && m.role !== 'tool') return; // UI notes

    reply ??= { id, parentId, role: 'assistant', parts: [], status: 'completed', ...(conv.model ? { modelId: conv.model } : {}), createdAt };
    const r: Message = reply;
    if (m.role === 'tool') {
      const callId = m.tool_call_id ?? `${id}:result`;
      if (!seenResults.has(callId)) {
        seenResults.add(callId);
        r.parts.push({ type: 'tool_result', callId, content: clip(text(m.content)) });
      }
      return;
    }
    if (m.reasoning) r.parts.push({ type: 'reasoning', text: clip(m.reasoning) });
    const body = text(m.content);
    if (body) r.parts.push({ type: 'text', text: clip(body) });
    for (const call of m.toolCalls ?? []) {
      const name = call.function?.name ?? 'tool';
      r.parts.push({ type: 'tool_call', callId: call.id ?? `${id}:${name}`, alias: name, serverId: '', tool: name, args: call.function?.arguments ?? '{}' });
    }
    // Some versions keep the results on the assistant message as well
    for (const res of m.toolResults ?? []) {
      const callId = res.tool_call_id ?? '';
      if (!callId || seenResults.has(callId)) continue;
      seenResults.add(callId);
      r.parts.push({ type: 'tool_result', callId, content: clip(text(res.content)), ...(res.isError ? { isError: true } : {}) });
    }
    r.usage = addUsage(r.usage, m.usage);
    if (m.error) {
      r.status = 'error';
      r.error = m.error.slice(0, 10_000);
    }
  });
  closeReply();

  const folder = conv.projectId ? [projectNames.get(conv.projectId) ?? `Imported project ${conv.projectId.slice(0, 8)}`] : null;
  return finishChat({
    title: cleanTitle(conv.title),
    createdAt: toIso(conv.createdAt, now),
    updatedAt: now,
    modelIds: conv.model ? [conv.model] : [],
    pinned: !!conv.starred,
    folder: folder?.map((n) => n.slice(0, 100)) ?? null,
    messages: out,
  });
}

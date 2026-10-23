/**
 * Memory tools the model may call during a chat (when an admin turns them
 * on and the user lets it learn): look at, save, change and forget what it
 * remembers about the user. They run on the server, as the user.
 */
import type { ToolCall } from '../../../../src/types/message.types';
import { MAX_MEMORY_CHARS, MEMORY_TOPICS, type MemoryChangeView, type MemoryTopic } from '../../../shared/workspace';
import type { ToolExecution } from '../../llm/tools';
import type { MemoryStore } from './store';

export const MEMORY_TOOL_NAMES = new Set(['memory_view', 'memory_add', 'memory_update', 'memory_delete']);

/** What counts as sensitive (never saved unless the user allows it). */
export const SENSITIVE_HINT =
  'health (physical or mental), finances or debts, religion, political views, sexual orientation or sex life, ethnicity, immigration status, criminal or legal matters, or precise location';

const topicParam = {
  type: 'string',
  enum: [...MEMORY_TOPICS],
  description: 'about: who they are; work; preferences: how they like things done; projects: what they are working on; people: who they mention; other.',
};

export function memoryToolDefinitions(inProject: boolean) {
  return [
    {
      type: 'function' as const,
      function: {
        name: 'memory_view',
        description: 'List what you remember about the user, with ids (the list in the system prompt may be shortened).',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'memory_add',
        description:
          'Remember a lasting fact about the user for future chats: their background, work, preferences, ongoing projects or people they mention. ' +
          'Save it when they tell you something they would want remembered, or ask you to remember it. ' +
          "Don't save details that only matter for the current task, and don't save what is already remembered (update it instead). " +
          'Write one short fact in the third person, e.g. "Prefers TypeScript over JavaScript".',
        parameters: {
          type: 'object',
          properties: {
            topic: topicParam,
            content: { type: 'string', description: `The fact, at most ${MAX_MEMORY_CHARS} characters.` },
            sensitive: { type: 'boolean', description: `True if it is about ${SENSITIVE_HINT}.` },
            ...(inProject
              ? { scope: { type: 'string', enum: ['global', 'project'], description: "project: only for chats in this chat's project; global: every chat (default)." } }
              : {}),
          },
          required: ['topic', 'content', 'sensitive'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'memory_update',
        description: 'Correct or replace something you remember (e.g. the user changed jobs). Give its id from the memory list.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            content: { type: 'string', description: 'The new text of the fact.' },
            topic: topicParam,
          },
          required: ['id', 'content'],
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'memory_delete',
        description: 'Forget something you remember, when the user asks you to or it is no longer true. Give its id from the memory list.',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    },
  ];
}

export interface MemoryToolContext {
  userId: string;
  chatId: string;
  /** The chat's folder, for project memories. */
  folderId: string | null;
  /** The folders whose memories this chat sees (its folder and the ones above it). */
  folderIds: string[];
  /** The reply the changes are listed under. */
  messageId: string;
  /** The user lets sensitive topics be saved. */
  sensitive: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isTopic = (t: unknown): t is MemoryTopic => typeof t === 'string' && (MEMORY_TOPICS as readonly string[]).includes(t);

/** Run one memory tool call; `change` is what the chip under the reply shows. */
export async function runMemoryTool(
  store: MemoryStore,
  ctx: MemoryToolContext,
  call: ToolCall
): Promise<{ execution: ToolExecution; change: MemoryChangeView | null }> {
  const name = call.function.name;
  const done = (content: unknown, change: MemoryChangeView | null = null, isError = false) => ({
    execution: {
      serverId: 'claudia',
      tool: name,
      result: { type: 'tool_result' as const, callId: call.id, content: JSON.stringify(content), ...(isError ? { isError: true } : {}) },
    },
    change,
  });
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    return done({ error: 'Invalid arguments: expected JSON.' }, null, true);
  }

  // Only memories this chat can see may be changed through it
  const visible = async (id: unknown) => {
    if (typeof id !== 'string' || !UUID.test(id)) return null;
    const rows = await store.forChat(ctx.userId, ctx.folderIds);
    return rows.find((r) => r.id === id) ?? null;
  };
  const origin = { messageId: ctx.messageId };

  try {
    switch (name) {
      case 'memory_view': {
        const rows = await store.forChat(ctx.userId, ctx.folderIds);
        return done({
          memories: rows.map((r) => ({ id: r.id, topic: r.topic, content: r.content, scope: r.folderId ? 'project' : 'global' })),
        });
      }
      case 'memory_add': {
        const content = typeof args.content === 'string' ? args.content.trim() : '';
        if (!content) return done({ error: 'Give the fact to remember as "content".' }, null, true);
        if (args.sensitive === true && !ctx.sensitive) {
          return done({ saved: false, reason: "The user hasn't allowed sensitive topics to be remembered. Don't save it, and don't tell the user unless they asked you to remember it." });
        }
        const existing = await store.forChat(ctx.userId, ctx.folderIds);
        if (existing.some((r) => r.content.toLowerCase() === content.toLowerCase())) return done({ saved: false, reason: 'Already remembered.' });
        const { memory, change } = await store.add(
          ctx.userId,
          {
            content,
            topic: isTopic(args.topic) ? args.topic : 'other',
            source: 'model',
            folderId: args.scope === 'project' && ctx.folderId ? ctx.folderId : null,
            chatId: ctx.chatId,
          },
          origin
        );
        return done({ saved: true, id: memory.id }, change);
      }
      case 'memory_update': {
        const row = await visible(args.id);
        if (!row) return done({ error: 'There is no memory with that id. Call memory_view for the list.' }, null, true);
        const content = typeof args.content === 'string' ? args.content.trim() : '';
        if (!content) return done({ error: 'Give the new text as "content".' }, null, true);
        const { change } = await store.update(ctx.userId, row.id, { content, ...(isTopic(args.topic) ? { topic: args.topic } : {}) }, origin);
        return done({ updated: true }, change);
      }
      case 'memory_delete': {
        const row = await visible(args.id);
        if (!row) return done({ error: 'There is no memory with that id. Call memory_view for the list.' }, null, true);
        const { change } = await store.remove(ctx.userId, row.id, origin);
        return done({ deleted: true }, change);
      }
      default:
        return done({ error: `Unknown tool ${name}.` }, null, true);
    }
  } catch (err) {
    return done({ error: err instanceof Error ? err.message : String(err) }, null, true);
  }
}

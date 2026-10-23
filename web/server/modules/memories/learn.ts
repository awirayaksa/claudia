/**
 * Learning memories from chats, and importing another assistant's.
 *
 * Once a chat has been quiet for a while (no newer reply on its current
 * path), a job reads what was said since the last time and asks a model for
 * lasting facts, merged with what is already remembered: new ones are added,
 * outdated ones changed or forgotten. Temporary chats are never read, and
 * sensitive topics are skipped unless the user allows them. The changes are
 * listed under the reply, where they can be undone.
 */
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../../db/client';
import { chats, messages, users, type UserSettings } from '../../db/schema';
import type { JobQueue } from '../../jobs/queue';
import type { AppSettings } from '../settings/app-settings';
import type { ModelRegistry, ResolvedModel } from '../../llm/model-registry';
import { ChatRepo, pathTo, toNode } from '../chats/repo';
import { transcriptOf } from '../../llm/compaction';
import { MAX_MEMORIES, MAX_MEMORY_CHARS, MEMORY_TOPICS, type MemoryTopic } from '../../../shared/workspace';
import type { MemoryStore } from './store';
import type { FolderService } from '../chats/folders';
import { SENSITIVE_HINT } from './tools';
import type { MessageNode } from '../../../../src/types/turn.types';

const TASK_TIMEOUT_MS = 60_000;
/** The most recent part of a chat read for memories. */
const TRANSCRIPT_CHARS = 16_000;
/** At most this many new memories from one chat at a time. */
const MAX_ADDS = 10;

const isTopic = (t: unknown): t is MemoryTopic => typeof t === 'string' && (MEMORY_TOPICS as readonly string[]).includes(t);

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), TASK_TIMEOUT_MS);
    t.unref?.();
  });
  return Promise.race([promise, timeout]);
}

/** The first JSON object or array in a model's answer (fenced or not). */
export function parseJson(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const text = fenced ? fenced[1] : raw;
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  for (let end = text.length; end > start; end--) {
    const c = text[end - 1];
    if (c !== '}' && c !== ']') continue;
    try {
      return JSON.parse(text.slice(start, end));
    } catch {
      /* shorter */
    }
  }
  return null;
}

export interface LearnedChanges {
  add: Array<{ topic: MemoryTopic; content: string; sensitive: boolean; project: boolean }>;
  update: Array<{ id: string; content: string; topic?: MemoryTopic }>;
  delete: string[];
}

/** The extraction model's answer, cleaned: unknown fields dropped, lengths capped. */
export function parseLearned(raw: string): LearnedChanges {
  const json = parseJson(raw) as Record<string, unknown> | null;
  const out: LearnedChanges = { add: [], update: [], delete: [] };
  if (!json || typeof json !== 'object' || Array.isArray(json)) return out;
  for (const a of Array.isArray(json.add) ? json.add : []) {
    if (!a || typeof a.content !== 'string' || !a.content.trim()) continue;
    out.add.push({
      topic: isTopic(a.topic) ? a.topic : 'other',
      content: a.content.trim().slice(0, MAX_MEMORY_CHARS),
      sensitive: a.sensitive === true,
      project: a.scope === 'project',
    });
  }
  for (const u of Array.isArray(json.update) ? json.update : []) {
    if (!u || typeof u.id !== 'string' || typeof u.content !== 'string' || !u.content.trim()) continue;
    out.update.push({ id: u.id, content: u.content.trim().slice(0, MAX_MEMORY_CHARS), ...(isTopic(u.topic) ? { topic: u.topic } : {}) });
  }
  for (const d of Array.isArray(json.delete) ? json.delete : []) {
    const id = typeof d === 'string' ? d : d && typeof d.id === 'string' ? d.id : null;
    if (id) out.delete.push(id);
  }
  return out;
}

/**
 * The entries of another assistant's memory export: a JSON list (of strings,
 * or of objects with content / memory / text), or one entry per line, with
 * bullets, numbers and headings dropped.
 */
export function parseImport(text: string): string[] {
  const json = parseJson(text.trim().startsWith('[') || text.trim().startsWith('{') ? text : '');
  let items: unknown[] = [];
  if (Array.isArray(json)) items = json;
  else if (json && typeof json === 'object') {
    const list = Object.values(json as object).find(Array.isArray);
    if (list) items = list;
  }
  const entries =
    items.length > 0
      ? items.map((i) =>
          typeof i === 'string' ? i : i && typeof i === 'object' ? String((i as any).content ?? (i as any).memory ?? (i as any).text ?? '') : ''
        )
      : text.split(/\r?\n/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entries) {
    const line = e
      .trim()
      .replace(/^([-*•]|\d+[.)])\s*/, '')
      .replace(/^["'“”]+|["'“”,]+$/g, '')
      .trim();
    // Headings ("Preferences:", "## Work") and very short lines aren't memories
    if (line.length < 3 || /^#+\s/.test(line) || (line.endsWith(':') && line.length < 60)) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line.slice(0, MAX_MEMORY_CHARS));
  }
  return out;
}

const LEARN_INSTRUCTIONS =
  'You maintain the long-term memory an assistant keeps about a user. Read the conversation and decide what is worth remembering for future, unrelated chats: ' +
  'who the user is, their work, lasting preferences (languages, tools, style), ongoing projects, and people they mention. ' +
  'Skip details that only matter for the task at hand, things the assistant said, and guesses. ' +
  'Compare with what is already remembered: never add a duplicate; if a new fact replaces or contradicts a remembered one, update it; ' +
  'if the user says something is no longer true or asks to forget it, delete it. ' +
  `Mark a fact "sensitive" if it is about ${SENSITIVE_HINT}. ` +
  'Write each fact as one short sentence in the third person, in the language of the conversation. ' +
  'Reply with only JSON: {"add":[{"topic":"about|work|preferences|projects|people|other","content":"...","sensitive":false}],"update":[{"id":"...","content":"..."}],"delete":["id"]}. ' +
  'Use empty lists when there is nothing to change.';

export class MemoryLearner {
  private readonly repo: ChatRepo;

  constructor(
    private readonly deps: {
      db: Database;
      settings: AppSettings;
      models: ModelRegistry;
      store: MemoryStore;
      folders: FolderService;
      jobs: JobQueue;
      log: FastifyBaseLogger;
    }
  ) {
    this.repo = new ChatRepo(deps.db);
    deps.jobs.register('memory.extract', (p) => this.extract(String(p.userId), String(p.chatId), String(p.leafId)));
  }

  /** Whether the user lets Claudia learn memories (and an admin allows learning at all). */
  static learns(settings: UserSettings | undefined): boolean {
    return settings?.memory?.enabled !== false && settings?.memory?.learn !== false;
  }

  /** Read the chat for memories once it has been quiet for `delayMs`. */
  async schedule(userId: string, chatId: string, leafId: string, delayMs: number): Promise<void> {
    if (!(await this.deps.settings.get('memory')).extraction) return;
    await this.deps.jobs.enqueue('memory.extract', { userId, chatId, leafId }, { delayMs });
  }

  private async userSettings(userId: string): Promise<{ role: 'admin' | 'user' | 'pending'; settings: UserSettings } | null> {
    const [row] = await this.deps.db.select({ role: users.role, settings: users.settings }).from(users).where(eq(users.id, userId));
    return row ? { role: row.role, settings: row.settings ?? {} } : null;
  }

  /** The model for background memory work: the admin's pick, the task model, else `fallback`. */
  private async model(fallback: () => Promise<ResolvedModel | null>): Promise<ResolvedModel | null> {
    const picked = (await this.deps.settings.get('memory')).model ?? (await this.deps.settings.get('tasks')).titleModel;
    if (picked) {
      const resolved = await this.deps.models.resolve(picked, 'admin').catch(() => null);
      if (resolved) return resolved;
    }
    return fallback().catch(() => null);
  }

  async extract(userId: string, chatId: string, leafId: string): Promise<void> {
    if (!(await this.deps.settings.get('memory')).extraction) return;
    const user = await this.userSettings(userId);
    if (!user || !MemoryLearner.learns(user.settings)) return;
    const [chat] = await this.deps.db.select().from(chats).where(eq(chats.id, chatId));
    // Temporary chats never write memory; a newer reply has its own job
    if (!chat || chat.userId !== userId || chat.temporary || chat.currentLeafId !== leafId) return;

    const rows = await this.repo.messages(chatId);
    const path = pathTo(rows.map(toNode), leafId);
    const leaf = rows.find((r) => r.id === leafId);
    if (!leaf || leaf.role !== 'assistant' || leaf.meta?.memoryScanned) return;
    const scanned = new Set(rows.filter((r) => r.meta?.memoryScanned).map((r) => r.id));
    let from = 0;
    for (let i = path.length - 1; i >= 0; i--) {
      if (scanned.has(path[i].id)) {
        from = i + 1;
        break;
      }
    }
    const fresh = path.slice(from);
    const markScanned = () =>
      this.deps.db
        .update(messages)
        .set({ meta: { ...leaf.meta, memoryScanned: true } })
        .where(eq(messages.id, leafId));
    if (!fresh.some((n: MessageNode) => n.role === 'user')) return void (await markScanned());

    const model = await this.model(async () => (leaf.modelId ? this.deps.models.resolve(leaf.modelId, user.role, userId) : null));
    if (!model) return;
    const folderIds = (await this.deps.folders.chain({ id: userId, role: user.role }, chat.folderId)).map((f) => f.id);
    const known = await this.deps.store.forChat(userId, folderIds);
    const transcript = transcriptOf(fresh).slice(-TRANSCRIPT_CHARS);
    const res = await withTimeout(
      model.provider.chatCompletion({
        model: model.providerModelId,
        messages: [
          { role: 'system', content: LEARN_INSTRUCTIONS + (chat.folderId ? ' Add "scope":"project" to facts that only matter for this project.' : '') },
          {
            role: 'user',
            content:
              `Already remembered:\n${known.length ? known.map((m) => `[${m.id}] (${m.topic}) ${m.content}`).join('\n') : '(nothing)'}` +
              `\n\nThe conversation:\n${transcript}`,
          },
        ],
        stream: false,
        max_tokens: 800,
        temperature: 0.1,
      }),
      'Learning memories'
    );
    const content = res.choices[0]?.message?.content;
    const learned = parseLearned(typeof content === 'string' ? content : '');
    await this.apply(userId, chat, leafId, folderIds, learned, user.settings.memory?.sensitive === true);
    // Read again: the changes were added to the reply's meta in the meantime
    const [now] = await this.deps.db.select({ meta: messages.meta }).from(messages).where(eq(messages.id, leafId));
    await this.deps.db
      .update(messages)
      .set({ meta: { ...(now?.meta ?? {}), memoryScanned: true } })
      .where(eq(messages.id, leafId));
  }

  private async apply(
    userId: string,
    chat: typeof chats.$inferSelect,
    leafId: string,
    folderIds: string[],
    learned: LearnedChanges,
    sensitiveAllowed: boolean
  ): Promise<void> {
    const origin = { messageId: leafId };
    const known = await this.deps.store.forChat(userId, folderIds);
    const byId = new Map(known.map((m) => [m.id, m]));
    const texts = new Set(known.map((m) => m.content.toLowerCase()));
    for (const u of learned.update) {
      const row = byId.get(u.id);
      if (!row || row.content === u.content) continue;
      await this.deps.store.update(userId, row.id, { content: u.content, ...(u.topic ? { topic: u.topic } : {}) }, origin);
      texts.add(u.content.toLowerCase());
    }
    for (const id of new Set(learned.delete)) {
      if (byId.has(id)) await this.deps.store.remove(userId, id, origin);
    }
    let added = 0;
    for (const a of learned.add) {
      if (added >= MAX_ADDS || (a.sensitive && !sensitiveAllowed) || texts.has(a.content.toLowerCase())) continue;
      try {
        await this.deps.store.add(
          userId,
          { content: a.content, topic: a.topic, source: 'auto', folderId: a.project && chat.folderId ? chat.folderId : null, chatId: chat.id },
          origin
        );
      } catch (err) {
        // At the limit: keep what was saved so far
        this.deps.log.info({ err: String(err), userId }, 'memory not saved');
        break;
      }
      texts.add(a.content.toLowerCase());
      added++;
    }
  }

  /**
   * Import another assistant's memory export: each entry is sorted into a
   * topic by a model (when one is available) and added, skipping duplicates,
   * sensitive ones (unless allowed) and any beyond the limit.
   */
  async importText(userId: string, text: string): Promise<{ added: number; skipped: number }> {
    const user = await this.userSettings(userId);
    if (!user) return { added: 0, skipped: 0 };
    const entries = parseImport(text);
    const existing = await this.deps.store.list(userId);
    const known = new Set(existing.map((m) => m.content.toLowerCase()));
    const fresh = entries.filter((e) => !known.has(e.toLowerCase()));
    const room = Math.max(0, MAX_MEMORIES - existing.length);

    const labels = await this.classify(userId, user.role, fresh.slice(0, room)).catch((err) => {
      this.deps.log.warn({ err: String(err) }, 'sorting imported memories failed; importing them under "other"');
      return [] as Array<{ topic: MemoryTopic; sensitive: boolean }>;
    });
    let added = 0;
    for (const [i, content] of fresh.slice(0, room).entries()) {
      const label = labels[i] ?? { topic: 'other' as const, sensitive: false };
      if (label.sensitive && user.settings.memory?.sensitive !== true) continue;
      await this.deps.store.add(userId, { content, topic: label.topic, source: 'import' });
      added++;
    }
    return { added, skipped: entries.length - added };
  }

  private async classify(userId: string, role: 'admin' | 'user' | 'pending', entries: string[]) {
    if (entries.length === 0) return [];
    const model = await this.model(async () => {
      const id = await this.deps.models.defaultFor(role);
      return id ? this.deps.models.resolve(id, role, userId) : null;
    });
    if (!model) return [];
    const out: Array<{ topic: MemoryTopic; sensitive: boolean }> = [];
    // In batches, so a long export fits any model
    for (let i = 0; i < entries.length; i += 50) {
      const batch = entries.slice(i, i + 50);
      const res = await withTimeout(
        model.provider.chatCompletion({
          model: model.providerModelId,
          messages: [
            {
              role: 'system',
              content:
                `Sort each numbered memory into a topic (${MEMORY_TOPICS.join(', ')}) and say whether it is sensitive (about ${SENSITIVE_HINT}). ` +
                'Reply with only a JSON array, one {"topic":"...","sensitive":false} per memory, in order.',
            },
            { role: 'user', content: batch.map((e, n) => `${n + 1}. ${e}`).join('\n') },
          ],
          stream: false,
          max_tokens: 40 * batch.length,
          temperature: 0,
        }),
        'Sorting memories'
      );
      const content = res.choices[0]?.message?.content;
      const parsed = parseJson(typeof content === 'string' ? content : '');
      const list = Array.isArray(parsed) ? parsed : [];
      for (let n = 0; n < batch.length; n++) {
        const l = list[n] as { topic?: unknown; sensitive?: unknown } | undefined;
        out.push({ topic: isTopic(l?.topic) ? l.topic : 'other', sensitive: l?.sensitive === true });
      }
    }
    return out;
  }
}

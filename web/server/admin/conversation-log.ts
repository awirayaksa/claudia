/**
 * The conversation log: when "audit.conversations" is on, a copy of what a
 * user sent to a model and what it answered, one row per reply. It is kept
 * apart from the chats (editing or deleting a chat doesn't change it) and
 * only admins can read it; opening a turn or exporting goes in the audit
 * log. Recording never fails a reply. Turns older than the retention period
 * are removed daily.
 */
import { and, desc, eq, gte, ilike, lt, lte, or, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../db/client';
import { conversationLog } from '../db/schema';
import { uuidv7 } from '../lib/ids';
import type { AppSettings } from '../modules/settings/app-settings';
import type { MessagePart } from '../../../src/types/turn.types';
import {
  ConversationQuery,
  type ConversationPage,
  type ConversationSource,
  type ConversationTurn,
  type ConversationTurnSummary,
} from '../../shared/admin';

/** Longest prompt or reply kept (characters); longer ones are cut with a note. */
const MAX_TEXT = 200_000;
const MAX_TOOL_ARGS = 2_000;
const PREVIEW = 300;

export interface TurnInput {
  source: ConversationSource;
  user: { id: string; email: string };
  modelId: string;
  prompt: string;
  reply: string;
  status: string;
  error?: string | null;
  chatId?: string | null;
  chatTitle?: string | null;
  messageId?: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  details?: ConversationTurn['details'];
  ip?: string | null;
}

type Row = typeof conversationLog.$inferSelect;

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n… [${s.length - max} more characters not kept]` : s);
const preview = (s: string) => (s.length > PREVIEW ? `${s.slice(0, PREVIEW)}…` : s);

/** The text of a message's parts, and its attachments and tool calls. */
export function partsForLog(parts: MessagePart[]): { text: string; attachments: Array<{ name: string; mime?: string }>; toolCalls: Array<{ name: string; args: string }> } {
  const text = parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
  const attachments = parts.flatMap((p) =>
    p.type === 'file' ? [{ name: p.name, mime: p.mime }] : p.type === 'workspace_file' ? [{ name: p.path }] : []
  );
  const toolCalls = parts.flatMap((p) => (p.type === 'tool_call' ? [{ name: p.alias, args: cut(p.args, MAX_TOOL_ARGS) }] : []));
  return { text, attachments, toolCalls };
}

const toSummary = (r: Row): ConversationTurnSummary => ({
  id: r.id,
  createdAt: r.createdAt.toISOString(),
  source: r.source as ConversationSource,
  userId: r.userId,
  userEmail: r.userEmail,
  modelId: r.modelId,
  chatId: r.chatId,
  chatTitle: r.chatTitle,
  promptPreview: preview(r.prompt),
  replyPreview: preview(r.reply),
  status: r.status,
  promptTokens: r.promptTokens,
  completionTokens: r.completionTokens,
});

const toTurn = (r: Row): ConversationTurn => ({
  ...toSummary(r),
  prompt: r.prompt,
  reply: r.reply,
  error: r.error,
  messageId: r.messageId,
  details: r.details as ConversationTurn['details'],
  ip: r.ip,
});

const SOURCE_SETTING = { chat: 'chats', api: 'api', channel: 'channels' } as const;

const escapeLike = (s: string) => s.replace(/[%_\\]/g, (c) => `\\${c}`);

export class ConversationLog {
  private sweeper: NodeJS.Timeout;

  constructor(private readonly deps: { db: Database; settings: AppSettings; log: FastifyBaseLogger }) {
    this.sweeper = setInterval(() => void this.purge().catch(() => {}), 24 * 60 * 60 * 1000);
    this.sweeper.unref();
  }

  close(): void {
    clearInterval(this.sweeper);
  }

  /** Whether turns from `source` are being recorded now. */
  async recording(source: ConversationSource): Promise<boolean> {
    const s = await this.deps.settings.get('audit.conversations');
    return s.enabled && s[SOURCE_SETTING[source]];
  }

  /** Keep one turn (if recording is on for its source). Never throws. */
  async record(input: TurnInput): Promise<void> {
    try {
      if (!(await this.recording(input.source))) return;
      await this.deps.db.insert(conversationLog).values({
        id: uuidv7(),
        userId: input.user.id,
        userEmail: input.user.email,
        source: input.source,
        chatId: input.chatId ?? null,
        chatTitle: input.chatTitle ?? null,
        messageId: input.messageId ?? null,
        modelId: input.modelId,
        prompt: cut(input.prompt, MAX_TEXT),
        reply: cut(input.reply, MAX_TEXT),
        status: input.status,
        error: input.error ?? null,
        promptTokens: input.usage?.prompt_tokens ?? null,
        completionTokens: input.usage?.completion_tokens ?? null,
        details: Object.fromEntries(
          Object.entries(input.details ?? {}).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))
        ),
        ip: input.ip ?? null,
      });
    } catch (err) {
      this.deps.log.warn({ err: String(err), source: input.source }, 'writing the conversation log failed');
    }
  }

  private where(q: ReturnType<typeof ConversationQuery.parse>) {
    const text = q.q?.trim() ? `%${escapeLike(q.q.trim())}%` : null;
    return and(
      q.user ? ilike(conversationLog.userEmail, `%${escapeLike(q.user)}%`) : undefined,
      q.source ? eq(conversationLog.source, q.source) : undefined,
      text ? or(ilike(conversationLog.prompt, text), ilike(conversationLog.reply, text)) : undefined,
      q.chatId ? eq(conversationLog.chatId, q.chatId) : undefined,
      q.from ? gte(conversationLog.createdAt, new Date(q.from)) : undefined,
      q.to ? lte(conversationLog.createdAt, new Date(q.to)) : undefined,
      // uuidv7 ids sort by time
      q.before ? lt(conversationLog.id, q.before) : undefined
    );
  }

  private async page(raw: unknown): Promise<{ rows: Row[]; next: string | null }> {
    const q = ConversationQuery.parse(raw);
    const rows = await this.deps.db
      .select()
      .from(conversationLog)
      .where(this.where(q))
      .orderBy(desc(conversationLog.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    return { rows: page, next: rows.length > q.limit ? page.at(-1)!.id : null };
  }

  async list(raw: unknown): Promise<ConversationPage> {
    const { rows, next } = await this.page(raw);
    return { turns: rows.map(toSummary), next };
  }

  /** Full turns for an export, newest first (at most `max`). */
  async listFull(raw: unknown, max = 20_000): Promise<ConversationTurn[]> {
    const out: ConversationTurn[] = [];
    let before: string | undefined;
    while (out.length < max) {
      const { rows, next } = await this.page({ ...(raw as object), limit: 500, ...(before ? { before } : {}) });
      out.push(...rows.map(toTurn));
      if (!next) break;
      before = next;
    }
    return out.slice(0, max);
  }

  async get(id: string): Promise<ConversationTurn | null> {
    const [row] = await this.deps.db.select().from(conversationLog).where(eq(conversationLog.id, id));
    return row ? toTurn(row) : null;
  }

  /** Remove turns past the retention period. */
  async purge(now = new Date()): Promise<number> {
    const { retentionDays } = await this.deps.settings.get('audit.conversations');
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
    const deleted = await this.deps.db
      .delete(conversationLog)
      .where(lt(conversationLog.createdAt, cutoff))
      .returning({ id: conversationLog.id });
    return deleted.length;
  }

  async count(): Promise<number> {
    const [row] = await this.deps.db.select({ n: sql<number>`count(*)::int` }).from(conversationLog);
    return Number(row?.n ?? 0);
  }
}

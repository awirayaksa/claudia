/**
 * Usage analytics for admins, from `usage_events` (tokens and cost of every
 * model call), `chats` and `messages`. Days are UTC.
 */
import { desc, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { chats, messages, usageEvents, users } from '../db/schema';
import type { AnalyticsResponse, UsageTotals } from '../../shared/admin';

const DAY_MS = 24 * 60 * 60 * 1000;

const sums = {
  promptTokens: sql<string>`coalesce(sum(${usageEvents.promptTokens}), 0)`,
  completionTokens: sql<string>`coalesce(sum(${usageEvents.completionTokens}), 0)`,
  cost: sql<string>`coalesce(sum(${usageEvents.cost}), 0)`,
  requests: sql<string>`count(*)`,
};

const totals = (r: { promptTokens: string; completionTokens: string; cost: string; requests: string }): UsageTotals => ({
  promptTokens: Number(r.promptTokens),
  completionTokens: Number(r.completionTokens),
  cost: Number(r.cost),
  requests: Number(r.requests),
});

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export async function usageAnalytics(db: Database, days: number, now = new Date()): Promise<AnalyticsResponse> {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = new Date(today - (days - 1) * DAY_MS);
  const inRange = gte(usageEvents.createdAt, from);
  const day = sql<string>`to_char(${usageEvents.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;

  const [overall] = await db
    .select({ ...sums, activeUsers: sql<string>`count(distinct ${usageEvents.userId})` })
    .from(usageEvents)
    .where(inRange);
  const daily = await db
    .select({ day, ...sums, activeUsers: sql<string>`count(distinct ${usageEvents.userId})` })
    .from(usageEvents)
    .where(inRange)
    .groupBy(day);
  const byModel = await db
    .select({ modelId: usageEvents.modelId, ...sums })
    .from(usageEvents)
    .where(inRange)
    .groupBy(usageEvents.modelId)
    .orderBy(desc(sql`sum(${usageEvents.promptTokens} + ${usageEvents.completionTokens})`));
  const byKind = await db
    .select({ kind: usageEvents.kind, ...sums })
    .from(usageEvents)
    .where(inRange)
    .groupBy(usageEvents.kind)
    .orderBy(desc(sql`count(*)`));
  const byUser = await db
    .select({ userId: usageEvents.userId, email: users.email, name: users.name, ...sums })
    .from(usageEvents)
    .innerJoin(users, eq(users.id, usageEvents.userId))
    .where(inRange)
    .groupBy(usageEvents.userId, users.email, users.name)
    .orderBy(desc(sql`sum(${usageEvents.promptTokens} + ${usageEvents.completionTokens})`))
    .limit(25);
  const [chatCount] = await db
    .select({ n: sql<string>`count(*)` })
    .from(chats)
    .where(gte(chats.createdAt, from));
  const [messageCount] = await db
    .select({ n: sql<string>`count(*)` })
    .from(messages)
    .where(gte(messages.createdAt, from));

  const perDay = new Map(daily.map((d) => [d.day, d]));
  const byDay = Array.from({ length: days }, (_, i) => {
    const key = isoDay(new Date(from.getTime() + i * DAY_MS));
    const row = perDay.get(key);
    return {
      day: key,
      ...(row ? totals(row) : { promptTokens: 0, completionTokens: 0, cost: 0, requests: 0 }),
      activeUsers: Number(row?.activeUsers ?? 0),
    };
  });

  return {
    from: from.toISOString(),
    to: now.toISOString(),
    totals: {
      ...totals(overall),
      activeUsers: Number(overall.activeUsers),
      chats: Number(chatCount?.n ?? 0),
      messages: Number(messageCount?.n ?? 0),
    },
    byDay,
    byModel: byModel.map((r) => ({ modelId: r.modelId, ...totals(r) })),
    byUser: byUser.map((r) => ({ userId: r.userId, email: r.email, name: r.name, ...totals(r) })),
    byKind: byKind.map((r) => ({ kind: r.kind, ...totals(r) })),
  };
}

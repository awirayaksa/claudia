/**
 * Token and cost caps, from `usage_events`. Days and months are UTC. The
 * check runs before a request starts, so one reply may go past a cap; the
 * next request is refused. Costs count only where the provider reports them
 * (OpenRouter does). Admins are not capped.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { usageEvents } from '../../db/schema';
import { HttpError } from '../../lib/errors';
import type { AccessService, Principal } from '../../auth/access';
import type { DefaultCaps, UsageSummary } from '../../../shared/access';

export function periodStarts(now = new Date()): { day: Date; month: Date } {
  return {
    day: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
    month: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
  };
}

const formatTokens = (n: number) => n.toLocaleString('en-US');
const formatCost = (n: number) => `$${n.toFixed(2)}`;

export class UsageService {
  constructor(private readonly deps: { db: Database; access: AccessService }) {}

  async used(userId: string, now = new Date()): Promise<Omit<UsageSummary, 'caps'>> {
    const { day, month } = periodStarts(now);
    const tokens = sql`${usageEvents.promptTokens} + ${usageEvents.completionTokens}`;
    const [row] = await this.deps.db
      .select({
        dayTokens: sql<string>`coalesce(sum(${tokens}) filter (where ${usageEvents.createdAt} >= ${day}), 0)`,
        dayCost: sql<string>`coalesce(sum(${usageEvents.cost}) filter (where ${usageEvents.createdAt} >= ${day}), 0)`,
        monthTokens: sql<string>`coalesce(sum(${tokens}), 0)`,
        monthCost: sql<string>`coalesce(sum(${usageEvents.cost}), 0)`,
      })
      .from(usageEvents)
      .where(and(eq(usageEvents.userId, userId), gte(usageEvents.createdAt, month)));
    return {
      day: { tokens: Number(row?.dayTokens ?? 0), cost: Number(row?.dayCost ?? 0) },
      month: { tokens: Number(row?.monthTokens ?? 0), cost: Number(row?.monthCost ?? 0) },
    };
  }

  async summary(user: Principal): Promise<UsageSummary> {
    const caps: DefaultCaps =
      user.role === 'admin'
        ? { tokensPerDay: null, tokensPerMonth: null, costPerDay: null, costPerMonth: null }
        : await this.deps.access.capsFor(user);
    return { ...(await this.used(user.id)), caps };
  }

  /** Refuse (429 usage_cap) when a cap is already reached. */
  async check(user: Principal): Promise<void> {
    if (user.role === 'admin') return;
    const caps = await this.deps.access.capsFor(user);
    if (Object.values(caps).every((v) => v === null)) return;
    const used = await this.used(user.id);
    const reached = (
      [
        ['tokensPerDay', used.day.tokens, "today's token allowance", formatTokens, 'tomorrow (00:00 UTC)'],
        ['tokensPerMonth', used.month.tokens, "this month's token allowance", formatTokens, 'on the 1st (UTC)'],
        ['costPerDay', used.day.cost, "today's spending limit", formatCost, 'tomorrow (00:00 UTC)'],
        ['costPerMonth', used.month.cost, "this month's spending limit", formatCost, 'on the 1st (UTC)'],
      ] as const
    ).find(([key, value]) => caps[key] !== null && value >= (caps[key] as number));
    if (reached) {
      const [key, value, what, fmt, resets] = reached;
      throw new HttpError(
        429,
        'usage_cap',
        `You have used ${what} (${fmt(value)} of ${fmt(caps[key] as number)}). It resets ${resets}.`
      );
    }
  }
}

/**
 * Backoff after repeated failed logins for the same account: after
 * FREE_ATTEMPTS failures, each further failure locks the account for twice
 * as long (30 s, 60 s, … up to 15 minutes). In memory for one instance; in
 * Redis when several share the work, so a lock holds on every instance.
 */
import type { Redis } from 'ioredis';

const FREE_ATTEMPTS = 5;
const BASE_LOCK_MS = 30_000;
const MAX_LOCK_MS = 15 * 60_000;
/** Failures older than this are forgotten. */
const WINDOW_MS = 60 * 60_000;

/** How long the account is locked after its `failures`th failure in a row. */
function lockMs(failures: number): number {
  const over = failures - FREE_ATTEMPTS;
  return over > 0 ? Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** (over - 1)) : 0;
}

export interface LoginGuard {
  /** Milliseconds the account is still locked for, or 0. */
  lockedFor(key: string): Promise<number>;
  recordFailure(key: string): Promise<void>;
  recordSuccess(key: string): Promise<void>;
}

interface Entry {
  failures: number;
  lockedUntil: number;
  lastFailure: number;
}

export class MemoryLoginGuard implements LoginGuard {
  private entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  async lockedFor(key: string): Promise<number> {
    const e = this.entries.get(key);
    if (!e) return 0;
    if (this.now() - e.lastFailure > WINDOW_MS) {
      this.entries.delete(key);
      return 0;
    }
    return Math.max(0, e.lockedUntil - this.now());
  }

  async recordFailure(key: string): Promise<void> {
    const now = this.now();
    const prev = this.entries.get(key);
    const failures = prev && now - prev.lastFailure <= WINDOW_MS ? prev.failures + 1 : 1;
    const lock = lockMs(failures);
    this.entries.set(key, { failures, lockedUntil: lock > 0 ? now + lock : 0, lastFailure: now });
    if (this.entries.size > 50_000) this.prune();
  }

  async recordSuccess(key: string): Promise<void> {
    this.entries.delete(key);
  }

  private prune(): void {
    const now = this.now();
    for (const [k, e] of this.entries) if (now - e.lastFailure > WINDOW_MS) this.entries.delete(k);
  }
}

/** The failure count expires WINDOW_MS after the last failure; the lock is its own key. */
export class RedisLoginGuard implements LoginGuard {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string
  ) {}

  private keys(key: string) {
    return { failures: `${this.prefix}login:${key}:failures`, lock: `${this.prefix}login:${key}:lock` };
  }

  async lockedFor(key: string): Promise<number> {
    return Math.max(0, await this.redis.pttl(this.keys(key).lock));
  }

  async recordFailure(key: string): Promise<void> {
    const k = this.keys(key);
    const [[, failures]] = (await this.redis.multi().incr(k.failures).pexpire(k.failures, WINDOW_MS).exec()) as [[unknown, number]];
    const lock = lockMs(Number(failures));
    if (lock > 0) await this.redis.set(k.lock, '1', 'PX', lock);
  }

  async recordSuccess(key: string): Promise<void> {
    const k = this.keys(key);
    await this.redis.del(k.failures, k.lock);
  }
}

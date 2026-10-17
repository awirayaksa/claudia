/**
 * Backoff after repeated failed logins for the same account: after
 * FREE_ATTEMPTS failures, each further failure locks the account for twice
 * as long (30 s, 60 s, … up to 15 minutes). In memory; a multi-instance
 * deployment moves this to Redis (Phase 6).
 */

const FREE_ATTEMPTS = 5;
const BASE_LOCK_MS = 30_000;
const MAX_LOCK_MS = 15 * 60_000;
/** Failures older than this are forgotten. */
const WINDOW_MS = 60 * 60_000;

interface Entry {
  failures: number;
  lockedUntil: number;
  lastFailure: number;
}

export class LoginGuard {
  private entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Milliseconds the account is still locked for, or 0. */
  lockedFor(key: string): number {
    const e = this.entries.get(key);
    if (!e) return 0;
    if (this.now() - e.lastFailure > WINDOW_MS) {
      this.entries.delete(key);
      return 0;
    }
    return Math.max(0, e.lockedUntil - this.now());
  }

  recordFailure(key: string): void {
    const now = this.now();
    const prev = this.entries.get(key);
    const failures = prev && now - prev.lastFailure <= WINDOW_MS ? prev.failures + 1 : 1;
    const over = failures - FREE_ATTEMPTS;
    const lockedUntil = over > 0 ? now + Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** (over - 1)) : 0;
    this.entries.set(key, { failures, lockedUntil, lastFailure: now });
    if (this.entries.size > 50_000) this.prune();
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  private prune(): void {
    const now = this.now();
    for (const [k, e] of this.entries) if (now - e.lastFailure > WINDOW_MS) this.entries.delete(k);
  }
}

/**
 * Several app instances behind one load balancer share PostgreSQL and, for
 * what would otherwise live in one process's memory, Redis (REDIS_URL):
 * - live replies (the run hub) and WebSocket events, over pub/sub;
 * - rate limits and the login backoff;
 * - "this changed" signals, so the other instances drop their caches and
 *   restart a shared tool server an admin edited.
 * Without REDIS_URL everything stays in this process: one instance only.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';

export type BusHandler = (message: string) => void;

export interface Bus {
  publish(channel: string, message: string): Promise<void>;
  /** Resolves once messages on `channel` are being received; returns the unsubscribe. */
  subscribe(channel: string, handler: BusHandler): Promise<() => void>;
}

function deliver(handlers: Set<BusHandler> | undefined, message: string): void {
  for (const h of [...(handlers ?? [])]) {
    try {
      h(message);
    } catch {
      // one broken subscriber doesn't stop the others
    }
  }
}

/** One process: messages go straight to this process's subscribers. */
export class LocalBus implements Bus {
  private handlers = new Map<string, Set<BusHandler>>();

  async publish(channel: string, message: string): Promise<void> {
    const set = this.handlers.get(channel);
    queueMicrotask(() => deliver(set, message));
  }

  async subscribe(channel: string, handler: BusHandler): Promise<() => void> {
    let set = this.handlers.get(channel);
    if (!set) this.handlers.set(channel, (set = new Set()));
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0 && this.handlers.get(channel) === set) this.handlers.delete(channel);
    };
  }
}

/** Redis pub/sub: one subscriber connection per instance, shared by every channel. */
export class RedisBus implements Bus {
  private handlers = new Map<string, Set<BusHandler>>();

  constructor(
    private readonly pub: Redis,
    private readonly sub: Redis
  ) {
    sub.on('message', (channel: string, message: string) => deliver(this.handlers.get(channel), message));
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.pub.publish(channel, message);
  }

  async subscribe(channel: string, handler: BusHandler): Promise<() => void> {
    let set = this.handlers.get(channel);
    if (!set) this.handlers.set(channel, (set = new Set()));
    set.add(handler);
    // Commands on one connection run in order, so this also wins over an unsubscribe still in flight
    await this.sub.subscribe(channel);
    return () => {
      set.delete(handler);
      if (set.size === 0 && this.handlers.get(channel) === set) {
        this.handlers.delete(channel);
        void this.sub.unsubscribe(channel).catch(() => {});
      }
    };
  }
}

type SignalHandler = (data: Record<string, unknown>) => void | Promise<void>;

export class Cluster {
  /** This process, in messages to the others. */
  readonly instanceId = randomUUID();
  private signals = new Map<string, SignalHandler[]>();

  private constructor(
    readonly bus: Bus,
    /** Commands (null without REDIS_URL). */
    readonly redis: Redis | null,
    private readonly sub: Redis | null,
    readonly prefix: string,
    private readonly log: FastifyBaseLogger
  ) {}

  static async open(opts: { redisUrl?: string; prefix?: string; log: FastifyBaseLogger }): Promise<Cluster> {
    const prefix = opts.prefix ?? 'claudia:';
    if (!opts.redisUrl) {
      const cluster = new Cluster(new LocalBus(), null, null, prefix, opts.log);
      return cluster;
    }
    const { Redis } = await import('ioredis');
    const redis = new Redis(opts.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });
    const sub = redis.duplicate();
    for (const [name, conn] of [
      ['commands', redis],
      ['subscriber', sub],
    ] as const) {
      conn.on('error', (err: Error) => opts.log.warn({ err: err.message, connection: name }, 'Redis connection error'));
    }
    await Promise.all([redis.connect(), sub.connect()]);
    const cluster = new Cluster(new RedisBus(redis, sub), redis, sub, prefix, opts.log);
    await cluster.bus.subscribe(cluster.key('signal'), (raw) => cluster.receive(raw));
    return cluster;
  }

  /** Several instances may be running (Redis is configured). */
  get distributed(): boolean {
    return this.redis !== null;
  }

  key(...parts: string[]): string {
    return this.prefix + parts.join(':');
  }

  /** Tell the other instances that `name` changed. This instance has already acted on it. */
  signal(name: string, data: Record<string, unknown> = {}): void {
    if (!this.redis) return;
    void this.bus
      .publish(this.key('signal'), JSON.stringify({ from: this.instanceId, name, data }))
      .catch((err) => this.log.warn({ err: String(err), signal: name }, 'sending a cluster signal failed'));
  }

  /** Run `handler` when another instance signals `name`. */
  on(name: string, handler: SignalHandler): void {
    this.signals.set(name, [...(this.signals.get(name) ?? []), handler]);
  }

  private receive(raw: string): void {
    let msg: { from?: string; name?: string; data?: Record<string, unknown> };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.from === this.instanceId || !msg.name) return;
    for (const handler of this.signals.get(msg.name) ?? []) {
      void Promise.resolve()
        .then(() => handler(msg.data ?? {}))
        .catch((err) => this.log.warn({ err: String(err), signal: msg.name }, 'handling a cluster signal failed'));
    }
  }

  /** Throws when Redis is configured but doesn't answer. */
  async ping(): Promise<void> {
    if (this.redis) await this.redis.ping();
  }

  async close(): Promise<void> {
    await Promise.all([this.sub?.quit().catch(() => {}), this.redis?.quit().catch(() => {})]);
  }
}

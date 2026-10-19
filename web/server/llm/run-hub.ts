/**
 * Live completion runs. Each run buffers its events with sequence numbers, so
 * a client that reconnects (or another tab) can resume with `after=<seq>`.
 * A disconnected client does not stop a run; only POST /stop does.
 *
 * A run executes on the instance that started it. With Redis (several
 * instances) it is also recorded there: its owner, its events (a list, and a
 * pub/sub channel for live followers), the branch lock and the user's
 * running count. Any instance can then follow, stop or answer it; stops and
 * browser tool answers travel to the owner over a control channel. Keys
 * expire LIVE_TTL_MS after the owner's last heartbeat, so an instance that
 * dies releases its locks and its followers are told the run failed.
 */
import type { FastifyBaseLogger } from 'fastify';
import { conflict, notFound, tooManyRequests } from '../lib/errors';
import { uuidv7 } from '../lib/ids';
import type { Cluster } from '../cluster/cluster';
import type { RunEvent, RunEventEnvelope, RunStatus } from '../../shared/run-events';

/** Finished runs stay replayable this long. */
const KEEP_FINISHED_MS = 5 * 60_000;
/** A browser tool must answer within this time, or the call fails. */
export const CLIENT_TOOL_TIMEOUT_MS = 120_000;
/** Redis keys of a running run live this long past the owner's last heartbeat. */
const LIVE_TTL_MS = 60_000;
const HEARTBEAT_MS = 20_000;
/** How often a follower on another instance checks that the run's owner is alive. */
const WATCHDOG_MS = 15_000;

type Listener = (e: RunEventEnvelope) => void;

export interface Run {
  id: string;
  userId: string;
  chatId: string;
  /** One active run per branch point. */
  lockKey: string;
  events: RunEventEnvelope[];
  listeners: Set<Listener>;
  done: boolean;
  status: RunStatus | null;
  controller: AbortController;
  startedAt: number;
  finishedAt: number | null;
  pendingClientTools: Map<string, (result: ClientToolResult) => void>;
}

/** A run as any instance sees it. */
export interface RunInfo {
  id: string;
  userId: string;
  chatId: string;
  done: boolean;
  /** Events so far. */
  lastSeq: number;
}

export interface ClientToolResult {
  content: string;
  isError?: boolean;
  /** The user's files the tool produced (the code interpreter's output files). */
  fileIds?: string[];
}

type Control =
  | { op: 'stop'; runId: string }
  | { op: 'tool'; runId: string; callId: string; result: ClientToolResult };

// Refuse a second run on the branch point or one over the user's limit, else take the lock
// KEYS: lock, user's runs, chat's runs. ARGV: run id, now, ttl, max. Returns {code, running}.
const START_SCRIPT = `
if redis.call('exists', KEYS[1]) == 1 then return {-1, 0} end
redis.call('zremrangebyscore', KEYS[2], '-inf', ARGV[2])
local n = redis.call('zcard', KEYS[2])
if n >= tonumber(ARGV[4]) then return {-2, n} end
local expires = tonumber(ARGV[2]) + tonumber(ARGV[3])
redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[3])
redis.call('zadd', KEYS[2], expires, ARGV[1])
redis.call('pexpire', KEYS[2], ARGV[3])
redis.call('zremrangebyscore', KEYS[3], '-inf', ARGV[2])
redis.call('zadd', KEYS[3], expires, ARGV[1])
redis.call('pexpire', KEYS[3], ARGV[3])
return {1, n + 1}`;

// Extend (ARGV[2] = ttl) or release (no ARGV[2]) the lock, only while this run holds it
const LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[2] then return redis.call('pexpire', KEYS[1], ARGV[2]) end
return redis.call('del', KEYS[1])`;

export class RunHub {
  private runs = new Map<string, Run>();
  private locks = new Map<string, string>();
  private gcTimer: NodeJS.Timeout;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private ready: Promise<unknown> = Promise.resolve();
  private unsubscribeControl: (() => void) | null = null;

  constructor(private readonly opts: { cluster?: Cluster; log?: FastifyBaseLogger } = {}) {
    this.gcTimer = setInterval(() => this.gc(), 60_000);
    this.gcTimer.unref();
    if (this.redis) {
      this.ready = this.cluster!.bus.subscribe(this.key('runs', 'control'), (raw) => this.control(raw)).then((unsub) => {
        this.unsubscribeControl = unsub;
      });
      this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
      this.heartbeatTimer.unref();
    }
  }

  private get cluster(): Cluster | undefined {
    return this.opts.cluster?.distributed ? this.opts.cluster : undefined;
  }

  private get redis() {
    return this.opts.cluster?.redis ?? null;
  }

  private key(...parts: string[]): string {
    return this.opts.cluster!.key(...parts);
  }

  private keys(run: { id: string; userId: string; chatId: string; lockKey: string }) {
    return {
      meta: this.key('run', run.id),
      events: this.key('run', run.id, 'events'),
      pending: this.key('run', run.id, 'pending'),
      channel: this.key('run', run.id, 'live'),
      lock: this.key('runlock', run.lockKey),
      userRuns: this.key('user-runs', run.userId),
      chatRuns: this.key('chat-runs', run.chatId),
    };
  }

  private warn(err: unknown, what: string): void {
    this.opts.log?.warn({ err: err instanceof Error ? err.message : String(err) }, what);
  }

  /**
   * Register a run. Refuses a second run on the same branch point, and more
   * than `maxConcurrent` running runs for one user.
   */
  async start(opts: { userId: string; chatId: string; lockKey: string; maxConcurrent: number }): Promise<Run> {
    const id = uuidv7();
    const redis = this.redis;
    if (redis) {
      await this.ready;
      const k = this.keys({ id, ...opts });
      const [code, running] = (await redis.eval(START_SCRIPT, 3, k.lock, k.userRuns, k.chatRuns, id, Date.now(), LIVE_TTL_MS, opts.maxConcurrent)) as [number, number];
      if (code === -1) throw conflict('A reply is already being written here. Wait for it or stop it first.', 'run_in_progress');
      if (code === -2) throw tooManyRequests(`You already have ${running} replies being written. Wait for one to finish.`, 'too_many_runs');
      await redis
        .multi()
        .hset(k.meta, { userId: opts.userId, chatId: opts.chatId, lockKey: opts.lockKey, owner: this.opts.cluster!.instanceId, status: '' })
        .pexpire(k.meta, LIVE_TTL_MS)
        .exec();
    } else {
      if (this.locks.has(opts.lockKey)) {
        throw conflict('A reply is already being written here. Wait for it or stop it first.', 'run_in_progress');
      }
      const running = [...this.runs.values()].filter((r) => r.userId === opts.userId && !r.done).length;
      if (running >= opts.maxConcurrent) {
        throw tooManyRequests(`You already have ${running} replies being written. Wait for one to finish.`, 'too_many_runs');
      }
    }
    const run: Run = {
      id,
      userId: opts.userId,
      chatId: opts.chatId,
      lockKey: opts.lockKey,
      events: [],
      listeners: new Set(),
      done: false,
      status: null,
      controller: new AbortController(),
      startedAt: Date.now(),
      finishedAt: null,
      pendingClientTools: new Map(),
    };
    this.runs.set(run.id, run);
    this.locks.set(opts.lockKey, run.id);
    return run;
  }

  emit(run: Run, event: RunEvent): void {
    if (run.done) return;
    const envelope = { seq: run.events.length + 1, event };
    run.events.push(envelope);
    for (const l of run.listeners) {
      try {
        l(envelope);
      } catch {
        run.listeners.delete(l);
      }
    }
    const redis = this.redis;
    if (redis) {
      // One connection sends commands in order, and MULTI keeps the list and the channel in step
      const k = this.keys(run);
      const json = JSON.stringify(envelope);
      void redis
        .multi()
        .rpush(k.events, json)
        .pexpire(k.events, LIVE_TTL_MS)
        .publish(k.channel, json)
        .exec()
        .catch((err) => this.warn(err, 'recording a run event in Redis failed'));
    }
  }

  /** Emit run.completed, release the lock and keep the events for late readers. */
  finish(run: Run, status: RunStatus): void {
    if (run.done) return;
    this.emit(run, { type: 'run.completed', runId: run.id, status });
    run.done = true;
    run.status = status;
    run.finishedAt = Date.now();
    this.locks.delete(run.lockKey);
    for (const resolve of run.pendingClientTools.values()) {
      resolve({ content: JSON.stringify({ error: 'The run ended before the browser answered.' }), isError: true });
    }
    run.pendingClientTools.clear();
    run.listeners.clear();
    const redis = this.redis;
    if (redis) {
      const k = this.keys(run);
      void redis
        .multi()
        .hset(k.meta, 'status', status)
        .pexpire(k.meta, KEEP_FINISHED_MS)
        .pexpire(k.events, KEEP_FINISHED_MS)
        .del(k.pending)
        .zrem(k.userRuns, run.id)
        .zrem(k.chatRuns, run.id)
        .eval(LOCK_SCRIPT, 1, k.lock, run.id)
        .exec()
        .catch((err) => this.warn(err, 'finishing a run in Redis failed'));
    }
  }

  /** A run this instance executes (or executed recently). */
  get(runId: string): Run | undefined {
    return this.runs.get(runId);
  }

  private info(run: Run): RunInfo {
    return { id: run.id, userId: run.userId, chatId: run.chatId, done: run.done, lastSeq: run.events.length };
  }

  private async remoteInfo(runId: string): Promise<RunInfo | null> {
    const redis = this.redis;
    if (!redis) return null;
    const [[, meta], [, length]] = (await redis
      .multi()
      .hgetall(this.key('run', runId))
      .llen(this.key('run', runId, 'events'))
      .exec()) as [[unknown, Record<string, string>], [unknown, number]];
    if (!meta?.userId) return null;
    return { id: runId, userId: meta.userId, chatId: meta.chatId, done: meta.status !== '', lastSeq: Number(length) };
  }

  /** The run, on any instance, if it belongs to this user. */
  async find(runId: string, userId: string): Promise<RunInfo> {
    const local = this.runs.get(runId);
    const info = local ? this.info(local) : await this.remoteInfo(runId);
    if (!info || info.userId !== userId) throw notFound('Run');
    return info;
  }

  /** Runs still going in this chat, on any instance. */
  async activeForChat(chatId: string): Promise<RunInfo[]> {
    const redis = this.redis;
    if (!redis) return [...this.runs.values()].filter((r) => r.chatId === chatId && !r.done).map((r) => this.info(r));
    const ids = await redis.zrangebyscore(this.key('chat-runs', chatId), Date.now(), '+inf');
    const infos = await Promise.all(ids.map((id) => (this.runs.has(id) ? this.info(this.runs.get(id)!) : this.remoteInfo(id))));
    return infos.filter((r): r is RunInfo => !!r && !r.done);
  }

  /**
   * Replay events after `after`, then follow live ones. Resolves to the
   * unsubscribe function; a finished run replays and ends.
   */
  async subscribe(ref: { id: string }, after: number, listener: Listener): Promise<() => void> {
    const run = this.runs.get(ref.id);
    if (run) {
      for (const e of run.events) if (e.seq > after) listener(e);
      if (run.done) return () => {};
      run.listeners.add(listener);
      return () => run.listeners.delete(listener);
    }
    const redis = this.redis;
    if (!redis) return () => {};

    // Another instance runs it: listen first, then read what was already recorded
    let last = after;
    let ended = false;
    let buffered: RunEventEnvelope[] | null = [];
    let unsubscribe = () => {};
    let watchdog: NodeJS.Timeout | null = null;
    const end = () => {
      if (ended) return;
      ended = true;
      if (watchdog) clearInterval(watchdog);
      unsubscribe();
    };
    const deliver = (e: RunEventEnvelope) => {
      if (ended || e.seq <= last) return;
      last = e.seq;
      listener(e);
      if (e.event.type === 'run.completed') end();
    };
    unsubscribe = await this.cluster!.bus.subscribe(this.key('run', ref.id, 'live'), (raw) => {
      const e = JSON.parse(raw) as RunEventEnvelope;
      if (buffered) buffered.push(e);
      else deliver(e);
    });
    try {
      // Event n is at index n - 1
      for (const raw of await redis.lrange(this.key('run', ref.id, 'events'), after, -1)) deliver(JSON.parse(raw));
    } finally {
      const pending = buffered ?? [];
      buffered = null;
      for (const e of pending.sort((a, b) => a.seq - b.seq)) deliver(e);
    }
    if (!ended) {
      // The owner died: its keys expire and nothing more will come
      watchdog = setInterval(() => {
        void redis
          .exists(this.key('run', ref.id))
          .then((n) => {
            if (n === 0) deliver({ seq: last + 1, event: { type: 'run.completed', runId: ref.id, status: 'error' } });
          })
          .catch(() => {});
      }, WATCHDOG_MS);
      watchdog.unref();
    }
    return end;
  }

  async stop(ref: { id: string }): Promise<void> {
    const run = this.runs.get(ref.id);
    if (run) {
      if (!run.done) run.controller.abort();
      return;
    }
    await this.sendControl({ op: 'stop', runId: ref.id });
  }

  /** Ask the browser to run a tool and wait for its answer (or time out). */
  awaitClientTool(run: Run, callId: string, timeoutMs = CLIENT_TOOL_TIMEOUT_MS): Promise<ClientToolResult> {
    const redis = this.redis;
    const pendingKey = redis ? this.keys(run).pending : '';
    if (redis) {
      void redis
        .multi()
        .sadd(pendingKey, callId)
        .pexpire(pendingKey, LIVE_TTL_MS)
        .exec()
        .catch((err) => this.warn(err, 'recording a browser tool call in Redis failed'));
    }
    return new Promise((resolve) => {
      const done = (result: ClientToolResult) => {
        clearTimeout(timer);
        run.pendingClientTools.delete(callId);
        if (redis) void redis.srem(pendingKey, callId).catch(() => {});
        resolve(result);
      };
      const timer = setTimeout(() => done({ content: JSON.stringify({ error: 'No browser answered this tool call in time.' }), isError: true }), timeoutMs);
      timer.unref?.();
      run.pendingClientTools.set(callId, done);
    });
  }

  /** The browser's answer to tool.client_request. False when nothing was waiting (or another answer won). */
  async submitClientTool(ref: { id: string }, callId: string, result: ClientToolResult): Promise<boolean> {
    const redis = this.redis;
    // The first answer, on whichever instance, takes the call
    if (redis && (await redis.srem(this.key('run', ref.id, 'pending'), callId)) === 0) return false;
    const run = this.runs.get(ref.id);
    if (run) {
      const resolve = run.pendingClientTools.get(callId);
      if (!resolve) return false;
      resolve(result);
      return true;
    }
    if (!redis) return false;
    await this.sendControl({ op: 'tool', runId: ref.id, callId, result });
    return true;
  }

  private async sendControl(message: Control): Promise<void> {
    if (!this.redis) return;
    await this.cluster!.bus.publish(this.key('runs', 'control'), JSON.stringify(message));
  }

  /** A stop or a browser answer from another instance, for a run that may be ours. */
  private control(raw: string): void {
    let msg: Control;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const run = this.runs.get(msg.runId);
    if (!run || run.done) return;
    if (msg.op === 'stop') run.controller.abort();
    else if (msg.op === 'tool') run.pendingClientTools.get(msg.callId)?.(msg.result);
  }

  /** Keep this instance's running runs alive in Redis. */
  private heartbeat(): void {
    const redis = this.redis;
    if (!redis) return;
    const expires = Date.now() + LIVE_TTL_MS;
    for (const run of this.runs.values()) {
      if (run.done) continue;
      const k = this.keys(run);
      void redis
        .multi()
        .eval(LOCK_SCRIPT, 1, k.lock, run.id, LIVE_TTL_MS)
        .pexpire(k.meta, LIVE_TTL_MS)
        .pexpire(k.events, LIVE_TTL_MS)
        .pexpire(k.pending, LIVE_TTL_MS)
        .zadd(k.userRuns, expires, run.id)
        .pexpire(k.userRuns, LIVE_TTL_MS)
        .zadd(k.chatRuns, expires, run.id)
        .pexpire(k.chatRuns, LIVE_TTL_MS)
        .exec()
        .catch((err) => this.warn(err, 'run heartbeat failed'));
    }
  }

  close(): void {
    clearInterval(this.gcTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.unsubscribeControl?.();
    for (const run of this.runs.values()) run.controller.abort();
  }

  private gc(): void {
    const now = Date.now();
    for (const [id, run] of this.runs) {
      if (run.done && run.finishedAt && now - run.finishedAt > KEEP_FINISHED_MS) this.runs.delete(id);
    }
  }
}

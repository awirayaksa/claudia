/**
 * Live completion runs. Each run buffers its events with sequence numbers, so
 * a client that reconnects (or another tab) can resume with `after=<seq>`.
 * A disconnected client does not stop a run; only POST /stop does.
 *
 * In memory: a multi-instance deployment moves this to Redis pub/sub (Phase 6).
 */
import { conflict, notFound, tooManyRequests } from '../lib/errors';
import { uuidv7 } from '../lib/ids';
import type { RunEvent, RunEventEnvelope, RunStatus } from '../../shared/run-events';

/** Finished runs stay replayable this long. */
const KEEP_FINISHED_MS = 5 * 60_000;
/** A browser tool must answer within this time, or the call fails. */
export const CLIENT_TOOL_TIMEOUT_MS = 120_000;

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

export interface ClientToolResult {
  content: string;
  isError?: boolean;
}

export class RunHub {
  private runs = new Map<string, Run>();
  private locks = new Map<string, string>();
  private gcTimer: NodeJS.Timeout;

  constructor() {
    this.gcTimer = setInterval(() => this.gc(), 60_000);
    this.gcTimer.unref();
  }

  /**
   * Register a run. Refuses a second run on the same branch point, and more
   * than `maxConcurrent` running runs for one user.
   */
  start(opts: { userId: string; chatId: string; lockKey: string; maxConcurrent: number }): Run {
    if (this.locks.has(opts.lockKey)) {
      throw conflict('A reply is already being written here. Wait for it or stop it first.', 'run_in_progress');
    }
    const running = [...this.runs.values()].filter((r) => r.userId === opts.userId && !r.done).length;
    if (running >= opts.maxConcurrent) {
      throw tooManyRequests(`You already have ${running} replies being written. Wait for one to finish.`, 'too_many_runs');
    }
    const run: Run = {
      id: uuidv7(),
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
  }

  get(runId: string): Run | undefined {
    return this.runs.get(runId);
  }

  /** The run, if it belongs to this user. */
  getOwned(runId: string, userId: string): Run {
    const run = this.runs.get(runId);
    if (!run || run.userId !== userId) throw notFound('Run');
    return run;
  }

  activeForChat(chatId: string): Run[] {
    return [...this.runs.values()].filter((r) => r.chatId === chatId && !r.done);
  }

  /**
   * Replay events after `after`, then follow live ones. Returns the
   * unsubscribe function; a finished run replays and ends.
   */
  subscribe(run: Run, after: number, listener: Listener): () => void {
    for (const e of run.events) if (e.seq > after) listener(e);
    if (run.done) return () => {};
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  stop(run: Run): void {
    if (!run.done) run.controller.abort();
  }

  /** Ask the browser to run a tool and wait for its answer (or time out). */
  awaitClientTool(run: Run, callId: string, timeoutMs = CLIENT_TOOL_TIMEOUT_MS): Promise<ClientToolResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        run.pendingClientTools.delete(callId);
        resolve({ content: JSON.stringify({ error: 'No browser answered this tool call in time.' }), isError: true });
      }, timeoutMs);
      timer.unref?.();
      run.pendingClientTools.set(callId, (result) => {
        clearTimeout(timer);
        run.pendingClientTools.delete(callId);
        resolve(result);
      });
    });
  }

  /** The browser's answer to tool.client_request. False when nothing was waiting. */
  submitClientTool(run: Run, callId: string, result: ClientToolResult): boolean {
    const resolve = run.pendingClientTools.get(callId);
    if (!resolve) return false;
    resolve(result);
    return true;
  }

  close(): void {
    clearInterval(this.gcTimer);
    for (const run of this.runs.values()) run.controller.abort();
  }

  private gc(): void {
    const now = Date.now();
    for (const [id, run] of this.runs) {
      if (run.done && run.finishedAt && now - run.finishedAt > KEEP_FINISHED_MS) this.runs.delete(id);
    }
  }
}

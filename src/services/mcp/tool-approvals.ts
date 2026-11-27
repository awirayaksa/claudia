/**
 * Tool calls waiting for the user (desktop). The tool loop waits on a call
 * here; the approval card answers it. Kept outside the store: it holds the
 * loop's resolvers, which aren't serializable.
 */
import type { ToolTarget } from './tool-integration.service';

/** Allow once, always allow (saved for the tool), or deny. */
export type ApprovalDecision = 'once' | 'always' | 'deny';

interface Waiting {
  target: ToolTarget;
  resolve: (decision: ApprovalDecision | 'stopped') => void;
}

const waiting = new Map<string, Waiting>();

/**
 * Wait until the user answers this call. Stopping the chat (`signal`)
 * resolves it as 'stopped'.
 */
export function waitForApproval(callId: string, target: ToolTarget, signal?: AbortSignal): Promise<ApprovalDecision | 'stopped'> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve('stopped');
    const done = (decision: ApprovalDecision | 'stopped') => {
      waiting.delete(callId);
      signal?.removeEventListener('abort', onAbort);
      resolve(decision);
    };
    const onAbort = () => done('stopped');
    signal?.addEventListener('abort', onAbort, { once: true });
    waiting.set(callId, { target, resolve: done });
  });
}

/** Answer a waiting call. False when nothing waits on it (already answered, or from an earlier session). */
export function answerApproval(callId: string, decision: ApprovalDecision): boolean {
  const entry = waiting.get(callId);
  if (!entry) return false;
  entry.resolve(decision);
  return true;
}

/** What a waiting call would run, or undefined. */
export function approvalTarget(callId: string): ToolTarget | undefined {
  return waiting.get(callId)?.target;
}

/** The other waiting calls to the same tool (answered too when one is always allowed). */
export function waitingCallsFor(target: ToolTarget): string[] {
  return [...waiting.entries()]
    .filter(([, w]) => w.target.serverId === target.serverId && w.target.tool === target.tool)
    .map(([id]) => id);
}

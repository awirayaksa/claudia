/**
 * Follow a run's events over SSE. EventSource reconnects by itself (and sends
 * Last-Event-ID, so nothing is lost); when the connection is refused — most
 * likely an expired session — the session is refreshed and the stream
 * reopened from the last event seen.
 */
import { refreshSession } from '../api/http';
import type { RunEventEnvelope } from '@shared/run-events';

const MAX_REOPENS = 5;

export function followRun(
  runId: string,
  after: number,
  onEvent: (e: RunEventEnvelope) => void,
  onEnd: () => void
): () => void {
  let lastSeq = after;
  let reopens = 0;
  let source: EventSource | null = null;
  let stopped = false;

  const open = () => {
    if (stopped) return;
    source = new EventSource(`/api/runs/${runId}/events?after=${lastSeq}`, { withCredentials: true });
    source.addEventListener('run', (msg) => {
      const envelope = JSON.parse((msg as MessageEvent).data) as RunEventEnvelope;
      lastSeq = Math.max(lastSeq, envelope.seq);
      reopens = 0;
      onEvent(envelope);
      if (envelope.event.type === 'run.completed') {
        stop();
        onEnd();
      }
    });
    source.onerror = async () => {
      if (stopped || !source) return;
      // CONNECTING: the browser is retrying on its own
      if (source.readyState !== EventSource.CLOSED) return;
      source = null;
      if (++reopens > MAX_REOPENS || !(await refreshSession())) {
        stop();
        onEnd();
        return;
      }
      open();
    };
  };

  const stop = () => {
    stopped = true;
    source?.close();
    source = null;
  };

  open();
  return stop;
}

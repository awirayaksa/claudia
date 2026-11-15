/**
 * Agent tasks keep going while the user is elsewhere: when one finishes and
 * the tab is in the background, a browser notification says so (once the
 * user allowed notifications, asked the first time they send a task).
 */
import type { LiveRun } from './run-slice';

/** What to say about a finished run, if it was an agent task. */
export function taskOutcome(live: LiveRun | undefined): { title: string; body: string } | null {
  if (!live) return null;
  const nodes = Object.values(live.nodes);
  const turn = nodes.find((n) => n.role === 'user' && n.task);
  if (!turn?.task) return null;
  const reply = nodes.find((n) => n.role === 'assistant');
  const todo = reply?.parts.find((p) => p.type === 'todo');
  const steps = todo?.type === 'todo' ? `${todo.items.filter((i) => i.status === 'completed').length}/${todo.items.length} steps · ` : '';
  const failed = reply?.status === 'error';
  const stopped = reply?.status === 'stopped';
  return {
    title: failed ? 'Task stopped with a problem' : stopped ? 'Task stopped' : 'Task done',
    body: `${live.title ? `${live.title} · ` : ''}${steps}${turn.task.folder}`,
  };
}

/** Ask once (the first task sent) whether the browser may notify. */
export function askToNotify(): void {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission();
  } catch {
    /* not supported */
  }
}

/** Tell the user a task finished, if the tab is in the background and notifications are allowed. */
export function notifyTaskDone(chatId: string, live: LiveRun | undefined): void {
  const outcome = taskOutcome(live);
  if (!outcome || typeof document === 'undefined' || !document.hidden) return;
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const n = new Notification(outcome.title, { body: outcome.body, tag: live?.runId });
    n.onclick = () => {
      window.focus();
      // The router follows history changes
      window.history.pushState({}, '', `/c/${chatId}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
      n.close();
    };
  } catch {
    /* not supported */
  }
}

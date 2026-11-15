/**
 * An agent task's plan, as the model keeps it with its todo tool: a
 * checklist with progress, updated live while the task runs.
 */
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { MessageNode, TodoItem } from '@/types/turn.types';

export function todoOf(node: MessageNode): TodoItem[] | null {
  const part = node.parts.find((p) => p.type === 'todo');
  return part?.type === 'todo' ? part.items : null;
}

export function TodoChecklist({ items, running }: { items: TodoItem[]; running: boolean }) {
  const { t } = useTranslation();
  const done = items.filter((i) => i.status === 'completed').length;
  return (
    <div className="mb-3 rounded-lg border border-border bg-surface p-3 text-sm" data-testid="task-checklist">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-medium">{t('task.plan')}</span>
        <span className="text-xs text-text-secondary" data-testid="task-progress">
          {t('task.progress', { done, total: items.length })}
        </span>
      </div>
      <div className="mb-2 h-1 overflow-hidden rounded bg-border" aria-hidden>
        <div className="h-full bg-accent transition-all" style={{ width: `${items.length ? (done / items.length) * 100 : 0}%` }} />
      </div>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-2" data-status={item.status}>
            <span className="mt-0.5 w-4 shrink-0 text-center" aria-label={t(`task.status.${item.status}`)}>
              {item.status === 'completed' ? (
                <span className="text-accent">✓</span>
              ) : item.status === 'in_progress' ? (
                <span className={running ? 'inline-block animate-pulse text-accent' : 'text-text-secondary'}>●</span>
              ) : (
                <span className="text-text-secondary">○</span>
              )}
            </span>
            <span className={item.status === 'completed' ? 'text-text-secondary line-through' : item.status === 'in_progress' ? 'font-medium' : ''}>
              {item.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Under a task's message: the folder it works in, opening it in Settings → Files. */
export function TaskChip({ folder }: { folder: string }) {
  const { t } = useTranslation();
  return (
    <Link
      to={`/settings?tab=files&dir=${encodeURIComponent(folder)}`}
      className="max-w-[20rem] truncate rounded-full border border-border px-2 py-0.5 text-text-secondary hover:text-text-primary"
      title={t('task.openFolder')}
      data-testid="task-chip"
    >
      <span className="me-1 text-accent">⚙</span>
      {t('task.chip', { folder })}
    </Link>
  );
}

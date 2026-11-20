import { useT } from '../../i18n';

/** Where earlier exchanges were summarized to fit the context window; opens to show the summary. */
export function CompactionDivider({ summary, turns }: { summary: string; turns: number }) {
  const t = useT();
  return (
    <details className="group my-4 text-xs text-text-secondary" data-testid="compaction-divider">
      <summary className="flex cursor-pointer list-none items-center gap-3 [&::-webkit-details-marker]:hidden">
        <span className="h-px flex-1 bg-border" />
        <span className="rounded-full border border-border px-2.5 py-0.5 hover:border-accent hover:text-accent">
          {turns === 1
            ? t('chat.compacted_one', 'The first exchange was summarized to fit the context')
            : t('chat.compacted_other', 'The first {{count}} exchanges were summarized to fit the context', { count: turns })}
        </span>
        <span className="h-px flex-1 bg-border" />
      </summary>
      <div className="mt-2 rounded-lg border border-border bg-surface p-3 text-sm text-text-primary">
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-text-secondary">
          {t('chat.compactedSummary', 'Summary the model sees instead')}
        </p>
        <p className="whitespace-pre-wrap">{summary}</p>
      </div>
    </details>
  );
}

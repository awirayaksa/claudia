import { useEffect, useRef } from 'react';
import type { CitationSource } from '../../types/turn.types';
import { useT } from '../../i18n';

export interface CitationItem {
  index: number;
  source: CitationSource;
}

/** Where a source points, for display: "report.pdf · Vacation · p. 4", or the host of a URL. */
export function sourceLabel(source: CitationSource): string {
  const section = source.section ? ` · ${source.section.split(' › ').pop()}` : '';
  const page = `${section}${source.page ? ` · p. ${source.page}` : ''}`;
  if (source.kind === 'url' && source.url) {
    try {
      return `${source.title || new URL(source.url).hostname}${page}`;
    } catch {
      return source.title || source.url;
    }
  }
  return `${source.title}${page}`;
}

/**
 * The sources a reply cites, as numbered chips; the active one (picked here
 * or from an inline [n]) shows its snippet. Web links open in a new tab;
 * `onOpen` lets the host open other kinds (e.g. a referenced chat).
 */
export function Citations({
  citations,
  active,
  onActiveChange,
  onOpen,
}: {
  citations: CitationItem[];
  active: number | null;
  onActiveChange: (index: number | null) => void;
  onOpen?: (source: CitationSource) => void;
}) {
  const t = useT();
  const detailRef = useRef<HTMLDivElement>(null);
  const current = citations.find((c) => c.index === active) ?? null;

  useEffect(() => {
    if (current) detailRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [current]);

  if (citations.length === 0) return null;
  return (
    <div className="mt-3 text-xs" data-testid="citations">
      <div className="mb-1.5 font-medium uppercase tracking-wide text-text-secondary">{t('citations.sources', 'Sources')}</div>
      <ul className="flex flex-wrap gap-1.5">
        {citations.map((c) => (
          <li key={c.index}>
            <button
              type="button"
              aria-expanded={active === c.index}
              onClick={() => onActiveChange(active === c.index ? null : c.index)}
              className={`flex max-w-[16rem] items-center gap-1.5 rounded-full border px-2 py-0.5 text-left transition-colors ${
                active === c.index ? 'border-accent bg-accent/10 text-text-primary' : 'border-border text-text-secondary hover:border-accent'
              }`}
              title={sourceLabel(c.source)}
            >
              <span className="font-semibold text-accent">{c.index}</span>
              <span className="truncate">{sourceLabel(c.source)}</span>
            </button>
          </li>
        ))}
      </ul>
      {current && (
        <div ref={detailRef} className="mt-2 rounded-lg border border-border bg-surface p-3" data-testid="citation-detail">
          <div className="mb-1 flex items-start gap-2">
            <span className="font-semibold text-accent">[{current.index}]</span>
            <span className="min-w-0 flex-1 break-words font-medium text-text-primary">{sourceLabel(current.source)}</span>
            {current.source.kind === 'url' && current.source.url ? (
              <a href={current.source.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-accent underline hover:no-underline">
                {t('citations.open', 'Open')}
              </a>
            ) : (
              onOpen &&
              current.source.kind === 'chat' && (
                <button type="button" className="shrink-0 text-accent underline hover:no-underline" onClick={() => onOpen(current.source)}>
                  {t('citations.open', 'Open')}
                </button>
              )
            )}
          </div>
          {current.source.snippet && <p className="whitespace-pre-wrap text-text-secondary">{current.source.snippet}</p>}
        </div>
      )}
    </div>
  );
}

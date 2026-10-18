import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Banner } from '@shared/admin';
import { useBannersQuery } from '../api/rtk-api';

const DISMISSED_KEY = 'claudia.dismissedBanners';

function readDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function writeDismissed(ids: string[]): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids.slice(-100)));
  } catch {
    // Private windows may refuse: the banner just comes back next time
  }
}

const STYLES: Record<Banner['type'], string> = {
  info: 'border-accent/40 bg-accent/10',
  success: 'border-success/40 bg-success/10',
  warning: 'border-amber-500/50 bg-amber-500/10',
  error: 'border-error/40 bg-error/10',
};

/** Plain text with http(s) links made clickable (never HTML). */
export function linkify(text: string): ReactNode[] {
  return text.split(/(https?:\/\/[^\s<>"']+)/g).map((part, i) =>
    i % 2 === 1 ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="underline">
        {part}
      </a>
    ) : (
      part
    )
  );
}

/** The admin's notices, above every signed-in page. Dismissals are remembered in this browser. */
export function BannerBar() {
  const { t } = useTranslation();
  // A new or changed notice shows up within five minutes
  const { data } = useBannersQuery(undefined, { pollingInterval: 5 * 60_000 });
  const [dismissed, setDismissed] = useState(readDismissed);
  const shown = (data?.banners ?? []).filter((b) => !(b.dismissible && dismissed.includes(b.id)));
  if (shown.length === 0) return null;

  const dismiss = (id: string) => {
    const next = [...dismissed, id];
    setDismissed(next);
    writeDismissed(next);
  };

  return (
    <div className="shrink-0 space-y-1 px-3 pt-2" data-testid="banners">
      {shown.map((b) => (
        <div
          key={b.id}
          role={b.type === 'error' || b.type === 'warning' ? 'alert' : 'status'}
          className={`flex items-start gap-3 rounded-md border px-3 py-2 text-sm ${STYLES[b.type]}`}
        >
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{linkify(b.content)}</p>
          {b.dismissible && (
            <button
              className="shrink-0 rounded px-1 text-text-secondary hover:text-text-primary"
              aria-label={t('banners.dismiss')}
              onClick={() => dismiss(b.id)}
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

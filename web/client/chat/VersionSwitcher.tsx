import { useTranslation } from 'react-i18next';

/** `< 2/3 >` between the versions of a message. */
export function VersionSwitcher({
  index,
  count,
  onChange,
  disabled,
}: {
  /** 0-based. */
  index: number;
  count: number;
  onChange: (index: number) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  if (count < 2) return null;
  const btn = 'rounded px-1.5 py-0.5 text-text-secondary hover:bg-surface hover:text-text-primary disabled:opacity-30 disabled:hover:bg-transparent';
  return (
    <span className="inline-flex items-center gap-0.5 text-xs text-text-secondary" data-testid="version-switcher">
      <button
        type="button"
        className={btn}
        aria-label={t('chat.previousVersion')}
        disabled={disabled || index === 0}
        onClick={() => onChange(index - 1)}
      >
        ‹
      </button>
      <span className="tabular-nums" aria-live="polite">
        {index + 1}/{count}
      </span>
      <button
        type="button"
        className={btn}
        aria-label={t('chat.nextVersion')}
        disabled={disabled || index === count - 1}
        onClick={() => onChange(index + 1)}
      >
        ›
      </button>
    </span>
  );
}

import { useTranslation } from 'react-i18next';
import { CAP_KEYS, PERMISSION_KEYS, type CapKey, type PermissionKey } from '@shared/access';

/** Checkboxes for permission keys (defaults: every key; groups: the ones they add). */
export function PermissionChecks({
  value,
  onChange,
  inherited,
}: {
  value: Partial<Record<PermissionKey, boolean>>;
  onChange: (next: Partial<Record<PermissionKey, boolean>>) => void;
  /** Keys everyone already has (shown checked and disabled on groups). */
  inherited?: Partial<Record<PermissionKey, boolean>>;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-1.5 sm:grid-cols-2">
      {PERMISSION_KEYS.map((key) => {
        const fromDefaults = !!inherited?.[key];
        return (
          <label key={key} className="flex items-start gap-2 text-sm" title={fromDefaults ? t('access.fromDefaults') : undefined}>
            <input
              type="checkbox"
              className="mt-0.5"
              checked={fromDefaults || !!value[key]}
              disabled={fromDefaults}
              onChange={(e) => onChange({ ...value, [key]: e.target.checked })}
              data-testid={`perm-${key}`}
            />
            <span>
              {t(`access.permissions.${key}`)}
              {fromDefaults && <span className="ml-1 text-xs text-text-secondary">({t('access.everyone')})</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}

type CapValues = Partial<Record<CapKey, number | null>>;

/**
 * Number fields for usage caps. Empty means "no limit" (defaults, overrides)
 * or "not set" (groups, which only raise caps); `unset` tells them apart.
 */
export function CapsFields({
  value,
  onChange,
  emptyLabel,
  unset = 'null',
}: {
  value: CapValues;
  onChange: (next: CapValues) => void;
  emptyLabel: string;
  /** What an empty field stores: null ("no limit") or nothing ("not set"). */
  unset?: 'null' | 'omit';
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {CAP_KEYS.map((key) => (
        <label key={key} className="block text-sm">
          <span className="mb-1 block">{t(`access.caps.${key}`)}</span>
          <input
            type="number"
            min={0}
            step={key.startsWith('cost') ? 0.01 : 1000}
            className="w-full rounded border border-border bg-background px-2 py-1"
            placeholder={emptyLabel}
            value={value[key] ?? ''}
            onChange={(e) => {
              const next = { ...value };
              if (e.target.value === '') {
                if (unset === 'omit') delete next[key];
                else next[key] = null;
              } else next[key] = Math.max(0, Number(e.target.value));
              onChange(next);
            }}
            data-testid={`cap-${key}`}
          />
        </label>
      ))}
    </div>
  );
}

/** "1,234 of 10,000 tokens" / "$0.12 of $5.00". */
export function formatUsage(key: CapKey, used: number, cap: number | null, noLimit: string): string {
  const fmt = (n: number) => (key.startsWith('cost') ? `$${n.toFixed(2)}` : n.toLocaleString());
  return cap === null ? `${fmt(used)} (${noLimit})` : `${fmt(used)} / ${fmt(cap)}`;
}

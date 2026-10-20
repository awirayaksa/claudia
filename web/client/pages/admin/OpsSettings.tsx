import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import type { Banner } from '@shared/admin';
import type { AppSettingsResponse, UserDefaults } from '@shared/settings';

const BANNER_TYPES: Banner['type'][] = ['info', 'success', 'warning', 'error'];

/** <input type="datetime-local"> works in local time without a zone; the server keeps ISO. */
const toLocalInput = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);

/** Admin → Settings: the notices at the top of every page. */
export function BannersEditor({ value, onChange }: { value: AppSettingsResponse['ui.banners']; onChange: (v: AppSettingsResponse['ui.banners']) => void }) {
  const { t } = useTranslation();
  const items = value.items;
  const patch = (i: number, p: Partial<Banner>) => onChange({ items: items.map((b, j) => (j === i ? { ...b, ...p } : b)) });
  return (
    <div className="space-y-3" data-testid="banners-editor">
      <p className="text-sm text-text-secondary">{t('banners.help')}</p>
      {items.map((b, i) => (
        <div key={b.id} className="rounded border border-border p-3">
          <div className="flex flex-wrap items-center gap-3">
            <select
              aria-label={t('banners.type')}
              className="rounded border border-border bg-background px-2 py-1 text-sm"
              value={b.type}
              onChange={(e) => patch(i, { type: e.target.value as Banner['type'] })}
            >
              {BANNER_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`banners.types.${type}`)}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={b.dismissible} onChange={(e) => patch(i, { dismissible: e.target.checked })} />
              {t('banners.dismissible')}
            </label>
            <Button size="sm" variant="ghost" className="ms-auto" onClick={() => onChange({ items: items.filter((_, j) => j !== i) })}>
              {t('app.delete')}
            </Button>
          </div>
          <textarea
            aria-label={t('banners.content')}
            className="mt-2 w-full rounded border border-border bg-background px-2 py-1 text-sm"
            rows={2}
            maxLength={2000}
            value={b.content}
            onChange={(e) => patch(i, { content: e.target.value })}
          />
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <label className="text-xs">
              <span className="mb-1 block text-text-secondary">{t('banners.startsAt')}</span>
              <input
                type="datetime-local"
                className="w-full rounded border border-border bg-background px-2 py-1"
                value={toLocalInput(b.startsAt)}
                onChange={(e) => patch(i, { startsAt: fromLocalInput(e.target.value) })}
              />
            </label>
            <label className="text-xs">
              <span className="mb-1 block text-text-secondary">{t('banners.endsAt')}</span>
              <input
                type="datetime-local"
                className="w-full rounded border border-border bg-background px-2 py-1"
                value={toLocalInput(b.endsAt)}
                onChange={(e) => patch(i, { endsAt: fromLocalInput(e.target.value) })}
              />
            </label>
          </div>
        </div>
      ))}
      <Button
        size="sm"
        variant="secondary"
        disabled={items.length >= 20}
        onClick={() => onChange({ items: [...items, { id: crypto.randomUUID(), type: 'info', content: '', dismissible: true, startsAt: null, endsAt: null }] })}
      >
        {t('banners.add')}
      </Button>
    </div>
  );
}

/** Admin → Settings: what users' appearance and preferences are until they change them. */
export function DefaultsEditor({ value, onChange }: { value: UserDefaults; onChange: (v: UserDefaults) => void }) {
  const { t } = useTranslation();
  const a = value.appearance;
  const p = value.preferences;
  const setA = (patch: Partial<UserDefaults['appearance']>) => onChange({ ...value, appearance: dropEmpty({ ...a, ...patch }) });
  const setP = (patch: Partial<UserDefaults['preferences']>) => onChange({ ...value, preferences: dropEmpty({ ...p, ...patch }) });
  const tri = (v: boolean | undefined) => (v === undefined ? '' : v ? 'on' : 'off');
  const fromTri = (v: string) => (v === '' ? undefined : v === 'on');

  return (
    <div className="space-y-3" data-testid="defaults-editor">
      <p className="text-sm text-text-secondary">{t('defaults.help')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block">{t('defaults.theme')}</span>
          <select
            className="w-full rounded border border-border bg-background px-2 py-1"
            value={a.theme ?? ''}
            onChange={(e) => setA({ theme: (e.target.value || undefined) as UserDefaults['appearance']['theme'] })}
          >
            <option value="">{t('defaults.unset')}</option>
            <option value="system">{t('defaults.themes.system')}</option>
            <option value="light">{t('defaults.themes.light')}</option>
            <option value="dark">{t('defaults.themes.dark')}</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block">{t('defaults.fontSize')}</span>
          <select
            className="w-full rounded border border-border bg-background px-2 py-1"
            value={a.fontSize ?? ''}
            onChange={(e) => setA({ fontSize: (e.target.value || undefined) as UserDefaults['appearance']['fontSize'] })}
          >
            <option value="">{t('defaults.unset')}</option>
            <option value="small">{t('defaults.sizes.small')}</option>
            <option value="medium">{t('defaults.sizes.medium')}</option>
            <option value="large">{t('defaults.sizes.large')}</option>
          </select>
        </label>
        {(['showReasoning', 'showStatistics', 'streamingEnabled'] as const).map((k) => (
          <label key={k} className="text-sm">
            <span className="mb-1 block">{t(`defaults.${k}`)}</span>
            <select
              className="w-full rounded border border-border bg-background px-2 py-1"
              value={tri(p[k])}
              onChange={(e) => setP({ [k]: fromTri(e.target.value) })}
            >
              <option value="">{t('defaults.unset')}</option>
              <option value="on">{t('defaults.on')}</option>
              <option value="off">{t('defaults.off')}</option>
            </select>
          </label>
        ))}
        <label className="text-sm">
          <span className="mb-1 block">{t('defaults.temperature')}</span>
          <input
            type="number"
            min={0}
            max={2}
            step={0.1}
            placeholder={t('defaults.unset')}
            className="w-full rounded border border-border bg-background px-2 py-1"
            value={p.temperature ?? ''}
            onChange={(e) => setP({ temperature: e.target.value === '' ? undefined : Math.min(2, Math.max(0, Number(e.target.value))) })}
          />
        </label>
      </div>
      <label className="block text-sm">
        <span className="mb-1 block">{t('defaults.systemPrompt')}</span>
        <textarea
          className="w-full rounded border border-border bg-background px-2 py-1"
          rows={3}
          value={p.systemPrompt ?? ''}
          onChange={(e) => setP({ systemPrompt: e.target.value || undefined })}
        />
        <span className="mt-1 block text-xs text-text-secondary">{t('defaults.systemPromptHelp')}</span>
      </label>
    </div>
  );
}

function dropEmpty<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

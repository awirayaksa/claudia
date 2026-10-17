import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import type { AppSettingsResponse } from '@shared/settings';
import { errorMessage, useAppSettingsQuery, useModelsQuery, useUpdateAppSettingMutation } from '../../api/rtk-api';

export function AdminSettingsPage() {
  const { t } = useTranslation();
  const { data } = useAppSettingsQuery();
  const { data: models } = useModelsQuery();
  const [save, saveState] = useUpdateAppSettingMutation();
  const [draft, setDraft] = useState<AppSettingsResponse | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setDraft(structuredClone(data.settings));
  }, [data]);

  if (!draft) return <p className="text-sm text-text-secondary">{t('app.loading')}</p>;
  const allModels = models?.models ?? [];
  const allowlist = draft['models.allowlist'].user;

  const set = <K extends keyof AppSettingsResponse>(key: K, value: AppSettingsResponse[K]) => {
    setSaved(false);
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  };

  const saveAll = async () => {
    for (const key of Object.keys(draft) as Array<keyof AppSettingsResponse>) {
      if (JSON.stringify(draft[key]) !== JSON.stringify(data?.settings[key])) {
        const res = await save({ key, value: draft[key] });
        if ('error' in res) return;
      }
    }
    setSaved(true);
  };

  return (
    <div className="space-y-4">
      <Card title={t('admin.signup')}>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft['auth.signup'].enabled}
            onChange={(e) => set('auth.signup', { ...draft['auth.signup'], enabled: e.target.checked })}
          />
          {t('admin.signupEnabled')}
        </label>
        <label className="mt-3 flex items-center gap-2 text-sm">
          {t('admin.defaultRole')}
          <select
            className="rounded border border-border bg-background px-2 py-1"
            value={draft['auth.signup'].defaultRole}
            onChange={(e) =>
              set('auth.signup', { ...draft['auth.signup'], defaultRole: e.target.value as 'pending' | 'user' })
            }
          >
            <option value="pending">{t('admin.roles.pending')}</option>
            <option value="user">{t('admin.roles.user')}</option>
          </select>
        </label>
      </Card>

      <Card title={t('admin.modelAccess')}>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={allowlist === null}
            onChange={(e) => set('models.allowlist', { user: e.target.checked ? null : allModels.map((m) => m.id) })}
          />
          {t('admin.allModels')}
        </label>
        {allowlist !== null && (
          <div className="mt-2 grid gap-1 sm:grid-cols-2">
            {allModels.map((m) => (
              <label key={m.id} className="flex items-center gap-2 truncate text-sm">
                <input
                  type="checkbox"
                  checked={allowlist.includes(m.id)}
                  onChange={(e) =>
                    set('models.allowlist', {
                      user: e.target.checked ? [...allowlist, m.id] : allowlist.filter((id) => id !== m.id),
                    })
                  }
                />
                <span className="truncate" title={m.id}>
                  {m.id}
                </span>
              </label>
            ))}
          </div>
        )}
        <label className="mt-4 block text-sm">
          <span className="mb-1 block font-medium">{t('admin.defaultModel')}</span>
          <ModelSelect
            value={draft['models.default'].model}
            onChange={(model) => set('models.default', { model })}
            models={allModels.map((m) => m.id)}
            emptyLabel={t('admin.firstAvailable')}
          />
        </label>
      </Card>

      <Card title={t('admin.limits')}>
        <div className="grid gap-3 sm:grid-cols-3">
          {(['completionsPerMinute', 'concurrentRuns', 'maxToolIterations'] as const).map((k) => (
            <label key={k} className="block text-sm">
              <span className="mb-1 block">{t(`admin.${k}`)}</span>
              <input
                type="number"
                min={1}
                className="w-full rounded border border-border bg-background px-2 py-1"
                value={draft.limits[k]}
                onChange={(e) => set('limits', { ...draft.limits, [k]: Math.max(1, Number(e.target.value) || 1) })}
              />
            </label>
          ))}
        </div>
      </Card>

      <Card title={t('admin.tasks')}>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.tasks.generateTitles}
            onChange={(e) => set('tasks', { ...draft.tasks, generateTitles: e.target.checked })}
          />
          {t('admin.generateTitles')}
        </label>
        <label className="mt-3 block text-sm">
          <span className="mb-1 block">{t('admin.titleModel')}</span>
          <ModelSelect
            value={draft.tasks.titleModel}
            onChange={(titleModel) => set('tasks', { ...draft.tasks, titleModel })}
            models={allModels.map((m) => m.id)}
            emptyLabel={t('admin.sameAsChat')}
          />
        </label>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={() => void saveAll()} disabled={saveState.isLoading}>
          {t('app.save')}
        </Button>
        {saved && <span className="text-sm text-success">{t('app.saved')}</span>}
        {saveState.error && <span className="text-sm text-error">{errorMessage(saveState.error)}</span>}
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="mb-3 font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function ModelSelect({
  value,
  onChange,
  models,
  emptyLabel,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  models: string[];
  emptyLabel: string;
}) {
  return (
    <select
      className="w-full rounded border border-border bg-background px-2 py-1"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">{emptyLabel}</option>
      {models.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}

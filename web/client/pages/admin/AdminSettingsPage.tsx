import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import type { AppSettingsResponse } from '@shared/settings';
import { errorMessage, useAppSettingsQuery, useModelsQuery, useUpdateAppSettingMutation } from '../../api/rtk-api';
import { CapsFields, PermissionChecks } from '../../components/AccessFields';
import { BannersEditor, DefaultsEditor } from './OpsSettings';

/** The built-in tool servers (each user gets their own, confined to their workspace). */
const BUILTIN_IDS = ['builtin-filesystem-001', 'builtin-msoffice-001', 'builtin-diagram-001', 'builtin-fetch-001'] as const;

export function AdminSettingsPage() {
  const { t } = useTranslation();
  const { data } = useAppSettingsQuery();
  const { data: models } = useModelsQuery();
  const [save, saveState] = useUpdateAppSettingMutation();
  const [draft, setDraft] = useState<AppSettingsResponse | null>(null);
  const [saved, setSaved] = useState(false);
  const [allowlistText, setAllowlistText] = useState('');

  useEffect(() => {
    if (data) {
      setDraft(structuredClone(data.settings));
      setAllowlistText(data.settings['net.allowlist'].hosts.join('\n'));
    }
  }, [data]);

  if (!draft) return <p className="text-sm text-text-secondary">{t('app.loading')}</p>;
  // Allowlists and defaults are about connection models, not custom ones
  const allModels = (models?.models ?? []).filter((m) => !m.custom && !m.own);
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
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.tasks.generateFollowUps}
            onChange={(e) => set('tasks', { ...draft.tasks, generateFollowUps: e.target.checked })}
          />
          {t('admin.generateFollowUps')}
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

      <Card title={t('admin.builtinTools')}>
        <p className="mb-2 text-sm text-text-secondary">{t('admin.builtinToolsHelp')}</p>
        <div className="grid gap-1 sm:grid-cols-2">
          {BUILTIN_IDS.map((id) => (
            <label key={id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft['mcp.builtins'].enabled.includes(id)}
                onChange={(e) =>
                  set('mcp.builtins', {
                    enabled: e.target.checked
                      ? [...draft['mcp.builtins'].enabled, id]
                      : draft['mcp.builtins'].enabled.filter((x) => x !== id),
                  })
                }
              />
              {t(`admin.builtins.${id}`)}
            </label>
          ))}
        </div>
      </Card>

      <Card title={t('admin.network')}>
        <label className="block text-sm">
          <span className="mb-1 block">{t('admin.netAllowlist')}</span>
          <textarea
            className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs"
            rows={4}
            placeholder={'wiki.internal.example.com\n*.corp.example.com\n10.20.0.0/16'}
            value={allowlistText}
            onChange={(e) => {
              setAllowlistText(e.target.value);
              set('net.allowlist', {
                hosts: e.target.value
                  .split('\n')
                  .map((s) => s.trim())
                  .filter(Boolean),
              });
            }}
          />
          <span className="mt-1 block text-xs text-text-secondary">{t('admin.netAllowlistHelp')}</span>
        </label>
      </Card>

      <Card title={t('access.defaultPermissions')}>
        <p className="mb-3 text-sm text-text-secondary">{t('access.defaultPermissionsHelp')}</p>
        <PermissionChecks
          value={draft['permissions.default']}
          onChange={(p) => set('permissions.default', { ...draft['permissions.default'], ...p })}
        />
      </Card>

      <Card title={t('access.defaultCaps')}>
        <p className="mb-3 text-sm text-text-secondary">{t('access.defaultCapsHelp')}</p>
        <CapsFields
          value={draft['caps.default']}
          onChange={(c) => set('caps.default', { ...draft['caps.default'], ...c })}
          emptyLabel={t('access.noLimit')}
        />
      </Card>

      <Card title={t('banners.title')}>
        <BannersEditor value={draft['ui.banners']} onChange={(v) => set('ui.banners', v)} />
      </Card>

      <Card title={t('defaults.title')}>
        <DefaultsEditor value={draft['users.defaults']} onChange={(v) => set('users.defaults', v)} />
      </Card>

      <Card title={t('audit.title')}>
        <label className="block text-sm">
          <span className="mb-1 block">{t('audit.retentionDays')}</span>
          <input
            type="number"
            min={1}
            max={3650}
            className="w-40 rounded border border-border bg-background px-2 py-1"
            value={draft.audit.retentionDays}
            onChange={(e) => set('audit', { retentionDays: Math.min(3650, Math.max(1, Number(e.target.value) || 1)) })}
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

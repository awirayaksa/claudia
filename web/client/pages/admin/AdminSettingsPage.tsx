import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import type { AppSettingsResponse } from '@shared/settings';
import {
  errorMessage,
  useAppSettingsQuery,
  useCodeStatusQuery,
  useModelsQuery,
  useTestCodeSandboxMutation,
  useUpdateAppSettingMutation,
} from '../../api/rtk-api';
import { CapsFields, PermissionChecks } from '../../components/AccessFields';
import { BannersEditor, DefaultsEditor } from './OpsSettings';

/** The built-in tool servers (each user gets their own, confined to their workspace). */
const BUILTIN_IDS = [
  'builtin-filesystem-001',
  'builtin-msoffice-001',
  'builtin-spreadsheet-001',
  'builtin-presentation-001',
  'builtin-pdf-001',
  'builtin-diagram-001',
  'builtin-fetch-001',
] as const;

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

      <Card title={t('admin.compaction')}>
        <p className="mb-2 text-sm text-text-secondary">{t('admin.compactionHelp')}</p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.compaction.enabled}
            onChange={(e) => set('compaction', { ...draft.compaction, enabled: e.target.checked })}
          />
          {t('admin.compactionEnabled')}
        </label>
        {draft.compaction.enabled && (
          <>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="mb-1 block">{t('admin.compactionThreshold')}</span>
                <input
                  type="number"
                  min={30}
                  max={95}
                  className="w-full rounded border border-border bg-background px-2 py-1"
                  value={Math.round(draft.compaction.threshold * 100)}
                  onChange={(e) =>
                    set('compaction', { ...draft.compaction, threshold: Math.min(95, Math.max(30, Number(e.target.value) || 80)) / 100 })
                  }
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block">{t('admin.compactionKeep')}</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  className="w-full rounded border border-border bg-background px-2 py-1"
                  value={draft.compaction.keepRecentTurns}
                  onChange={(e) =>
                    set('compaction', { ...draft.compaction, keepRecentTurns: Math.min(20, Math.max(1, Number(e.target.value) || 1)) })
                  }
                />
              </label>
            </div>
            <label className="mt-3 block text-sm">
              <span className="mb-1 block">{t('admin.compactionModel')}</span>
              <ModelSelect
                value={draft.compaction.model}
                onChange={(model) => set('compaction', { ...draft.compaction, model })}
                models={allModels.map((m) => m.id)}
                emptyLabel={t('admin.sameAsChat')}
              />
            </label>
          </>
        )}
      </Card>

      <Card title={t('admin.memory')}>
        <p className="mb-2 text-sm text-text-secondary">{t('admin.memoryHelp')}</p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.memory.extraction}
            onChange={(e) => set('memory', { ...draft.memory, extraction: e.target.checked })}
          />
          {t('admin.memoryExtraction')}
        </label>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={draft.memory.tools} onChange={(e) => set('memory', { ...draft.memory, tools: e.target.checked })} />
          {t('admin.memoryTools')}
        </label>
        <label className="mt-3 block text-sm">
          <span className="mb-1 block">{t('admin.memoryModel')}</span>
          <ModelSelect
            value={draft.memory.model}
            onChange={(model) => set('memory', { ...draft.memory, model })}
            models={allModels.map((m) => m.id)}
            emptyLabel={t('admin.sameAsChat')}
          />
        </label>
      </Card>

      <Card title={t('admin.code')}>
        <CodeSettings value={draft.code} onChange={(code) => set('code', code)} />
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

/** Where the code interpreter runs, and the server sandbox's limits. */
function CodeSettings({ value, onChange }: { value: AppSettingsResponse['code']; onChange: (v: AppSettingsResponse['code']) => void }) {
  const { t } = useTranslation();
  const { data: status } = useCodeStatusQuery();
  const [test, testState] = useTestCodeSandboxMutation();
  const field = 'w-full rounded border border-border bg-background px-2 py-1';
  const num = (key: 'memoryMb' | 'cpus' | 'timeoutSeconds', min: number, max: number, step = 1) => (
    <label className="block text-sm">
      <span className="mb-1 block">{t(`admin.code_${key}`)}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        className={field}
        value={value[key]}
        onChange={(e) => onChange({ ...value, [key]: Math.min(max, Math.max(min, Number(e.target.value) || min)) })}
      />
    </label>
  );
  return (
    <div className="space-y-3">
      <label className="block text-sm">
        <span className="mb-1 block">{t('admin.codeEngine')}</span>
        <select className={field} value={value.engine} onChange={(e) => onChange({ ...value, engine: e.target.value as typeof value.engine })} data-testid="code-engine">
          <option value="browser">{t('admin.codeEngines.browser')}</option>
          <option value="server">{t('admin.codeEngines.server')}</option>
          <option value="off">{t('admin.codeEngines.off')}</option>
        </select>
      </label>
      {value.engine === 'server' && (
        <>
          {status && !status.dockerConfigured && <p className="rounded border border-warning/40 px-3 py-2 text-xs text-text-secondary">{t('admin.codeNoDocker')}</p>}
          <p className="text-xs text-text-secondary">{t('admin.codeServerHelp')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block">{t('admin.codePythonImage')}</span>
              <input className={field} value={value.pythonImage} onChange={(e) => onChange({ ...value, pythonImage: e.target.value })} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block">{t('admin.codeNodeImage')}</span>
              <input className={field} value={value.nodeImage} onChange={(e) => onChange({ ...value, nodeImage: e.target.value })} />
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {num('memoryMb', 64, 16_384)}
            {num('cpus', 0.1, 16, 0.1)}
            {num('timeoutSeconds', 5, 3600)}
          </div>
          <label className="block text-sm">
            <span className="mb-1 block">{t('admin.codeRuntime')}</span>
            <input className={field} placeholder="runsc" value={value.runtime ?? ''} onChange={(e) => onChange({ ...value, runtime: e.target.value.trim() || null })} />
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={value.network} onChange={(e) => onChange({ ...value, network: e.target.checked })} />
            <span>
              {t('admin.codeNetwork')}
              <span className="block text-xs text-text-secondary">{t('admin.codeNetworkHelp')}</span>
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="secondary" disabled={!status?.dockerConfigured || testState.isLoading} onClick={() => void test()}>
              {testState.isLoading ? t('admin.codeTesting') : t('admin.codeTest')}
            </Button>
            {testState.data?.ok && <span className="text-sm text-success">{t('admin.codeTestOk', { version: testState.data.version ?? '?' })}</span>}
            {testState.data && !testState.data.ok && <span className="text-sm text-error">{testState.data.error}</span>}
          </div>
        </>
      )}
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

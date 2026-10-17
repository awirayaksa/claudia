import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ThemeSettings } from '@/components/settings/ThemeSettings';
import { PreferencesSettings } from '@/components/settings/PreferencesSettings';
import { SkillSettings } from '@/components/settings/SkillSettings';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import {
  errorMessage,
  useChangePasswordMutation,
  useMySessionsQuery,
  useMyUsageQuery,
  usePermissions,
  useRevokeSessionMutation,
  useSessionQuery,
  useUpdateMeMutation,
} from '../api/rtk-api';
import { PageFrame, Tabs } from '../components/PageFrame';
import { ToolsSettings } from './settings/ToolsSettings';
import { FilesSettings } from './settings/FilesSettings';
import { DataSettings } from './settings/DataSettings';
import { ConnectionsManager } from './admin/ConnectionsPage';
import { MemorySettings } from './settings/MemorySettings';
import { ApiKeysSettings } from './settings/ApiKeysSettings';
import { CAP_KEYS } from '@shared/access';
import { formatUsage } from '../components/AccessFields';

type Tab =
  | 'appearance'
  | 'preferences'
  | 'memory'
  | 'tools'
  | 'skills'
  | 'files'
  | 'data'
  | 'connections'
  | 'api'
  | 'account';

export function SettingsPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('appearance');
  const permissions = usePermissions();
  return (
    <PageFrame title={t('settings.title')}>
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'appearance', label: t('settings.appearance') },
          { id: 'preferences', label: t('settings.preferences') },
          { id: 'memory', label: t('settings.memory') },
          { id: 'tools', label: t('settings.tools') },
          { id: 'skills', label: t('settings.skills') },
          { id: 'files', label: t('settings.files') },
          { id: 'data', label: t('settings.data') },
          { id: 'connections', label: t('settings.connections') },
          ...(permissions?.['api.keys'] ? [{ id: 'api' as const, label: t('settings.apiKeys') }] : []),
          { id: 'account', label: t('settings.account') },
        ]}
      />
      <div className="mt-4 rounded-lg border border-border bg-surface">
        {tab === 'appearance' && <ThemeSettings />}
        {tab === 'preferences' && <PreferencesSettings />}
        {tab === 'memory' && <MemorySettings />}
        {tab === 'tools' && <ToolsSettings />}
        {tab === 'skills' && <SkillSettings />}
        {tab === 'files' && <FilesSettings />}
        {tab === 'data' && <DataSettings />}
        {tab === 'connections' && (
          <div className="p-5">
            <ConnectionsManager scope="own" />
          </div>
        )}
        {tab === 'api' && <ApiKeysSettings />}
        {tab === 'account' && <AccountSettings />}
      </div>
    </PageFrame>
  );
}

function AccountSettings() {
  const { t } = useTranslation();
  const { data: session } = useSessionQuery();
  const user = session?.user;
  const [name, setName] = useState(user?.name ?? '');
  const [updateMe, updateState] = useUpdateMeMutation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [changePassword, pwState] = useChangePasswordMutation();
  const { data: sessions } = useMySessionsQuery();
  const [revoke] = useRevokeSessionMutation();

  const savePassword = async (e: FormEvent) => {
    e.preventDefault();
    const res = await changePassword({ currentPassword: current, newPassword: next });
    if (!('error' in res)) {
      setCurrent('');
      setNext('');
    }
  };

  return (
    <div className="space-y-8 p-5">
      <form
        className="max-w-md space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void updateMe({ name: name.trim() });
        }}
      >
        <Input label={t('auth.email')} value={user?.email ?? ''} disabled />
        <Input label={t('settings.displayName')} value={name} onChange={(e) => setName(e.target.value)} />
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={updateState.isLoading}>
            {t('app.save')}
          </Button>
          {updateState.isSuccess && <span className="text-sm text-success">{t('app.saved')}</span>}
        </div>
      </form>

      <section className="max-w-md">
        <h3 className="mb-3 font-semibold">{t('settings.changePassword')}</h3>
        {user?.hasPassword ? (
          <form className="space-y-3" onSubmit={savePassword}>
            <Input
              label={t('settings.currentPassword')}
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
            />
            <Input
              label={t('settings.newPassword')}
              type="password"
              showPasswordToggle
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
            />
            {pwState.error && <p className="text-sm text-error">{errorMessage(pwState.error)}</p>}
            {pwState.isSuccess && <p className="text-sm text-success">{t('settings.passwordChanged')}</p>}
            <Button type="submit" size="sm" disabled={pwState.isLoading || !current || !next}>
              {t('settings.changePassword')}
            </Button>
          </form>
        ) : (
          <p className="text-sm text-text-secondary">{t('settings.directoryAccount')}</p>
        )}
      </section>

      <UsageSection />

      <section>
        <h3 className="mb-3 font-semibold">{t('settings.sessions')}</h3>
        <ul className="divide-y divide-border rounded border border-border">
          {sessions?.sessions.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate">{s.userAgent ?? '—'}</div>
                <div className="text-xs text-text-secondary">
                  {s.ip} · {new Date(s.createdAt).toLocaleString()}
                </div>
              </div>
              {s.current ? (
                <span className="text-xs text-text-secondary">{t('settings.thisDevice')}</span>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => void revoke(s.id)}>
                  {t('settings.signOutDevice')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** Tokens and cost so far, against the caps (if any). */
function UsageSection() {
  const { t } = useTranslation();
  const { data } = useMyUsageQuery(undefined, { refetchOnMountOrArgChange: true });
  if (!data) return null;
  const { usage } = data;
  return (
    <section className="max-w-md">
      <h3 className="mb-3 font-semibold">{t('access.usage')}</h3>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm" data-testid="my-usage">
        {CAP_KEYS.map((k) => (
          <div key={k} className="contents">
            <dt className="text-text-secondary">{t(`access.caps.${k}`)}</dt>
            <dd>
              {formatUsage(
                k,
                usage[k.endsWith('Day') ? 'day' : 'month'][k.startsWith('cost') ? 'cost' : 'tokens'],
                usage.caps[k],
                t('access.noLimit')
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-xs text-text-secondary">{t('access.usageHelp')}</p>
    </section>
  );
}

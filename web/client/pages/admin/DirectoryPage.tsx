import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import type { LdapLookupResult, LdapSettings } from '@shared/ldap';
import {
  errorMessage,
  useLdapSettingsQuery,
  useLookupLdapUserMutation,
  useTestLdapMutation,
  useUpdateLdapSettingsMutation,
} from '../../api/rtk-api';

/** LDAP / Active Directory sign-in settings. */
export function DirectoryPage() {
  const { t } = useTranslation();
  const { data } = useLdapSettingsQuery();
  const [save, saveState] = useUpdateLdapSettingsMutation();
  const [test, testState] = useTestLdapMutation();
  const [lookup, lookupState] = useLookupLdapUserMutation();
  const [draft, setDraft] = useState<LdapSettings | null>(null);
  const [bindPassword, setBindPassword] = useState('');
  const [lookupName, setLookupName] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setDraft(structuredClone(data.settings));
  }, [data]);

  if (!draft || !data) return <p className="text-sm text-text-secondary">{t('app.loading')}</p>;
  const locked = new Set<string>(data.locked);
  const set = <K extends keyof LdapSettings>(key: K, value: LdapSettings[K]) => {
    setSaved(false);
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  };

  const submit = async () => {
    // Fields set by environment variables aren't sent (the server refuses them)
    const patch = Object.fromEntries(
      Object.entries(draft).filter(([k, v]) => !locked.has(k) && JSON.stringify(v) !== JSON.stringify(data.settings[k as keyof LdapSettings]))
    );
    const res = await save({ ...patch, ...(bindPassword && !locked.has('bindPassword') ? { bindPassword } : {}) });
    if (!('error' in res)) {
      setBindPassword('');
      setSaved(true);
    }
  };

  const text = (key: keyof LdapSettings, label: string, help?: string, placeholder?: string) => (
    <Input
      label={label}
      helperText={locked.has(key) ? t('admin.lockedByEnv') : help}
      placeholder={placeholder}
      value={(draft[key] as string | null) ?? ''}
      disabled={locked.has(key)}
      onChange={(e) => set(key, (e.target.value || (key === 'allowedGroupDn' || key === 'caCert' ? null : '')) as never)}
    />
  );
  const check = (key: 'enabled' | 'startTls' | 'tlsVerify' | 'stripDomain', label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={draft[key]} disabled={locked.has(key)} onChange={(e) => set(key, e.target.checked)} />
      {label}
      {locked.has(key) && <span className="text-xs text-text-secondary">({t('admin.lockedByEnv')})</span>}
    </label>
  );

  return (
    <div className="space-y-4">
      <Card title={t('admin.ldapServer')}>
        <div className="space-y-3">
          {check('enabled', t('admin.ldapEnabled'))}
          {text('url', t('admin.ldapUrl'), undefined, 'ldaps://dc.example.com:636')}
          {check('startTls', t('admin.ldapStartTls'))}
          {check('tlsVerify', t('admin.ldapTlsVerify'))}
          <label className="block text-sm">
            <span className="mb-1 block font-medium">{t('admin.ldapCaCert')}</span>
            <textarea
              className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs"
              rows={3}
              placeholder="-----BEGIN CERTIFICATE-----"
              value={draft.caCert ?? ''}
              disabled={locked.has('caCert')}
              onChange={(e) => set('caCert', e.target.value.trim() ? e.target.value : null)}
            />
          </label>
          {text('bindDn', t('admin.ldapBindDn'), t('admin.ldapBindDnHelp'), 'cn=claudia,ou=service,dc=example,dc=com')}
          <Input
            label={t('admin.ldapBindPassword')}
            type="password"
            autoComplete="off"
            value={bindPassword}
            disabled={locked.has('bindPassword')}
            onChange={(e) => setBindPassword(e.target.value)}
            helperText={
              locked.has('bindPassword')
                ? t('admin.lockedByEnv')
                : data.hasBindPassword
                  ? t('admin.apiKeySet')
                  : undefined
            }
          />
        </div>
      </Card>

      <Card title={t('admin.ldapUsers')}>
        <div className="space-y-3">
          {text('userSearchBase', t('admin.ldapSearchBase'), undefined, 'ou=people,dc=example,dc=com')}
          {text('userFilter', t('admin.ldapUserFilter'), t('admin.ldapUserFilterHelp', { placeholder: '{{username}}' }))}
          <div className="grid gap-3 sm:grid-cols-2">
            {text('emailAttribute', t('admin.ldapEmailAttribute'))}
            {text('nameAttribute', t('admin.ldapNameAttribute'))}
          </div>
          {text('allowedGroupDn', t('admin.ldapAllowedGroup'), t('admin.ldapAllowedGroupHelp'))}
          {check('stripDomain', t('admin.ldapStripDomain'))}
          <label className="flex items-center gap-2 text-sm">
            {t('admin.defaultRole')}
            <select
              className="rounded border border-border bg-background px-2 py-1"
              value={draft.defaultRole}
              onChange={(e) => set('defaultRole', e.target.value as LdapSettings['defaultRole'])}
            >
              <option value="user">{t('admin.roles.user')}</option>
              <option value="pending">{t('admin.roles.pending')}</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block">{t('admin.ldapVerifyInterval')}</span>
            <input
              type="number"
              min={1}
              max={1440}
              className="w-32 rounded border border-border bg-background px-2 py-1"
              value={draft.verifyIntervalMinutes}
              onChange={(e) => set('verifyIntervalMinutes', Math.min(1440, Math.max(1, Number(e.target.value) || 1)))}
            />
          </label>
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void submit()} disabled={saveState.isLoading}>
          {t('app.save')}
        </Button>
        <Button variant="secondary" onClick={() => void test()} disabled={testState.isLoading}>
          {t('admin.ldapTest')}
        </Button>
        {saved && <span className="text-sm text-success">{t('app.saved')}</span>}
        {saveState.error && <span className="text-sm text-error">{errorMessage(saveState.error)}</span>}
        {testState.data && (
          <span className={`text-sm ${testState.data.ok ? 'text-success' : 'text-error'}`}>
            {testState.data.ok ? t('admin.ldapTestOk') : testState.data.error}
          </span>
        )}
      </div>

      <Card title={t('admin.ldapLookup')}>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (lookupName.trim()) void lookup(lookupName.trim());
          }}
        >
          <div className="min-w-48 flex-1">
            <Input label={t('auth.username')} value={lookupName} onChange={(e) => setLookupName(e.target.value)} />
          </div>
          <Button type="submit" variant="secondary" disabled={lookupState.isLoading}>
            {t('admin.ldapLookupButton')}
          </Button>
        </form>
        <LookupResult result={lookupState.data} />
      </Card>
    </div>
  );
}

function LookupResult({ result }: { result?: LdapLookupResult }) {
  const { t } = useTranslation();
  if (!result) return null;
  if (result.error) return <p className="mt-3 text-sm text-error">{result.error}</p>;
  if (!result.entry) {
    return <p className="mt-3 text-sm text-text-secondary">{t('admin.ldapLookupMatches', { count: result.matches })}</p>;
  }
  return (
    <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt className="text-text-secondary">DN</dt>
      <dd className="break-all">{result.entry.dn}</dd>
      <dt className="text-text-secondary">{t('auth.email')}</dt>
      <dd>{result.entry.email ?? '—'}</dd>
      <dt className="text-text-secondary">{t('auth.name')}</dt>
      <dd>{result.entry.name ?? '—'}</dd>
      <dt className="text-text-secondary">{t('admin.ldapSubject')}</dt>
      <dd className="break-all font-mono text-xs">{result.entry.subject}</dd>
    </dl>
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

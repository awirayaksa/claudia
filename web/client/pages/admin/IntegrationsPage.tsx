import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import type { CloudSettings } from '@shared/cloud';
import { errorMessage, useCloudSettingsQuery, useUpdateCloudSettingsMutation } from '../../api/rtk-api';

/** Admin → Integrations: the OAuth clients users connect Google Drive and OneDrive with. */
export function IntegrationsPage() {
  const { t } = useTranslation();
  const { data } = useCloudSettingsQuery();
  const [save, state] = useUpdateCloudSettingsMutation();
  const [draft, setDraft] = useState<CloudSettings | null>(null);
  const [secrets, setSecrets] = useState({ google: '', microsoft: '' });
  useEffect(() => {
    if (data) setDraft(structuredClone(data.settings));
  }, [data]);
  if (!draft || !data) return <p className="text-sm text-text-secondary">{t('app.loading')}</p>;

  const input = (value: string, onChange: (v: string) => void, label: string, props: Record<string, unknown> = {}) => (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      <input className="w-full rounded border border-border bg-background px-2 py-1" value={value} onChange={(e) => onChange(e.target.value)} {...props} />
    </label>
  );

  return (
    <div className="space-y-4" data-testid="integrations">
      <p className="text-sm text-text-secondary">{t('cloud.adminHelp')}</p>
      {(['google', 'microsoft'] as const).map((p) => (
        <section key={p} className="space-y-3 rounded-lg border border-border bg-surface p-4">
          <label className="flex items-center gap-2 font-semibold">
            <input
              type="checkbox"
              checked={draft[p].enabled}
              onChange={(e) => setDraft({ ...draft, [p]: { ...draft[p], enabled: e.target.checked } })}
            />
            {t(`cloud.${p}`)}
          </label>
          <p className="text-xs text-text-secondary">
            {t('cloud.redirectUri')} <code className="break-all">{data.redirectUris[p]}</code>
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {input(draft[p].clientId, (v) => setDraft({ ...draft, [p]: { ...draft[p], clientId: v } }), t('signin.clientId'))}
            {input(secrets[p], (v) => setSecrets({ ...secrets, [p]: v }), data.hasSecret[p] ? t('signin.clientSecretKeep') : t('signin.clientSecret'), {
              type: 'password',
              autoComplete: 'off',
            })}
          </div>
          {p === 'microsoft' &&
            input(draft.microsoft.tenant, (v) => setDraft({ ...draft, microsoft: { ...draft.microsoft, tenant: v } }), t('cloud.tenant'), {
              placeholder: 'common',
            })}
          <p className="text-xs text-text-secondary">{t(`cloud.${p}Help`)}</p>
        </section>
      ))}
      <div className="flex items-center gap-3">
        <Button
          onClick={async () => {
            const res = await save({
              google: draft.google,
              microsoft: draft.microsoft,
              ...(secrets.google ? { googleSecret: secrets.google } : {}),
              ...(secrets.microsoft ? { microsoftSecret: secrets.microsoft } : {}),
            });
            if ('data' in res) setSecrets({ google: '', microsoft: '' });
          }}
          disabled={state.isLoading}
        >
          {t('app.save')}
        </Button>
        {state.isSuccess && <span className="text-sm text-success">{t('app.saved')}</span>}
        {state.error && <span className="text-sm text-error">{errorMessage(state.error)}</span>}
      </div>
    </div>
  );
}

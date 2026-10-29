import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { AZDO_API_VERSIONS, type AzdoServer } from '@shared/azdo';
import { errorMessage, useAppSettingsQuery, useUpdateAppSettingMutation } from '../../api/rtk-api';

const field = 'w-full rounded border border-border bg-background px-2 py-1 text-sm';
const RELEASES: Record<(typeof AZDO_API_VERSIONS)[number], string> = {
  '4.1': 'TFS 2018',
  '5.0': 'Azure DevOps Server 2019',
  '6.0': 'Azure DevOps Server 2020',
  '7.0': 'Azure DevOps Server 2022',
  '7.1': 'Azure DevOps Server 2022.1+',
};

/** Admin → Integrations: the Azure DevOps Server / TFS collections people can connect to. */
export function AzureDevOpsServers() {
  const { t } = useTranslation();
  const { data } = useAppSettingsQuery();
  const [save, state] = useUpdateAppSettingMutation();
  const [draft, setDraft] = useState<AzdoServer[] | null>(null);
  const stored = data?.settings['azdo.servers'].servers;
  useEffect(() => {
    if (stored) setDraft(structuredClone(stored));
  }, [stored]);
  if (!draft) return null;

  const change = (i: number, patch: Partial<AzdoServer>) => setDraft(draft.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  return (
    <section className="space-y-3 rounded-lg border border-border bg-surface p-4" data-testid="azdo-servers">
      <h3 className="font-semibold">{t('azdo.adminTitle')}</h3>
      <p className="text-xs text-text-secondary">{t('azdo.adminHelp')}</p>
      {draft.map((s, i) => (
        <div key={s.id} className="grid gap-2 rounded border border-border p-3 sm:grid-cols-[1fr_2fr_auto_auto]">
          <input className={field} aria-label={t('azdo.serverName')} placeholder={t('azdo.serverName')} value={s.name} onChange={(e) => change(i, { name: e.target.value })} />
          <input
            className={field}
            aria-label={t('azdo.collectionUrl')}
            placeholder="https://tfs.example.com/tfs/DefaultCollection"
            type="url"
            value={s.url}
            onChange={(e) => change(i, { url: e.target.value })}
          />
          <select
            className={field}
            aria-label={t('azdo.version')}
            value={s.apiVersion}
            onChange={(e) => change(i, { apiVersion: e.target.value as AzdoServer['apiVersion'] })}
          >
            {AZDO_API_VERSIONS.map((v) => (
              <option key={v} value={v}>
                {RELEASES[v]} ({v})
              </option>
            ))}
          </select>
          <Button size="sm" variant="ghost" className="text-error" onClick={() => setDraft(draft.filter((_, j) => j !== i))}>
            {t('app.delete')}
          </Button>
          {/^http:/i.test(s.url) && <p className="text-xs text-error sm:col-span-4">{t('azdo.httpWarning')}</p>}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setDraft([...draft, { id: crypto.randomUUID(), name: '', url: '', apiVersion: '7.0' }])}
        >
          {t('azdo.addServer')}
        </Button>
        <Button size="sm" onClick={() => void save({ key: 'azdo.servers', value: { servers: draft } })} disabled={state.isLoading}>
          {t('app.save')}
        </Button>
        {state.isSuccess && <span className="text-sm text-success">{t('app.saved')}</span>}
        {state.error && <span className="text-sm text-error">{errorMessage(state.error)}</span>}
      </div>
    </section>
  );
}

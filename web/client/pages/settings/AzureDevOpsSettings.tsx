import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import type { AzdoConnectionView } from '@shared/azdo';
import { errorMessage, useAzdoConnectionsQuery, useConnectAzdoMutation, useDisconnectAzdoMutation } from '../../api/rtk-api';

const field = 'rounded border border-border bg-background px-2 py-1.5 text-sm';

/** Your personal access token for each of the administrator's Azure DevOps Server collections. */
export function AzureDevOpsSettings() {
  const { t } = useTranslation();
  const { data } = useAzdoConnectionsQuery();
  if (!data) return null;
  return (
    <div className="mt-3 space-y-3" data-testid="azdo-settings">
      {data.connections.length === 0 && <p className="text-xs text-text-secondary">{t('azdo.noServers')}</p>}
      {data.connections.map((c) => (
        <Connection key={c.serverId} connection={c} />
      ))}
    </div>
  );
}

function Connection({ connection: c }: { connection: AzdoConnectionView }) {
  const { t } = useTranslation();
  const [connect, state] = useConnectAzdoMutation();
  const [disconnect] = useDisconnectAzdoMutation();
  const [pat, setPat] = useState('');
  const [project, setProject] = useState(c.defaultProject ?? '');
  const [replacing, setReplacing] = useState(false);
  const askToken = !c.connected || replacing;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const res = await connect({ serverId: c.serverId, ...(pat.trim() ? { pat: pat.trim() } : {}), defaultProject: project.trim() || null });
    if ('data' in res) {
      setPat('');
      setReplacing(false);
    }
  };

  return (
    <form className="space-y-2 rounded border border-border p-3" onSubmit={submit} data-testid={`azdo-${c.serverId}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{c.serverName}</div>
          <div className="truncate text-xs text-text-secondary">{c.url}</div>
        </div>
        {c.connected && (
          <span className="text-xs text-success" data-testid="azdo-connected">
            {t('azdo.connectedAs', { name: c.displayName ?? '' })}
          </span>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {askToken && (
          <input
            className={field}
            type="password"
            autoComplete="off"
            placeholder={t('azdo.token')}
            aria-label={t('azdo.token')}
            value={pat}
            onChange={(e) => setPat(e.target.value)}
            required
          />
        )}
        <input
          className={field}
          placeholder={t('azdo.defaultProject')}
          aria-label={t('azdo.defaultProject')}
          value={project}
          onChange={(e) => setProject(e.target.value)}
        />
      </div>
      {askToken && <p className="text-xs text-text-secondary">{t('azdo.tokenHelp')}</p>}
      {state.error && <p className="text-sm text-error">{errorMessage(state.error)}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {c.connected && !replacing && (
          <Button type="button" size="sm" variant="secondary" onClick={() => setReplacing(true)}>
            {t('azdo.replaceToken')}
          </Button>
        )}
        {c.connected && (
          <Button type="button" size="sm" variant="ghost" className="text-error" onClick={() => void disconnect(c.serverId)}>
            {t('azdo.disconnect')}
          </Button>
        )}
        <Button type="submit" size="sm" disabled={state.isLoading}>
          {askToken ? t('azdo.connect') : t('app.save')}
        </Button>
      </div>
    </form>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsSection } from '@/components/settings/SettingsDraft';
import { errorMessage, useMcpServersQuery, useSetMcpServerEnabledMutation } from '../../api/rtk-api';
import { OwnToolServers } from './OwnToolServers';
import { AzureDevOpsSettings } from './AzureDevOpsSettings';

/** Switch tool servers on or off for yourself. The model can use those that are on. */
export function ToolsSettings() {
  const { t } = useTranslation();
  const { data, isLoading } = useMcpServersQuery();
  const [setEnabled, state] = useSetMcpServerEnabledMutation();
  // Switched on or off but not saved yet, by server
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const changed = (data?.servers ?? []).filter((s) => s.id in draft && draft[s.id] !== s.enabled);
  useSettingsSection('tools', {
    dirty: changed.length > 0,
    save: async () => {
      for (const s of changed) await setEnabled({ id: s.id, enabled: draft[s.id] }).unwrap();
      setDraft({});
    },
    discard: () => setDraft({}),
  });

  return (
    <div className="space-y-4 p-5">
      <p className="text-sm text-text-secondary">{t('settings.toolsHelp')}</p>
      {isLoading && <p className="text-sm text-text-secondary">{t('app.loading')}</p>}
      {data?.servers.length === 0 && <p className="text-sm text-text-secondary">{t('settings.noTools')}</p>}
      <ul className="divide-y divide-border rounded border border-border">
        {data?.servers.map((s) => (
          <li key={s.id} className="flex items-start gap-3 px-3 py-3">
            <input
              type="checkbox"
              className="mt-1"
              aria-label={s.name}
              checked={draft[s.id] ?? s.enabled}
              disabled={state.isLoading}
              onChange={(e) => setDraft((d) => ({ ...d, [s.id]: e.target.checked }))}
              data-testid={`tool-toggle-${s.id}`}
            />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                {s.name}{' '}
                <span className="text-xs font-normal text-text-secondary">
                  {s.scope === 'builtin' ? t('settings.builtinTool') : s.scope === 'user' ? t('ownTools.yours') : t('settings.sharedTool')}
                  {s.enabled && ` · ${t(`mcp.status.${s.status}`, { defaultValue: s.status })}`}
                  {s.enabled && s.tools.length > 0 && ` · ${t('admin.toolCount', { count: s.tools.length })}`}
                </span>
              </div>
              {s.description && <p className="text-xs text-text-secondary">{s.description}</p>}
              {s.enabled && s.error && <p className="text-xs text-error">{s.error}</p>}
              {s.id === 'builtin-azdo-001' && <AzureDevOpsSettings />}
            </div>
          </li>
        ))}
      </ul>
      {state.error && <p className="text-sm text-error">{errorMessage(state.error)}</p>}
      <OwnToolServers />
    </div>
  );
}

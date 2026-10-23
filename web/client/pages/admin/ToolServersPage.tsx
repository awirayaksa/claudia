import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Modal } from '@/components/common/Modal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import type { AdminMcpServerView, McpServerInput } from '@shared/mcp';
import {
  errorMessage,
  useAdminMcpServersQuery,
  useCreateMcpServerMutation,
  useDeleteMcpServerMutation,
  useDisconnectMcpOAuthMutation,
  useRestartMcpServerMutation,
  useUpdateMcpServerMutation,
} from '../../api/rtk-api';
import { OAuthControls, OAuthFields, oauthDraft, oauthInput } from '../../components/McpOAuth';
import { OpenApiServers } from './OpenApiServers';

type Transport = McpServerInput['transport'];

/** "Name: value" lines ↔ a record. */
function parsePairs(text: string, sep: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(sep);
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + sep.length).trim();
  }
  return out;
}

export function ToolServersPage() {
  const { t } = useTranslation();
  const { data, isLoading, refetch } = useAdminMcpServersQuery();
  const [disconnect] = useDisconnectMcpOAuthMutation();
  const [editing, setEditing] = useState<AdminMcpServerView | 'new' | null>(null);
  const [toDelete, setToDelete] = useState<AdminMcpServerView | null>(null);
  const [remove] = useDeleteMcpServerMutation();
  const [restart] = useRestartMcpServerMutation();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text-secondary">{t('admin.toolServersHelp')}</p>
        <Button size="sm" onClick={() => setEditing('new')} data-testid="new-tool-server">
          {t('admin.newToolServer')}
        </Button>
      </div>
      <ul className="space-y-3">
        {isLoading && <li className="text-sm text-text-secondary">{t('app.loading')}</li>}
        {data?.servers.length === 0 && <li className="text-sm text-text-secondary">{t('admin.noToolServers')}</li>}
        {data?.servers.map((s) => (
          <li key={s.id} className="rounded-lg border border-border bg-surface p-4">
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {s.name}{' '}
                  <span className="text-xs text-text-secondary">
                    {s.transport} · {t(`mcp.status.${s.status}`, { defaultValue: s.status })}
                  </span>
                  {!s.enabled && <span className="ms-2 text-xs text-text-secondary">(off)</span>}
                </div>
                <div className="truncate text-sm text-text-secondary">{s.url ?? [s.command, ...s.args].join(' ')}</div>
                <div className="text-xs text-text-secondary">
                  {t('admin.toolCount', { count: s.toolCount })}
                  {s.headerNames.length > 0 && ` · ${t('admin.headersSet', { names: s.headerNames.join(', ') })}`}
                  {s.error && <span className="text-error"> · {s.error}</span>}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {s.oauth && (
                  <OAuthControls
                    oauth={s.oauth}
                    connectUrl={`/api/admin/mcp-servers/${s.id}/oauth/connect`}
                    disabled={!s.enabled}
                    refetch={async () => !!(await refetch()).data?.servers.find((x) => x.id === s.id)?.oauth?.connected}
                    onDisconnect={() => void disconnect(s.id)}
                  />
                )}
                {s.enabled && (
                  <Button size="sm" variant="secondary" onClick={() => void restart(s.id)}>
                    {t('admin.restart')}
                  </Button>
                )}
                <Button size="sm" variant="secondary" onClick={() => setEditing(s)}>
                  {t('app.edit')}
                </Button>
                <Button size="sm" variant="ghost" className="text-error" onClick={() => setToDelete(s)}>
                  {t('app.delete')}
                </Button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {editing && <ToolServerForm server={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        isOpen={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={async () => {
          if (toDelete) await remove(toDelete.id);
          setToDelete(null);
        }}
        title={t('admin.deleteToolServerTitle')}
        message={t('admin.deleteToolServerBody')}
        confirmText={t('app.delete')}
        cancelText={t('app.cancel')}
        isDestructive
      />
      <OpenApiServers />
    </div>
  );
}

function ToolServerForm({ server, onClose }: { server: AdminMcpServerView | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [create, createState] = useCreateMcpServerMutation();
  const [update, updateState] = useUpdateMcpServerMutation();
  const [name, setName] = useState(server?.name ?? '');
  const [description, setDescription] = useState(server?.description ?? '');
  const [transport, setTransport] = useState<Transport>(server?.transport ?? 'streamable-http');
  const [url, setUrl] = useState(server?.url ?? '');
  const [command, setCommand] = useState(server?.command ?? '');
  const [args, setArgs] = useState((server?.args ?? []).join('\n'));
  // Secrets are write-only: blank keeps what's stored
  const [headers, setHeaders] = useState('');
  const [env, setEnv] = useState('');
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [oauth, setOAuth] = useState(oauthDraft(server?.oauth));
  const error = errorMessage(createState.error ?? updateState.error);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body: Partial<McpServerInput> = {
      name,
      description: description || null,
      transport,
      enabled,
      ...(transport === 'stdio'
        ? { command, args: args.split('\n').map((a) => a.trim()).filter(Boolean), oauth: null }
        : { url, oauth: oauthInput(oauth) }),
      ...(headers.trim() ? { headers: parsePairs(headers, ':') } : {}),
      ...(env.trim() ? { env: parsePairs(env, '=') } : {}),
    };
    const res = server ? await update({ id: server.id, ...body }) : await create(body);
    if (!('error' in res)) onClose();
  };

  return (
    <Modal isOpen onClose={onClose} title={server ? t('admin.editToolServer') : t('admin.newToolServer')} size="lg">
      <form className="space-y-3" onSubmit={submit}>
        <Input label={t('admin.connectionName')} value={name} onChange={(e) => setName(e.target.value)} required />
        <Input label={t('admin.description')} value={description} onChange={(e) => setDescription(e.target.value)} />
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t('admin.transport')}</span>
          <select
            className="w-full rounded border border-border bg-background px-2 py-2"
            value={transport}
            onChange={(e) => setTransport(e.target.value as Transport)}
          >
            <option value="streamable-http">Streamable HTTP</option>
            <option value="sse">SSE</option>
            <option value="stdio">{t('admin.stdio')}</option>
          </select>
        </label>
        {transport === 'stdio' ? (
          <>
            <p className="rounded border border-warning/40 px-3 py-2 text-xs text-text-secondary">{t('admin.stdioWarning')}</p>
            <Input label={t('admin.command')} value={command} onChange={(e) => setCommand(e.target.value)} required />
            <label className="block text-sm">
              <span className="mb-1 block font-medium">{t('admin.args')}</span>
              <textarea
                className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs"
                rows={3}
                value={args}
                onChange={(e) => setArgs(e.target.value)}
              />
            </label>
            <SecretPairs
              label={t('admin.envVars')}
              placeholder="API_TOKEN=…"
              stored={server?.envNames ?? []}
              value={env}
              onChange={setEnv}
            />
          </>
        ) : (
          <>
            <Input label="URL" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/mcp" required />
            <SecretPairs
              label={t('admin.headers')}
              placeholder="Authorization: Bearer …"
              stored={server?.headerNames ?? []}
              value={headers}
              onChange={setHeaders}
            />
            <OAuthFields value={oauth} onChange={setOAuth} stored={server?.oauth} />
          </>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t('admin.enabled')}
        </label>
        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={createState.isLoading || updateState.isLoading}>
            {t('app.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function SecretPairs(props: { label: string; placeholder: string; stored: string[]; value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{props.label}</span>
      <textarea
        className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs"
        rows={3}
        placeholder={props.placeholder}
        autoComplete="off"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <span className="mt-1 block text-xs text-text-secondary">
        {props.stored.length > 0 ? t('admin.secretsStored', { names: props.stored.join(', ') }) : t('admin.secretsHelp')}
      </span>
    </label>
  );
}

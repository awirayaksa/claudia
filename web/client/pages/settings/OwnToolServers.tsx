import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import type { UserMcpServerInput, UserMcpServerView } from '@shared/workspace';
import {
  errorMessage,
  useCreateOwnMcpServerMutation,
  useDeleteOwnMcpServerMutation,
  useOwnMcpServersQuery,
  useUpdateOwnMcpServerMutation,
} from '../../api/rtk-api';

/** "Name: value" lines → headers (undefined when empty, so stored ones stay on edit). */
function parseHeaders(text: string): Record<string, string> | undefined {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  return Object.fromEntries(
    lines.map((l) => {
      const i = l.indexOf(':');
      return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : [l, ''];
    })
  );
}

/** Remote MCP servers of your own (HTTP or SSE), when the administrator allows them. */
export function OwnToolServers() {
  const { t } = useTranslation();
  const { data } = useOwnMcpServersQuery();
  const [remove] = useDeleteOwnMcpServerMutation();
  const [update] = useUpdateOwnMcpServerMutation();
  const [editing, setEditing] = useState<UserMcpServerView | 'new' | null>(null);
  if (!data || (!data.allowed && data.servers.length === 0)) return null;

  return (
    <section className="space-y-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold">{t('ownTools.title')}</h3>
          <p className="text-xs text-text-secondary">{t('ownTools.help')}</p>
        </div>
        {data.allowed && editing === null && (
          <Button size="sm" onClick={() => setEditing('new')}>
            {t('ownTools.add')}
          </Button>
        )}
      </div>
      {editing && <ServerForm server={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />}
      <ul className="divide-y divide-border rounded border border-border" data-testid="own-servers">
        {data.servers.length === 0 && <li className="px-3 py-2 text-sm text-text-secondary">{t('ownTools.none')}</li>}
        {data.servers.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">
                {s.name} {!s.enabled && <span className="text-xs font-normal text-text-secondary">({t('ownTools.off')})</span>}
              </div>
              <div className="truncate text-xs text-text-secondary">
                {s.url}
                {s.headerNames.length > 0 && ` · ${t('ownTools.headers', { names: s.headerNames.join(', ') })}`}
              </div>
            </div>
            {data.allowed && (
              <>
                <Button size="sm" variant="secondary" onClick={() => void update({ id: s.id, enabled: !s.enabled })}>
                  {s.enabled ? t('ownTools.turnOff') : t('ownTools.turnOn')}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setEditing(s)}>
                  {t('app.edit')}
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" className="text-error" onClick={() => void remove(s.id)}>
              {t('app.delete')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ServerForm({ server, onDone }: { server: UserMcpServerView | null; onDone: () => void }) {
  const { t } = useTranslation();
  const [create, createState] = useCreateOwnMcpServerMutation();
  const [update, updateState] = useUpdateOwnMcpServerMutation();
  const [name, setName] = useState(server?.name ?? '');
  const [url, setUrl] = useState(server?.url ?? '');
  const [transport, setTransport] = useState<UserMcpServerInput['transport']>(server?.transport ?? 'streamable-http');
  const [headers, setHeaders] = useState('');
  const error = errorMessage(createState.error ?? updateState.error);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const h = parseHeaders(headers);
    const body = { name: name.trim(), url: url.trim(), transport, ...(h ? { headers: h } : {}) };
    const res = server ? await update({ id: server.id, ...body }) : await create(body);
    if (!('error' in res)) onDone();
  };

  return (
    <form className="space-y-2 rounded border border-border p-3" onSubmit={submit} data-testid="own-server-form">
      <div className="grid gap-2 sm:grid-cols-3">
        <input
          className="rounded border border-border bg-background px-2 py-1.5 text-sm"
          placeholder={t('ownTools.name')}
          aria-label={t('ownTools.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <input
          className="rounded border border-border bg-background px-2 py-1.5 text-sm sm:col-span-2"
          placeholder="https://mcp.example.com/mcp"
          aria-label={t('ownTools.url')}
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
        />
      </div>
      <select
        className="rounded border border-border bg-background px-2 py-1.5 text-sm"
        aria-label={t('ownTools.transport')}
        value={transport}
        onChange={(e) => setTransport(e.target.value as UserMcpServerInput['transport'])}
      >
        <option value="streamable-http">Streamable HTTP</option>
        <option value="sse">SSE</option>
      </select>
      <textarea
        className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-xs"
        rows={2}
        placeholder={server?.headerNames.length ? t('ownTools.headersKeep') : 'Authorization: Bearer …'}
        aria-label={t('ownTools.headersLabel')}
        value={headers}
        onChange={(e) => setHeaders(e.target.value)}
      />
      {error && <p className="text-sm text-error">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onDone}>
          {t('app.cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={createState.isLoading || updateState.isLoading}>
          {t('app.save')}
        </Button>
      </div>
    </form>
  );
}

import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Modal } from '@/components/common/Modal';
import {
  errorMessage,
  useCreateToolServerMutation,
  useDeleteToolServerMutation,
  useToolServersQuery,
  useUpdateToolServerMutation,
  type ToolServerView,
} from '../../api/rtk-api';

/** OpenAPI tool servers: every operation of the spec becomes a tool. */
export function OpenApiServers() {
  const { t } = useTranslation();
  const { data } = useToolServersQuery();
  const [update] = useUpdateToolServerMutation();
  const [remove] = useDeleteToolServerMutation();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="space-y-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">{t('openapi.title')}</h2>
          <p className="text-sm text-text-secondary">{t('openapi.help')}</p>
        </div>
        <Button size="sm" onClick={() => setAdding(true)} data-testid="new-openapi-server">
          {t('openapi.add')}
        </Button>
      </div>
      {error && <p className="text-sm text-error">{error}</p>}
      <ul className="space-y-3" data-testid="openapi-servers">
        {data?.servers.length === 0 && <li className="text-sm text-text-secondary">{t('openapi.none')}</li>}
        {data?.servers.map((s: ToolServerView) => (
          <li key={s.id} className="rounded-lg border border-border bg-surface p-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{s.name}</div>
                <div className="truncate text-xs text-text-secondary">
                  {s.baseUrl} · {t('admin.toolCount', { count: s.operations.length })}
                  {s.hasAuth && ` · ${t('openapi.authWith', { header: s.authHeader })}`}
                </div>
              </div>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={s.enabled} onChange={(e) => void update({ id: s.id, enabled: e.target.checked })} />
                {t('plugins.enabled')}
              </label>
              {s.specUrl && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={async () => {
                    const res = await update({ id: s.id, refresh: true });
                    setError('error' in res ? errorMessage(res.error) : null);
                  }}
                >
                  {t('openapi.reload')}
                </Button>
              )}
              <Button size="sm" variant="ghost" className="text-error" onClick={() => void remove(s.id)}>
                {t('app.delete')}
              </Button>
            </div>
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-text-secondary">{t('openapi.operations')}</summary>
              <ul className="mt-1 space-y-0.5">
                {s.operations.map((o) => (
                  <li key={o.name} className="truncate">
                    <code className="font-semibold">{o.name}</code> <span className="text-text-secondary">{o.method} {o.path} — {o.description}</span>
                  </li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ul>
      {adding && <AddServer onClose={() => setAdding(false)} />}
    </section>
  );
}

function AddServer({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [create, state] = useCreateToolServerMutation();
  const [name, setName] = useState('');
  const [specUrl, setSpecUrl] = useState('');
  const [specText, setSpecText] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [authHeader, setAuthHeader] = useState('Authorization');
  const [authValue, setAuthValue] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const res = await create({
      name: name.trim(),
      specUrl: specUrl.trim() || null,
      ...(specText.trim() ? { specText } : {}),
      baseUrl: baseUrl.trim(),
      ...(authValue ? { authHeader: authHeader.trim() || 'Authorization', authValue } : {}),
    });
    if (!('error' in res)) onClose();
  };

  return (
    <Modal isOpen onClose={onClose} title={t('openapi.add')} size="lg">
      <form className="space-y-3" onSubmit={submit}>
        <Input label={t('workspace.name')} value={name} onChange={(e) => setName(e.target.value)} required />
        <Input label={t('openapi.specUrl')} placeholder="https://api.example.com/openapi.json" value={specUrl} onChange={(e) => setSpecUrl(e.target.value)} />
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t('openapi.specText')}</span>
          <textarea className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-xs" rows={5} value={specText} onChange={(e) => setSpecText(e.target.value)} />
        </label>
        <Input label={t('openapi.baseUrl')} placeholder={t('openapi.baseUrlPlaceholder')} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label={t('openapi.authHeader')} value={authHeader} onChange={(e) => setAuthHeader(e.target.value)} />
          <Input label={t('openapi.authValue')} type="password" placeholder="Bearer …" value={authValue} onChange={(e) => setAuthValue(e.target.value)} />
        </div>
        {state.error && <p className="text-sm text-error">{errorMessage(state.error)}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={!name.trim() || (!specUrl.trim() && !specText.trim()) || state.isLoading}>
            {t('app.add')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

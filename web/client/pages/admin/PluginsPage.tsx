import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { api, errorMessage, useAdminPluginsQuery, useDeletePluginMutation, useUpdatePluginMutation } from '../../api/rtk-api';
import { apiFetchRaw, toApiError } from '../../api/http';
import { useWebDispatch } from '../../hooks';

/**
 * Admin → Plugins: renderer plugins as ES modules (the desktop's plugin API).
 * They run with the page's full privileges for everyone, so install only
 * plugins you trust.
 */
export function PluginsPage() {
  const { t } = useTranslation();
  const dispatch = useWebDispatch();
  const { data } = useAdminPluginsQuery();
  const [update] = useUpdatePluginMutation();
  const [remove] = useDeletePluginMutation();
  const manifestRef = useRef<HTMLInputElement>(null);
  const bundleRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toDelete, setToDelete] = useState<string | null>(null);

  const upload = async () => {
    const manifest = manifestRef.current?.files?.[0];
    const bundle = bundleRef.current?.files?.[0];
    if (!manifest || !bundle) {
      setError(t('plugins.pickBoth'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('manifest', await manifest.text());
      form.append('bundle', bundle, 'index.mjs');
      const res = await apiFetchRaw('/api/admin/plugins', { method: 'POST', body: form });
      if (!res.ok) throw await toApiError(res);
      dispatch(api.util.invalidateTags(['Plugins']));
      if (manifestRef.current) manifestRef.current.value = '';
      if (bundleRef.current) bundleRef.current.value = '';
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary">{t('plugins.help')}</p>
      <section className="rounded-lg border border-border bg-surface p-4 text-sm">
        <h2 className="mb-2 font-semibold">{t('plugins.install')}</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block">{t('plugins.manifest')}</span>
            <input ref={manifestRef} type="file" accept=".json,application/json" data-testid="plugin-manifest" />
          </label>
          <label className="block">
            <span className="mb-1 block">{t('plugins.bundle')}</span>
            <input ref={bundleRef} type="file" accept=".mjs,.js,text/javascript" data-testid="plugin-bundle" />
          </label>
        </div>
        <p className="mt-2 text-xs text-text-secondary">{t('plugins.formatHelp')}</p>
        {error && <p className="mt-2 text-error">{error}</p>}
        <Button size="sm" className="mt-3" onClick={() => void upload()} disabled={busy}>
          {t('plugins.upload')}
        </Button>
      </section>
      <ul className="divide-y divide-border rounded-lg border border-border bg-surface" data-testid="plugins">
        {data?.plugins.length === 0 && <li className="p-4 text-sm text-text-secondary">{t('plugins.none')}</li>}
        {data?.plugins.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm" data-testid={`plugin-${p.id}`}>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">
                {p.manifest.name} <span className="text-xs font-normal text-text-secondary">{p.version}</span>
              </div>
              <div className="truncate text-xs text-text-secondary">
                {t(`plugins.types.${p.manifest.type}`)}
                {p.manifest.description && ` · ${p.manifest.description}`}
              </div>
            </div>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={p.enabled} onChange={(e) => void update({ id: p.id, enabled: e.target.checked })} />
              {t('plugins.enabled')}
            </label>
            <Button size="sm" variant="ghost" className="text-error" onClick={() => setToDelete(p.id)}>
              {t('app.delete')}
            </Button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-text-secondary">{t('plugins.reloadHelp')}</p>
      <ConfirmDialog
        isOpen={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={async () => {
          if (toDelete) await remove(toDelete);
          setToDelete(null);
        }}
        title={t('plugins.deleteTitle')}
        message={t('plugins.deleteBody', { id: toDelete ?? '' })}
        confirmText={t('app.delete')}
        cancelText={t('app.cancel')}
        isDestructive
      />
    </div>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { errorMessage, useApiKeysQuery, useCreateApiKeyMutation, useDeleteApiKeyMutation } from '../../api/rtk-api';

/** Keys for the OpenAI-compatible API at /api/v1. */
export function ApiKeysSettings() {
  const { t } = useTranslation();
  const { data } = useApiKeysQuery();
  const [create, createState] = useCreateApiKeyMutation();
  const [remove] = useDeleteApiKeyMutation();
  const [name, setName] = useState('');
  const [days, setDays] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const baseUrl = `${window.location.origin}/api/v1`;

  return (
    <div className="space-y-4 p-5">
      <p className="text-sm text-text-secondary">{t('apiKeys.help')}</p>
      <p className="text-sm">
        {t('apiKeys.baseUrl')}{' '}
        <code className="rounded bg-background px-1.5 py-0.5 text-xs" data-testid="api-base-url">
          {baseUrl}
        </code>
      </p>
      {data && !data.allowed && <p className="text-sm text-text-secondary">{t('apiKeys.notAllowed')}</p>}
      {data?.allowed && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const res = await create({ name: name.trim(), expiresInDays: days ? Number(days) : null });
            if (!('error' in res)) {
              setSecret(res.data.secret);
              setCopied(false);
              setName('');
            }
          }}
        >
          <label className="block min-w-0 flex-1 text-sm">
            <span className="mb-1 block font-medium">{t('apiKeys.name')}</span>
            <input
              className="w-full rounded border border-border bg-background px-2 py-1.5"
              value={name}
              placeholder={t('apiKeys.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={100}
              data-testid="api-key-name"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">{t('apiKeys.expires')}</span>
            <select className="rounded border border-border bg-background px-2 py-1.5" value={days} onChange={(e) => setDays(e.target.value)}>
              <option value="">{t('apiKeys.never')}</option>
              {[7, 30, 90, 365].map((d) => (
                <option key={d} value={d}>
                  {t('apiKeys.days', { count: d })}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" size="sm" disabled={!name.trim() || createState.isLoading}>
            {t('apiKeys.create')}
          </Button>
        </form>
      )}
      {createState.error && <p className="text-sm text-error">{errorMessage(createState.error)}</p>}
      {secret && (
        <div className="rounded border border-accent/50 bg-background p-3 text-sm" role="status">
          <p className="mb-2 font-medium">{t('apiKeys.copyNow')}</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all text-xs" data-testid="api-key-secret">
              {secret}
            </code>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(secret).then(() => setCopied(true));
              }}
            >
              {copied ? t('apiKeys.copied') : t('apiKeys.copy')}
            </Button>
          </div>
        </div>
      )}
      <ul className="divide-y divide-border rounded border border-border" data-testid="api-keys">
        {data?.keys.length === 0 && <li className="px-3 py-2 text-sm text-text-secondary">{t('apiKeys.none')}</li>}
        {data?.keys.map((k) => (
          <li key={k.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{k.name}</div>
              <div className="text-xs text-text-secondary">
                <code>{k.prefix}…</code> · {t('apiKeys.created', { date: new Date(k.createdAt).toLocaleDateString() })}
                {' · '}
                {k.lastUsedAt ? t('apiKeys.lastUsed', { date: new Date(k.lastUsedAt).toLocaleString() }) : t('apiKeys.unused')}
                {k.expiresAt && ` · ${t('apiKeys.expiresOn', { date: new Date(k.expiresAt).toLocaleDateString() })}`}
              </div>
            </div>
            <Button size="sm" variant="ghost" className="text-error" onClick={() => void remove(k.id)}>
              {t('apiKeys.revoke')}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

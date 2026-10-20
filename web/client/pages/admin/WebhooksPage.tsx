import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { WEBHOOK_EVENTS, type WebhookTestResult, type WebhookView } from '@shared/admin';
import {
  errorMessage,
  useCreateWebhookMutation,
  useDeleteWebhookMutation,
  useRotateWebhookSecretMutation,
  useTestWebhookMutation,
  useUpdateWebhookMutation,
  useWebhooksQuery,
} from '../../api/rtk-api';

const eventKey = (e: string) => `webhooks.events.${e.replace('.', '_')}`;

/** Admin: signed webhooks for user, run, knowledge and audit events. */
export function WebhooksPage() {
  const { t } = useTranslation();
  const { data, error } = useWebhooksQuery();
  const [editing, setEditing] = useState<WebhookView | 'new' | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<WebhookView | null>(null);
  const [tested, setTested] = useState<Record<string, WebhookTestResult>>({});
  const [update] = useUpdateWebhookMutation();
  const [rotate] = useRotateWebhookSecretMutation();
  const [test, testState] = useTestWebhookMutation();
  const [remove] = useDeleteWebhookMutation();

  return (
    <div className="space-y-3" data-testid="webhooks">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-text-secondary">{t('webhooks.help')}</p>
        <Button onClick={() => setEditing('new')}>{t('webhooks.new')}</Button>
      </div>
      {error && <p className="text-sm text-error">{errorMessage(error)}</p>}
      {data?.webhooks.length === 0 && <p className="text-sm text-text-secondary">{t('webhooks.none')}</p>}
      <ul className="space-y-2">
        {data?.webhooks.map((w) => {
          const result = tested[w.id];
          return (
            <li key={w.id} className="rounded-lg border border-border bg-surface p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium">{w.name}</div>
                  <div className="truncate font-mono text-xs text-text-secondary" title={w.url}>
                    {w.url}
                  </div>
                  <div className="mt-1 text-xs text-text-secondary">
                    {w.events.includes('*') ? t('webhooks.allEvents') : w.events.map((e) => t(eventKey(e), { defaultValue: e })).join(', ')}
                  </div>
                  <Status webhook={w} />
                  {result && (
                    <div className={`mt-1 text-xs ${result.ok ? 'text-success' : 'text-error'}`} role="status">
                      {result.ok
                        ? t('webhooks.testOk', { status: result.status, ms: result.durationMs })
                        : t('webhooks.testFailed', { error: result.error })}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1 text-sm">
                    <input type="checkbox" checked={w.enabled} onChange={(e) => void update({ id: w.id, enabled: e.target.checked })} />
                    {t('webhooks.enabled')}
                  </label>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={testState.isLoading}
                    onClick={async () => {
                      const res = await test(w.id);
                      if ('data' in res && res.data) setTested((r) => ({ ...r, [w.id]: res.data!.result }));
                    }}
                  >
                    {t('webhooks.test')}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setEditing(w)}>
                    {t('app.edit')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      const res = await rotate(w.id);
                      if ('data' in res && res.data) setSecret(res.data.secret);
                    }}
                  >
                    {t('webhooks.rotate')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setToDelete(w)}>
                    {t('app.delete')}
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {editing && (
        <WebhookForm
          webhook={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onCreated={(s) => {
            setEditing(null);
            setSecret(s);
          }}
        />
      )}
      {secret && <SecretModal secret={secret} onClose={() => setSecret(null)} />}
      <ConfirmDialog
        isOpen={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={async () => {
          if (toDelete) await remove(toDelete.id);
          setToDelete(null);
        }}
        title={t('webhooks.deleteTitle')}
        message={t('webhooks.deleteBody', { name: toDelete?.name ?? '' })}
        confirmText={t('app.delete')}
        isDestructive
      />
    </div>
  );
}

function Status({ webhook }: { webhook: WebhookView }) {
  const { t } = useTranslation();
  if (!webhook.lastDeliveryAt) return <div className="mt-1 text-xs text-text-secondary">{t('webhooks.neverDelivered')}</div>;
  const when = new Date(webhook.lastDeliveryAt).toLocaleString();
  return webhook.lastError ? (
    <div className="mt-1 text-xs text-error">{t('webhooks.lastFailed', { when, error: webhook.lastError })}</div>
  ) : (
    <div className="mt-1 text-xs text-success">{t('webhooks.lastOk', { when, status: webhook.lastStatus })}</div>
  );
}

function WebhookForm({ webhook, onClose, onCreated }: { webhook: WebhookView | null; onClose: () => void; onCreated: (secret: string) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(webhook?.name ?? '');
  const [url, setUrl] = useState(webhook?.url ?? '');
  const [all, setAll] = useState(webhook ? webhook.events.includes('*') : false);
  const [events, setEvents] = useState<string[]>(webhook?.events.filter((e) => e !== '*') ?? ['user.created']);
  const [create, createState] = useCreateWebhookMutation();
  const [update, updateState] = useUpdateWebhookMutation();
  const err = createState.error ?? updateState.error;

  const submit = async () => {
    const body = { name, url, events: (all ? ['*'] : events) as Array<(typeof WEBHOOK_EVENTS)[number] | '*'> };
    if (webhook) {
      const res = await update({ id: webhook.id, ...body });
      if ('data' in res) onClose();
    } else {
      const res = await create({ ...body, enabled: true });
      if ('data' in res && res.data) onCreated(res.data.secret);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={webhook ? t('webhooks.edit') : t('webhooks.new')}
      footer={
        <div className="flex items-center justify-end gap-2">
          {err && <span className="me-auto text-sm text-error">{errorMessage(err)}</span>}
          <Button variant="secondary" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={!name.trim() || !url.trim() || (!all && events.length === 0)}>
            {t('app.save')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t('webhooks.name')}</span>
          <input className="w-full rounded border border-border bg-background px-2 py-1" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t('webhooks.url')}</span>
          <input
            className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs"
            placeholder="https://hooks.example.com/claudia"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <fieldset className="text-sm">
          <legend className="mb-1 font-medium">{t('webhooks.eventsLabel')}</legend>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            {t('webhooks.allEvents')}
          </label>
          {!all && (
            <div className="mt-2 grid gap-1 sm:grid-cols-2">
              {WEBHOOK_EVENTS.map((e) => (
                <label key={e} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={events.includes(e)}
                    onChange={(ev) => setEvents(ev.target.checked ? [...events, e] : events.filter((x) => x !== e))}
                  />
                  <span>
                    {t(eventKey(e))} <code className="text-xs text-text-secondary">{e}</code>
                  </span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
      </div>
    </Modal>
  );
}

function SecretModal({ secret, onClose }: { secret: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <Modal isOpen onClose={onClose} title={t('webhooks.secretTitle')} footer={<Button onClick={onClose}>{t('app.done')}</Button>}>
      <p className="mb-2 text-sm">{t('webhooks.secretHelp')}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded border border-border bg-background px-2 py-1 text-xs" data-testid="webhook-secret">
          {secret}
        </code>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(secret).then(() => setCopied(true));
          }}
        >
          {copied ? t('app.copied') : t('app.copy')}
        </Button>
      </div>
      <p className="mt-4 mb-1 text-sm font-medium">{t('webhooks.verifyTitle')}</p>
      <p className="mb-2 text-xs text-text-secondary">{t('webhooks.verifyHelp')}</p>
      <pre className="overflow-x-auto rounded bg-background p-2 text-xs">{`const ts = req.headers['x-claudia-timestamp'];
const expected = 'v1=' + crypto
  .createHmac('sha256', SECRET)
  .update(\`\${ts}.\${rawBody}\`)
  .digest('hex');
// Compare with crypto.timingSafeEqual, and refuse
// timestamps more than 5 minutes old.`}</pre>
    </Modal>
  );
}

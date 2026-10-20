import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Modal } from '@/components/common/Modal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import type { ConnectionInput, ConnectionType, ConnectionView } from '@shared/models';
import {
  errorMessage,
  useConnectionsQuery,
  useCreateConnectionMutation,
  useCreateMyConnectionMutation,
  useDeleteConnectionMutation,
  useDeleteMyConnectionMutation,
  useMyConnectionsQuery,
  useTestConnectionMutation,
  useTestMyConnectionMutation,
  useUpdateConnectionMutation,
  useUpdateMyConnectionMutation,
} from '../../api/rtk-api';

const TYPES: ConnectionType[] = ['openai', 'anthropic', 'ollama', 'openrouter', 'openwebui', 'opencode-go'];

/** Global connections (admin) or the signed-in user's own ("@prefix/…" models). */
type Scope = 'global' | 'own';

const useListFor = (scope: Scope) => {
  const global = useConnectionsQuery(undefined, { skip: scope !== 'global' });
  const own = useMyConnectionsQuery(undefined, { skip: scope !== 'own' });
  return scope === 'global'
    ? { connections: global.data?.connections, isLoading: global.isLoading, allowed: true }
    : { connections: own.data?.connections, isLoading: own.isLoading, allowed: own.data?.enabled ?? true };
};

export function ConnectionsPage() {
  return <ConnectionsManager scope="global" />;
}

export function ConnectionsManager({ scope }: { scope: Scope }) {
  const { t } = useTranslation();
  const { connections, isLoading, allowed } = useListFor(scope);
  const [editing, setEditing] = useState<ConnectionView | 'new' | null>(null);
  const [toDelete, setToDelete] = useState<ConnectionView | null>(null);
  const [deleteGlobal] = useDeleteConnectionMutation();
  const [deleteOwn] = useDeleteMyConnectionMutation();
  const [testGlobal] = useTestConnectionMutation();
  const [testOwn] = useTestMyConnectionMutation();
  const deleteConnection = scope === 'global' ? deleteGlobal : deleteOwn;
  const testConnection = scope === 'global' ? testGlobal : testOwn;
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  const test = async (c: ConnectionView) => {
    setTestResult((r) => ({ ...r, [c.id]: t('app.loading') }));
    const res = await testConnection(c.id);
    setTestResult((r) => ({
      ...r,
      [c.id]:
        'data' in res && res.data
          ? res.data.ok
            ? t('admin.testOk', { count: res.data.models.length })
            : t('admin.testFailed', { error: res.data.error })
          : t('admin.testFailed', { error: errorMessage(res.error) }),
    }));
  };

  return (
    <div className="space-y-4">
      {scope === 'own' && (
        <p className="text-sm text-text-secondary">{allowed ? t('settings.ownConnectionsHelp') : t('settings.ownConnectionsOff')}</p>
      )}
      {allowed && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setEditing('new')} data-testid="new-connection">
            {t('admin.newConnection')}
          </Button>
        </div>
      )}
      <ul className="space-y-3">
        {isLoading && <li className="text-sm text-text-secondary">{t('app.loading')}</li>}
        {connections?.map((c) => (
          <li key={c.id} className="rounded-lg border border-border bg-surface p-4">
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {c.name}{' '}
                  <span className="text-xs text-text-secondary">
                    {t(`admin.types.${c.type}`)} · {scope === 'own' ? '@' : ''}
                    {c.prefix}/…
                  </span>
                  {!c.enabled && <span className="ms-2 text-xs text-text-secondary">(off)</span>}
                </div>
                <div className="truncate text-sm text-text-secondary">
                  {c.baseUrl || '—'}
                  {c.quirks.insecureTls && <span className="text-error"> · {t('admin.insecureTlsBadge')}</span>}
                </div>
                <div className="text-xs text-text-secondary">
                  {t('admin.models', { count: c.modelCount })}
                  {c.error && <span className="text-error"> · {c.error}</span>}
                </div>
                {testResult[c.id] && <div className="mt-1 text-xs">{testResult[c.id]}</div>}
              </div>
              <div className="flex gap-2">
                {allowed && (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => void test(c)}>
                      {t('admin.test')}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setEditing(c)}>
                      {t('app.edit')}
                    </Button>
                  </>
                )}
                <Button size="sm" variant="ghost" className="text-error" onClick={() => setToDelete(c)}>
                  {t('app.delete')}
                </Button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {editing && <ConnectionForm scope={scope} connection={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        isOpen={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={async () => {
          if (toDelete) await deleteConnection(toDelete.id);
          setToDelete(null);
        }}
        title={t('admin.deleteConnectionTitle')}
        message={t('admin.deleteConnectionBody')}
        confirmText={t('app.delete')}
        cancelText={t('app.cancel')}
        isDestructive
      />
    </div>
  );
}

function ConnectionForm({ scope, connection, onClose }: { scope: Scope; connection: ConnectionView | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [createGlobal, createGlobalState] = useCreateConnectionMutation();
  const [updateGlobal, updateGlobalState] = useUpdateConnectionMutation();
  const [createOwn, createOwnState] = useCreateMyConnectionMutation();
  const [updateOwn, updateOwnState] = useUpdateMyConnectionMutation();
  const [create, createState] = scope === 'global' ? [createGlobal, createGlobalState] : [createOwn, createOwnState];
  const [update, updateState] = scope === 'global' ? [updateGlobal, updateGlobalState] : [updateOwn, updateOwnState];
  const [name, setName] = useState(connection?.name ?? '');
  const [prefix, setPrefix] = useState(connection?.prefix ?? '');
  const [type, setType] = useState<ConnectionType>(connection?.type ?? 'openai');
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [modelFilter, setModelFilter] = useState((connection?.modelFilter ?? []).join(', '));
  const [toolsFirstTurnOnly, setToolsFirstTurnOnly] = useState(connection?.quirks.toolsFirstTurnOnly ?? false);
  const [apiCompatibility, setApiCompatibility] = useState(connection?.quirks.apiCompatibility ?? 'openai');
  const [insecureTls, setInsecureTls] = useState(connection?.quirks.insecureTls ?? false);
  // Only admins' connections may skip certificate checks; OpenRouter is a fixed public endpoint
  const canSkipTls = scope === 'global' && type !== 'openrouter';
  const [enabled, setEnabled] = useState(connection?.enabled ?? true);
  const error = errorMessage(createState.error ?? updateState.error);

  // Suggest a prefix from the name for new connections
  useEffect(() => {
    if (!connection) setPrefix(name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40));
  }, [name, connection]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const filter = modelFilter
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const body: Partial<ConnectionInput> = {
      name,
      prefix,
      type,
      baseUrl,
      modelFilter: filter.length ? filter : null,
      quirks: {
        toolsFirstTurnOnly,
        ...(type === 'opencode-go' ? { apiCompatibility } : {}),
        ...(canSkipTls && insecureTls ? { insecureTls } : {}),
      },
      enabled,
      ...(apiKey ? { apiKey } : removeKey ? { apiKey: '' } : {}),
    };
    const res = connection ? await update({ id: connection.id, ...body }) : await create(body);
    if (!('error' in res)) onClose();
  };

  return (
    <Modal isOpen onClose={onClose} title={connection ? t('admin.editConnection') : t('admin.newConnection')} size="lg">
      <form className="space-y-3" onSubmit={submit}>
        <Input label={t('admin.connectionName')} value={name} onChange={(e) => setName(e.target.value)} required />
        <Input
          label={t('admin.prefix')}
          helperText={t('admin.prefixHelp')}
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          required
        />
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t('admin.type')}</span>
          <select
            className="w-full rounded border border-border bg-background px-2 py-2"
            value={type}
            onChange={(e) => setType(e.target.value as ConnectionType)}
          >
            {TYPES.map((ty) => (
              <option key={ty} value={ty}>
                {t(`admin.types.${ty}`)}
              </option>
            ))}
          </select>
        </label>
        {type !== 'openrouter' && (
          <Input
            label={t('admin.baseUrl')}
            helperText={t('admin.baseUrlHelp')}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={type === 'openai' ? 'https://api.openai.com/v1' : 'https://…'}
          />
        )}
        {canSkipTls && (
          <div className="text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={insecureTls}
                onChange={(e) => setInsecureTls(e.target.checked)}
                data-testid="connection-insecure-tls"
              />
              {t('admin.insecureTls')}
            </label>
            {insecureTls && <p className="mt-1 text-xs text-error">{t('admin.insecureTlsHelp')}</p>}
          </div>
        )}
        <Input
          label={t('admin.apiKey')}
          type="password"
          showPasswordToggle
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          helperText={
            connection?.hasKey
              ? connection.keyLast4
                ? t('admin.apiKeyKeep', { last4: connection.keyLast4 })
                : t('admin.apiKeySet')
              : undefined
          }
        />
        {connection?.hasKey && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={removeKey} onChange={(e) => setRemoveKey(e.target.checked)} />
            {t('admin.removeKey')}
          </label>
        )}
        <Input
          label={t('admin.modelFilter')}
          helperText={t('admin.modelFilterHelp')}
          value={modelFilter}
          onChange={(e) => setModelFilter(e.target.value)}
        />
        {type === 'opencode-go' && (
          <label className="block text-sm">
            <span className="mb-1 block font-medium">{t('admin.apiCompatibility')}</span>
            <select
              className="w-full rounded border border-border bg-background px-2 py-2"
              value={apiCompatibility}
              onChange={(e) => setApiCompatibility(e.target.value as 'openai' | 'anthropic')}
            >
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={toolsFirstTurnOnly} onChange={(e) => setToolsFirstTurnOnly(e.target.checked)} />
          {t('admin.toolsFirstTurnOnly')}
        </label>
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

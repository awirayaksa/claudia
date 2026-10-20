import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import type { SsoProviderInput, SsoProviderView } from '@shared/auth';
import {
  errorMessage,
  useAppSettingsQuery,
  useCreateSsoProviderMutation,
  useDeleteSsoProviderMutation,
  useDisableScimMutation,
  useNewScimTokenMutation,
  useScimQuery,
  useSsoProvidersQuery,
  useTestSsoProviderMutation,
  useUpdateAppSettingMutation,
  useUpdateSsoProviderMutation,
} from '../../api/rtk-api';

type ProviderRow = SsoProviderView & { callbackUrl: string };

/** Admin → Sign-in: two-factor policy, single sign-on providers and SCIM provisioning. */
export function SignInPage() {
  return (
    <div className="space-y-4">
      <MfaPolicy />
      <SsoProviders />
      <Scim />
    </div>
  );
}

function Card({ title, help, children }: { title: string; help?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="font-semibold">{title}</h2>
      {help && <p className="mb-3 mt-1 text-sm text-text-secondary">{help}</p>}
      {children}
    </section>
  );
}

function MfaPolicy() {
  const { t } = useTranslation();
  const { data } = useAppSettingsQuery();
  const [save, state] = useUpdateAppSettingMutation();
  const value = data?.settings['auth.mfa'].require ?? 'off';
  return (
    <Card title={t('signin.mfaTitle')} help={t('signin.mfaHelp')}>
      <select
        aria-label={t('signin.mfaTitle')}
        className="rounded border border-border bg-background px-2 py-1 text-sm"
        value={value}
        onChange={(e) => void save({ key: 'auth.mfa', value: { require: e.target.value } })}
      >
        {(['off', 'admins', 'everyone'] as const).map((v) => (
          <option key={v} value={v}>
            {t(`signin.mfa.${v}`)}
          </option>
        ))}
      </select>
      {value !== 'off' && <p className="mt-2 text-xs text-text-secondary">{t('signin.mfaEffect')}</p>}
      {state.error && <p className="mt-2 text-sm text-error">{errorMessage(state.error)}</p>}
    </Card>
  );
}

function SsoProviders() {
  const { t } = useTranslation();
  const { data } = useSsoProvidersQuery();
  const [editing, setEditing] = useState<ProviderRow | 'new' | null>(null);
  const [toDelete, setToDelete] = useState<ProviderRow | null>(null);
  const [tested, setTested] = useState<Record<string, string>>({});
  const [update] = useUpdateSsoProviderMutation();
  const [test] = useTestSsoProviderMutation();
  const [remove] = useDeleteSsoProviderMutation();

  return (
    <Card title={t('signin.ssoTitle')} help={t('signin.ssoHelp')}>
      <ul className="mb-3 space-y-2" data-testid="sso-providers">
        {data?.providers.length === 0 && <li className="text-sm text-text-secondary">{t('signin.noProviders')}</li>}
        {data?.providers.map((p) => (
          <li key={p.id} className="rounded border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{p.name}</span>
              <code className="text-xs text-text-secondary">{p.issuer}</code>
              <label className="ms-auto flex items-center gap-1 text-sm">
                <input type="checkbox" checked={p.enabled} onChange={(e) => void update({ id: p.id, enabled: e.target.checked })} />
                {t('webhooks.enabled')}
              </label>
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  const res = await test(p.id);
                  if ('data' in res && res.data) setTested((r) => ({ ...r, [p.id]: res.data!.ok ? t('signin.testOk', { issuer: res.data!.issuer }) : `✗ ${res.data!.error}` }));
                }}
              >
                {t('webhooks.test')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setEditing(p)}>
                {t('app.edit')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setToDelete(p)}>
                {t('app.delete')}
              </Button>
            </div>
            <p className="mt-1 text-xs text-text-secondary">
              {t('signin.redirectUri')} <code className="break-all">{p.callbackUrl}</code>
            </p>
            {tested[p.id] && (
              <p className="mt-1 text-xs" role="status">
                {tested[p.id]}
              </p>
            )}
          </li>
        ))}
      </ul>
      <Button size="sm" onClick={() => setEditing('new')}>
        {t('signin.addProvider')}
      </Button>
      {editing && <ProviderForm provider={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        isOpen={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={async () => {
          if (toDelete) await remove(toDelete.id);
          setToDelete(null);
        }}
        title={t('signin.deleteTitle')}
        message={t('signin.deleteBody', { name: toDelete?.name ?? '' })}
        confirmText={t('app.delete')}
        isDestructive
      />
    </Card>
  );
}

function ProviderForm({ provider, onClose }: { provider: ProviderRow | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState({
    id: provider?.id ?? '',
    name: provider?.name ?? '',
    issuer: provider?.issuer ?? '',
    clientId: provider?.clientId ?? '',
    clientSecret: '',
    scopes: provider?.scopes ?? 'openid email profile',
    allowSignup: provider?.allowSignup ?? true,
    defaultRole: provider?.defaultRole ?? ('pending' as 'pending' | 'user'),
    allowedDomains: provider?.allowedDomains.join(', ') ?? '',
    linkByEmail: provider?.linkByEmail ?? false,
    groupsClaim: provider?.groupsClaim ?? '',
    adminGroups: provider?.adminGroups.join(', ') ?? '',
  });
  const [create, createState] = useCreateSsoProviderMutation();
  const [update, updateState] = useUpdateSsoProviderMutation();
  const err = createState.error ?? updateState.error;
  const set = (patch: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...patch }));
  const list = (s: string) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);

  const submit = async () => {
    const body: SsoProviderInput = {
      id: draft.id,
      name: draft.name,
      issuer: draft.issuer,
      clientId: draft.clientId,
      ...(draft.clientSecret ? { clientSecret: draft.clientSecret } : {}),
      scopes: draft.scopes,
      allowSignup: draft.allowSignup,
      defaultRole: draft.defaultRole,
      allowedDomains: list(draft.allowedDomains),
      linkByEmail: draft.linkByEmail,
      groupsClaim: draft.groupsClaim.trim() || null,
      adminGroups: list(draft.adminGroups),
    };
    const res = provider ? await update(body) : await create(body);
    if ('data' in res) onClose();
  };

  const field = (key: keyof typeof draft, label: string, props: Record<string, unknown> = {}) => (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      <input
        className="w-full rounded border border-border bg-background px-2 py-1"
        value={String(draft[key])}
        onChange={(e) => set({ [key]: e.target.value } as Partial<typeof draft>)}
        {...props}
      />
    </label>
  );
  const check = (key: 'allowSignup' | 'linkByEmail', label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={draft[key]} onChange={(e) => set({ [key]: e.target.checked })} />
      {label}
    </label>
  );

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={provider ? t('signin.editProvider') : t('signin.addProvider')}
      footer={
        <div className="flex items-center justify-end gap-2">
          {err && <span className="me-auto text-sm text-error">{errorMessage(err)}</span>}
          <Button variant="secondary" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={!draft.id || !draft.name || !draft.issuer || !draft.clientId}>
            {t('app.save')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          {field('name', t('signin.name'), { placeholder: 'Microsoft' })}
          {field('id', t('signin.slug'), { placeholder: 'entra', disabled: !!provider })}
        </div>
        {field('issuer', t('signin.issuer'), { placeholder: 'https://login.microsoftonline.com/<tenant>/v2.0' })}
        <div className="grid gap-3 sm:grid-cols-2">
          {field('clientId', t('signin.clientId'))}
          {field('clientSecret', provider?.hasSecret ? t('signin.clientSecretKeep') : t('signin.clientSecret'), { type: 'password', autoComplete: 'off' })}
        </div>
        {field('scopes', t('signin.scopes'))}
        <div className="grid gap-3 sm:grid-cols-2">
          {check('allowSignup', t('signin.allowSignup'))}
          <label className="flex items-center gap-2 text-sm">
            {t('admin.defaultRole')}
            <select
              className="rounded border border-border bg-background px-2 py-1"
              value={draft.defaultRole}
              onChange={(e) => set({ defaultRole: e.target.value as 'pending' | 'user' })}
            >
              <option value="pending">{t('admin.roles.pending')}</option>
              <option value="user">{t('admin.roles.user')}</option>
            </select>
          </label>
        </div>
        {field('allowedDomains', t('signin.allowedDomains'), { placeholder: 'example.com, example.org' })}
        {check('linkByEmail', t('signin.linkByEmail'))}
        <p className="text-xs text-text-secondary">{t('signin.linkByEmailHelp')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {field('groupsClaim', t('signin.groupsClaim'), { placeholder: 'groups' })}
          {field('adminGroups', t('signin.adminGroups'), { placeholder: 'claudia-admins' })}
        </div>
        <p className="text-xs text-text-secondary">{t('signin.groupsHelp')}</p>
      </div>
    </Modal>
  );
}

function Scim() {
  const { t } = useTranslation();
  const { data } = useScimQuery();
  const [newToken, tokenState] = useNewScimTokenMutation();
  const [disable] = useDisableScimMutation();
  const [token, setToken] = useState<string | null>(null);
  return (
    <Card title={t('signin.scimTitle')} help={t('signin.scimHelp')}>
      <p className="mb-2 text-sm">
        {t('signin.scimUrl')} <code className="break-all" data-testid="scim-url">{data?.baseUrl}</code>
      </p>
      <p className="mb-3 text-sm text-text-secondary">
        {data?.enabled ? t('signin.scimOn', { when: new Date(data.createdAt!).toLocaleString() }) : t('signin.scimOff')}
      </p>
      {token && (
        <div className="mb-3 rounded border border-accent/50 bg-accent/5 p-3 text-sm">
          <p className="mb-1">{t('signin.scimTokenOnce')}</p>
          <code className="break-all" data-testid="scim-token">{token}</code>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={tokenState.isLoading}
          onClick={async () => {
            const res = await newToken();
            if ('data' in res && res.data) setToken(res.data.token);
          }}
        >
          {data?.enabled ? t('signin.scimNewToken') : t('signin.scimEnable')}
        </Button>
        {data?.enabled && (
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await disable();
              setToken(null);
            }}
          >
            {t('signin.scimDisable')}
          </Button>
        )}
      </div>
    </Card>
  );
}

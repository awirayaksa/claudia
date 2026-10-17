import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Modal } from '@/components/common/Modal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import type { AdminUser, UserRole } from '@shared/auth';
import {
  errorMessage,
  useAdminCreateUserMutation,
  useAdminDeleteUserMutation,
  useAdminUpdateUserMutation,
  useAdminUsersQuery,
  useSessionQuery,
} from '../../api/rtk-api';

const ROLES: UserRole[] = ['admin', 'user', 'pending'];

export function UsersPage() {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const { data, isLoading } = useAdminUsersQuery(search.trim() ? { search: search.trim() } : undefined);
  const { data: session } = useSessionQuery();
  const [updateUser, updateState] = useAdminUpdateUserMutation();
  const [deleteUser, deleteState] = useAdminDeleteUserMutation();
  const [creating, setCreating] = useState(false);
  const [toDelete, setToDelete] = useState<AdminUser | null>(null);
  const error = errorMessage(updateState.error ?? deleteState.error);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          className="min-w-0 flex-1 rounded border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
          placeholder={t('admin.searchUsers')}
          aria-label={t('admin.searchUsers')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Button size="sm" onClick={() => setCreating(true)}>
          {t('admin.newUser')}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}

      <ul className="divide-y divide-border rounded-lg border border-border bg-surface" data-testid="users">
        {isLoading && <li className="p-4 text-sm text-text-secondary">{t('app.loading')}</li>}
        {data?.users.map((u) => {
          const self = u.id === session?.user?.id;
          return (
            <li key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid={`user-${u.email}`}>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">
                  {u.name} {self && <span className="text-xs text-text-secondary">({t('admin.you')})</span>}
                </div>
                <div className="truncate text-sm text-text-secondary">{u.email}</div>
                <div className="text-xs text-text-secondary">
                  {t('admin.lastActive')}: {u.lastActiveAt ? new Date(u.lastActiveAt).toLocaleString() : t('admin.never')}
                </div>
              </div>
              {u.role === 'pending' && (
                <Button size="sm" onClick={() => void updateUser({ id: u.id, role: 'user' })}>
                  {t('admin.approve')}
                </Button>
              )}
              <select
                aria-label={t('admin.role')}
                className="rounded border border-border bg-background px-2 py-1 text-sm"
                value={u.role}
                disabled={self}
                onChange={(e) => void updateUser({ id: u.id, role: e.target.value as UserRole })}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t(`admin.roles.${r}`)}
                  </option>
                ))}
              </select>
              {!self && (
                <Button size="sm" variant="ghost" className="text-error" onClick={() => setToDelete(u)}>
                  {t('app.delete')}
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      <CreateUserModal open={creating} onClose={() => setCreating(false)} />
      <ConfirmDialog
        isOpen={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={async () => {
          if (toDelete) await deleteUser(toDelete.id);
          setToDelete(null);
        }}
        title={t('admin.deleteUserTitle')}
        message={t('admin.deleteUserBody', { email: toDelete?.email ?? '' })}
        confirmText={t('app.delete')}
        cancelText={t('app.cancel')}
        isDestructive
      />
    </div>
  );
}

function CreateUserModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('user');
  const [create, state] = useAdminCreateUserMutation();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const res = await create({ name, email, password, role });
    if (!('error' in res)) {
      setName('');
      setEmail('');
      setPassword('');
      onClose();
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} title={t('admin.newUser')}>
      <form className="space-y-3" onSubmit={submit}>
        <Input label={t('auth.name')} value={name} onChange={(e) => setName(e.target.value)} required />
        <Input label={t('auth.email')} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <Input
          label={t('auth.password')}
          type="password"
          showPasswordToggle
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          required
        />
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t('admin.role')}</span>
          <select
            className="w-full rounded border border-border bg-background px-2 py-2"
            value={role}
            onChange={(e) => setRole(e.target.value as UserRole)}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`admin.roles.${r}`)}
              </option>
            ))}
          </select>
        </label>
        {state.error && <p className="text-sm text-error">{errorMessage(state.error)}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={state.isLoading}>
            {t('app.create')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Modal } from '@/components/common/Modal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import type { GroupCaps, GroupInput, GroupView } from '@shared/access';
import {
  errorMessage,
  useAddGroupMemberMutation,
  useAdminGroupsQuery,
  useAdminUsersQuery,
  useAppSettingsQuery,
  useCreateGroupMutation,
  useDeleteGroupMutation,
  useGroupMembersQuery,
  useModelsQuery,
  useRemoveGroupMemberMutation,
  useUpdateGroupMutation,
} from '../../api/rtk-api';
import { CapsFields, PermissionChecks } from '../../components/AccessFields';

/** Groups: what their members may do and use on top of everyone's defaults. */
export function GroupsPage() {
  const { t } = useTranslation();
  const { data, isLoading } = useAdminGroupsQuery();
  const [deleteGroup] = useDeleteGroupMutation();
  const [editing, setEditing] = useState<GroupView | 'new' | null>(null);
  const [toDelete, setToDelete] = useState<GroupView | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-text-secondary">{t('access.groupsHelp')}</p>
        <Button size="sm" onClick={() => setEditing('new')}>
          {t('access.newGroup')}
        </Button>
      </div>
      <ul className="divide-y divide-border rounded-lg border border-border bg-surface" data-testid="groups">
        {isLoading && <li className="p-4 text-sm text-text-secondary">{t('app.loading')}</li>}
        {data?.groups.length === 0 && <li className="p-4 text-sm text-text-secondary">{t('access.noGroups')}</li>}
        {data?.groups.map((g) => (
          <li key={g.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid={`group-${g.name}`}>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{g.name}</div>
              <div className="truncate text-xs text-text-secondary">
                {t('access.memberCount', { count: g.memberCount })}
                {g.ldapDn && ` · ${t('access.linkedTo', { dn: g.ldapDn })}`}
              </div>
              {g.description && <div className="truncate text-sm text-text-secondary">{g.description}</div>}
            </div>
            <Button size="sm" variant="secondary" onClick={() => setEditing(g)}>
              {t('app.edit')}
            </Button>
            <Button size="sm" variant="ghost" className="text-error" onClick={() => setToDelete(g)}>
              {t('app.delete')}
            </Button>
          </li>
        ))}
      </ul>
      {editing && <GroupModal group={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        isOpen={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={async () => {
          if (toDelete) await deleteGroup(toDelete.id);
          setToDelete(null);
        }}
        title={t('access.deleteGroupTitle')}
        message={t('access.deleteGroupBody', { name: toDelete?.name ?? '' })}
        confirmText={t('app.delete')}
        cancelText={t('app.cancel')}
        isDestructive
      />
    </div>
  );
}

function GroupModal({ group, onClose }: { group: GroupView | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: settings } = useAppSettingsQuery();
  const { data: models } = useModelsQuery();
  const [create, createState] = useCreateGroupMutation();
  const [update, updateState] = useUpdateGroupMutation();
  const [draft, setDraft] = useState<GroupInput>({
    name: group?.name ?? '',
    description: group?.description ?? '',
    permissions: group?.permissions ?? {},
    modelIds: group?.modelIds ?? [],
    caps: group?.caps ?? {},
    ldapDn: group?.ldapDn ?? null,
  });
  const allowlist = settings?.settings['models.allowlist'].user;
  const globalModels = (models?.models ?? []).filter((m) => !m.custom && !m.own);
  const error = errorMessage(createState.error ?? updateState.error);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { ...draft, ldapDn: draft.ldapDn?.trim() || null };
    const res = group ? await update({ id: group.id, ...body }) : await create(body);
    if (!('error' in res)) onClose();
  };

  return (
    <Modal isOpen onClose={onClose} title={group ? t('access.editGroup') : t('access.newGroup')} size="lg">
      <form className="space-y-5" onSubmit={submit}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label={t('access.groupName')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required />
          <Input
            label={t('access.ldapDn')}
            value={draft.ldapDn ?? ''}
            placeholder="cn=staff,ou=groups,dc=example,dc=com"
            onChange={(e) => setDraft({ ...draft, ldapDn: e.target.value })}
          />
        </div>
        <Input
          label={t('access.description')}
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />

        <section>
          <h3 className="mb-2 text-sm font-semibold">{t('access.groupPermissions')}</h3>
          <PermissionChecks
            value={draft.permissions}
            inherited={settings?.settings['permissions.default']}
            onChange={(permissions) => setDraft({ ...draft, permissions })}
          />
        </section>

        <section>
          <h3 className="mb-1 text-sm font-semibold">{t('access.groupModels')}</h3>
          {allowlist === null ? (
            <p className="text-sm text-text-secondary">{t('access.groupModelsAll')}</p>
          ) : (
            <>
              <p className="mb-2 text-xs text-text-secondary">{t('access.groupModelsHelp')}</p>
              <div className="grid max-h-48 gap-1 overflow-y-auto sm:grid-cols-2">
                {globalModels
                  .filter((m) => !allowlist?.includes(m.id))
                  .map((m) => (
                    <label key={m.id} className="flex items-center gap-2 truncate text-sm">
                      <input
                        type="checkbox"
                        checked={draft.modelIds.includes(m.id)}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            modelIds: e.target.checked ? [...draft.modelIds, m.id] : draft.modelIds.filter((x) => x !== m.id),
                          })
                        }
                      />
                      <span className="truncate" title={m.id}>
                        {m.id}
                      </span>
                    </label>
                  ))}
              </div>
            </>
          )}
        </section>

        <section>
          <h3 className="mb-1 text-sm font-semibold">{t('access.groupCaps')}</h3>
          <p className="mb-2 text-xs text-text-secondary">{t('access.groupCapsHelp')}</p>
          <CapsFields value={draft.caps} unset="omit" emptyLabel={t('access.notSet')} onChange={(caps) => setDraft({ ...draft, caps: caps as GroupCaps })} />
        </section>

        {group && <Members groupId={group.id} />}

        {error && <p className="text-sm text-error">{error}</p>}
        <div className="flex justify-end gap-2">
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

function Members({ groupId }: { groupId: string }) {
  const { t } = useTranslation();
  const { data } = useGroupMembersQuery(groupId);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const { data: found } = useAdminUsersQuery(debounced ? { search: debounced } : undefined, { skip: !debounced });
  const [add] = useAddGroupMemberMutation();
  const [remove] = useRemoveGroupMemberMutation();
  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);
  const memberIds = new Set(data?.members.map((m) => m.userId));

  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">{t('access.members')}</h3>
      <ul className="mb-2 divide-y divide-border rounded border border-border" data-testid="group-members">
        {data?.members.length === 0 && <li className="px-3 py-2 text-sm text-text-secondary">{t('access.noMembers')}</li>}
        {data?.members.map((m) => (
          <li key={m.userId} className="flex items-center gap-2 px-3 py-1.5 text-sm">
            <span className="min-w-0 flex-1 truncate">
              {m.name} <span className="text-text-secondary">{m.email}</span>
            </span>
            {m.source === 'ldap' && <span className="text-xs text-text-secondary">{t('access.fromDirectory')}</span>}
            <button
              type="button"
              className="text-xs text-error hover:underline"
              onClick={() => void remove({ id: groupId, userId: m.userId })}
            >
              {t('access.remove')}
            </button>
          </li>
        ))}
      </ul>
      <input
        className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
        placeholder={t('access.addMember')}
        aria-label={t('access.addMember')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {debounced && (
        <ul className="mt-1 max-h-40 overflow-y-auto rounded border border-border">
          {found?.users
            .filter((u) => !memberIds.has(u.id))
            .map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  className="w-full px-3 py-1.5 text-left text-sm hover:bg-background"
                  onClick={() => {
                    void add({ id: groupId, userId: u.id });
                    setSearch('');
                  }}
                >
                  {u.name} <span className="text-text-secondary">{u.email}</span>
                </button>
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}

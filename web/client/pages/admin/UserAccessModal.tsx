import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { CAP_KEYS, PERMISSION_KEYS, type UserCaps } from '@shared/access';
import type { AdminUser } from '@shared/auth';
import {
  errorMessage,
  useAdminGroupsQuery,
  useAdminSetUserGroupsMutation,
  useAdminUpdateUserMutation,
  useAdminUserAccessQuery,
} from '../../api/rtk-api';
import { CapsFields, formatUsage } from '../../components/AccessFields';

/** One user's groups, cap override, usage and what they may do. */
export function UserAccessModal({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const { t } = useTranslation();
  const { data } = useAdminUserAccessQuery(user.id);
  const { data: groups } = useAdminGroupsQuery();
  const [setGroups, groupsState] = useAdminSetUserGroupsMutation();
  const [updateUser, updateState] = useAdminUpdateUserMutation();
  const [manual, setManual] = useState<string[]>([]);
  const [override, setOverride] = useState(false);
  const [caps, setCaps] = useState<UserCaps>({});

  useEffect(() => {
    if (!data) return;
    setManual(data.groups.filter((g) => g.source === 'manual').map((g) => g.id));
    setOverride(data.caps !== null);
    setCaps(data.caps ?? {});
  }, [data]);

  const ldapGroups = new Set(data?.groups.filter((g) => g.source === 'ldap').map((g) => g.id));
  const save = async () => {
    const a = await setGroups({ id: user.id, groupIds: manual });
    if ('error' in a) return;
    const b = await updateUser({ id: user.id, caps: override ? caps : null });
    if (!('error' in b)) onClose();
  };

  return (
    <Modal isOpen onClose={onClose} title={t('access.userAccess', { name: user.name })} size="lg">
      {!data ? (
        <p className="text-sm text-text-secondary">{t('app.loading')}</p>
      ) : (
        <div className="space-y-5">
          <section>
            <h3 className="mb-2 text-sm font-semibold">{t('access.groups')}</h3>
            {groups?.groups.length === 0 && <p className="text-sm text-text-secondary">{t('access.noGroups')}</p>}
            <div className="grid gap-1 sm:grid-cols-2">
              {groups?.groups.map((g) => (
                <label key={g.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={ldapGroups.has(g.id) || manual.includes(g.id)}
                    disabled={ldapGroups.has(g.id)}
                    onChange={(e) => setManual(e.target.checked ? [...manual, g.id] : manual.filter((x) => x !== g.id))}
                  />
                  {g.name}
                  {ldapGroups.has(g.id) && <span className="text-xs text-text-secondary">({t('access.fromDirectory')})</span>}
                </label>
              ))}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold">{t('access.usage')}</h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              {CAP_KEYS.map((k) => (
                <div key={k} className="contents">
                  <dt className="text-text-secondary">{t(`access.caps.${k}`)}</dt>
                  <dd>
                    {formatUsage(
                      k,
                      k.endsWith('Day')
                        ? data.usage.day[k.startsWith('cost') ? 'cost' : 'tokens']
                        : data.usage.month[k.startsWith('cost') ? 'cost' : 'tokens'],
                      data.usage.caps[k],
                      t('access.noLimit')
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} data-testid="caps-override" />
              {t('access.overrideCaps')}
            </label>
            {override && (
              <div className="mt-2">
                <CapsFields value={caps} onChange={setCaps} emptyLabel={t('access.noLimit')} />
              </div>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold">{t('access.effectivePermissions')}</h3>
            <ul className="flex flex-wrap gap-1.5 text-xs">
              {PERMISSION_KEYS.filter((k) => data.permissions[k]).map((k) => (
                <li key={k} className="rounded-full border border-border px-2 py-0.5">
                  {t(`access.permissions.${k}`)}
                </li>
              ))}
              {PERMISSION_KEYS.every((k) => !data.permissions[k]) && <li className="text-text-secondary">{t('access.nothing')}</li>}
            </ul>
          </section>

          {(groupsState.error || updateState.error) && (
            <p className="text-sm text-error">{errorMessage(groupsState.error ?? updateState.error)}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t('app.cancel')}
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={groupsState.isLoading || updateState.isLoading}>
              {t('app.save')}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import type { GrantInput, GrantView } from '@shared/access';
import {
  errorMessage,
  useFindUsersQuery,
  useGrantsQuery,
  useMyGroupsQuery,
  usePermissions,
  useSetGrantsMutation,
} from '../api/rtk-api';

type Row = GrantView;

const toInput = (r: Row): GrantInput =>
  r.principalType === 'public'
    ? { principalType: 'public', perm: 'read' }
    : { principalType: r.principalType, principalId: r.principalId!, perm: r.perm };

/** Who else may use (or edit) a custom model or prompt. Private until shared. */
export function AccessDialog({ kind, id, name, onClose }: { kind: 'models' | 'prompts'; id: string; name: string; onClose: () => void }) {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const { data } = useGrantsQuery({ kind, id });
  const { data: groups } = useMyGroupsQuery();
  const [save, saveState] = useSetGrantsMutation();
  const [rows, setRows] = useState<Row[]>([]);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const { data: people } = useFindUsersQuery(debounced, { skip: debounced.length < 2 });

  useEffect(() => {
    if (data) setRows(data.grants);
  }, [data]);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const isPublic = rows.some((r) => r.principalType === 'public');
  const has = (type: 'group' | 'user', pid: string) => rows.some((r) => r.principalType === type && r.principalId === pid);
  const add = (row: Row) => setRows((list) => [...list, row]);
  const setPerm = (i: number, perm: 'read' | 'write') => setRows((list) => list.map((r, j) => (j === i ? { ...r, perm } : r)));
  const remove = (i: number) => setRows((list) => list.filter((_, j) => j !== i));

  const submit = async () => {
    const res = await save({ kind, id, grants: rows.map(toInput) });
    if (!('error' in res)) onClose();
  };

  return (
    <Modal isOpen onClose={onClose} title={t('access.shareTitle', { name })}>
      <div className="space-y-4" data-testid="access-dialog">
        <p className="text-sm text-text-secondary">{t('access.shareHelp')}</p>

        {permissions?.['workspace.share_public'] && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(e) =>
                e.target.checked
                  ? add({ principalType: 'public', principalId: null, perm: 'read', label: t('access.everyone') })
                  : setRows((list) => list.filter((r) => r.principalType !== 'public'))
              }
              data-testid="share-public"
            />
            {t('access.everyoneCanUse')}
          </label>
        )}

        <ul className="divide-y divide-border rounded border border-border" data-testid="grants">
          {rows.filter((r) => r.principalType !== 'public').length === 0 && (
            <li className="px-3 py-2 text-sm text-text-secondary">{t('access.onlyYou')}</li>
          )}
          {rows.map((r, i) =>
            r.principalType === 'public' ? null : (
              <li key={`${r.principalType}:${r.principalId}`} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  <span className="mr-1 text-xs text-text-secondary">{t(`access.principal.${r.principalType}`)}</span>
                  {r.label}
                </span>
                <select
                  className="rounded border border-border bg-background px-1.5 py-0.5 text-xs"
                  aria-label={t('access.permFor', { name: r.label })}
                  value={r.perm}
                  onChange={(e) => setPerm(i, e.target.value as 'read' | 'write')}
                >
                  <option value="read">{t('access.canUse')}</option>
                  <option value="write">{t('access.canEdit')}</option>
                </select>
                <button type="button" className="text-xs text-error hover:underline" onClick={() => remove(i)}>
                  {t('access.remove')}
                </button>
              </li>
            )
          )}
        </ul>

        <div className="grid gap-2 sm:grid-cols-2">
          <select
            className="rounded border border-border bg-background px-2 py-1 text-sm"
            aria-label={t('access.addGroup')}
            value=""
            onChange={(e) => {
              const g = groups?.groups.find((x) => x.id === e.target.value);
              if (g) add({ principalType: 'group', principalId: g.id, perm: 'read', label: g.name });
            }}
            data-testid="add-group"
          >
            <option value="">{t('access.addGroup')}</option>
            {groups?.groups
              .filter((g) => !has('group', g.id))
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
          </select>
          <div className="relative">
            <input
              className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
              placeholder={t('access.addPerson')}
              aria-label={t('access.addPerson')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {debounced.length >= 2 && (people?.users.length ?? 0) > 0 && (
              <ul className="absolute z-10 mt-1 max-h-40 w-full overflow-y-auto rounded border border-border bg-surface shadow">
                {people!.users
                  .filter((u) => !has('user', u.id))
                  .map((u) => (
                    <li key={u.id}>
                      <button
                        type="button"
                        className="w-full px-3 py-1.5 text-left text-sm hover:bg-background"
                        onClick={() => {
                          add({ principalType: 'user', principalId: u.id, perm: 'read', label: `${u.name} (${u.email})` });
                          setSearch('');
                        }}
                      >
                        {u.name} <span className="text-text-secondary">{u.email}</span>
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </div>

        {saveState.error && <p className="text-sm text-error">{errorMessage(saveState.error)}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={saveState.isLoading}>
            {t('app.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

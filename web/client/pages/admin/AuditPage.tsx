import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { AUDIT_ACTIONS, type AuditEntry } from '@shared/admin';
import { errorMessage, useAuditLogQuery } from '../../api/rtk-api';

const PAGE = 100;

/** Admin: who did what, newest first, with filters, paging and CSV export. */
export function AuditPage() {
  const { t } = useTranslation();
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [actorQuery, setActorQuery] = useState('');
  const [before, setBefore] = useState<string | undefined>(undefined);
  const [older, setOlder] = useState<AuditEntry[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  // Type, then search (not on every key)
  useEffect(() => {
    const id = setTimeout(() => setActorQuery(actor.trim()), 300);
    return () => clearTimeout(id);
  }, [actor]);
  // New filters start from the newest entries again
  useEffect(() => {
    setBefore(undefined);
    setOlder([]);
  }, [action, actorQuery]);

  const filters = { action: action || undefined, actor: actorQuery || undefined, limit: PAGE };
  const { data, error, isFetching } = useAuditLogQuery({ ...filters, before });
  const entries = before ? [...older, ...(data?.entries ?? [])] : (data?.entries ?? []);
  const exportUrl = `/api/admin/audit/export.csv?${new URLSearchParams(
    Object.entries({ action, actor: actorQuery }).filter(([, v]) => v)
  )}`;

  const loadMore = () => {
    if (!data?.next) return;
    setOlder(entries);
    setBefore(data.next);
  };

  return (
    <div className="space-y-3" data-testid="audit">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-text-secondary">{t('audit.action')}</span>
          <select className="rounded border border-border bg-background px-2 py-1" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">{t('audit.allActions')}</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {t(`audit.actions.${a.replace('.', '_')}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-text-secondary">{t('audit.actor')}</span>
          <input
            className="rounded border border-border bg-background px-2 py-1"
            placeholder={t('audit.actorPlaceholder')}
            value={actor}
            onChange={(e) => setActor(e.target.value)}
          />
        </label>
        <a className="ml-auto text-sm text-accent underline" href={exportUrl} download>
          {t('analytics.exportCsv')}
        </a>
      </div>

      {error && <p className="text-sm text-error">{errorMessage(error)}</p>}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead className="bg-surface text-xs text-text-secondary">
            <tr>
              <th className="px-3 py-2 font-normal">{t('audit.time')}</th>
              <th className="px-3 py-2 font-normal">{t('audit.actor')}</th>
              <th className="px-3 py-2 font-normal">{t('audit.action')}</th>
              <th className="px-3 py-2 font-normal">{t('audit.ip')}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <AuditRow key={e.id} entry={e} open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} />
            ))}
            {entries.length === 0 && !isFetching && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-text-secondary">
                  {t('audit.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {data?.next && (
        <Button variant="secondary" onClick={loadMore} disabled={isFetching}>
          {t('audit.older')}
        </Button>
      )}
    </div>
  );
}

function AuditRow({ entry, open, onToggle }: { entry: AuditEntry; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const label = entry.route ?? t(`audit.actions.${entry.action.replace('.', '_')}`, { defaultValue: entry.action });
  const failed = entry.action === 'auth.login_failed';
  return (
    <>
      <tr className="cursor-pointer border-t border-border hover:bg-surface" onClick={onToggle} aria-expanded={open}>
        <td className="whitespace-nowrap px-3 py-2 tabular-nums text-text-secondary">{new Date(entry.createdAt).toLocaleString()}</td>
        <td className="max-w-[14rem] truncate px-3 py-2">{entry.actorEmail ?? <span className="text-text-secondary">{t('audit.anonymous')}</span>}</td>
        <td className={`px-3 py-2 ${failed ? 'text-error' : ''}`}>
          <span className={entry.route ? 'font-mono text-xs' : ''}>{label}</span>
          {entry.targetId && <span className="ml-2 font-mono text-xs text-text-secondary">{entry.targetId}</span>}
        </td>
        <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-text-secondary">{entry.ip}</td>
      </tr>
      {open && (
        <tr className="border-t border-border bg-surface">
          <td colSpan={4} className="px-3 py-2">
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{JSON.stringify(entry.details, null, 2)}</pre>
          </td>
        </tr>
      )}
    </>
  );
}

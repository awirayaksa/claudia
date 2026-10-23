/**
 * A knowledge base's GitHub repositories: added with the folders and files
 * to take, synced in the background, synced again on request.
 */
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import type { KnowledgeDetail } from '@shared/knowledge';
import {
  errorMessage,
  useAddKnowledgeSourceMutation,
  useKnowledgeQuery,
  useRemoveKnowledgeSourceMutation,
  useSyncKnowledgeSourceMutation,
} from '../../api/rtk-api';

const field = 'w-full rounded border border-border bg-background px-2 py-1.5 text-sm';

export function KnowledgeSources({ kb }: { kb: KnowledgeDetail }) {
  const { t } = useTranslation();
  const busy = kb.sources.some((s) => s.status === 'queued' || s.status === 'syncing');
  // While a sync runs, look again every few seconds
  useKnowledgeQuery(kb.id, { pollingInterval: busy ? 3000 : 0 });
  const [sync] = useSyncKnowledgeSourceMutation();
  const [remove] = useRemoveKnowledgeSourceMutation();
  const [adding, setAdding] = useState(false);
  if (kb.sources.length === 0 && !kb.access.write) return null;

  return (
    <section data-testid="knowledge-sources">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t('knowledge.sources')}</h3>
        {kb.access.write && !adding && (
          <button className="text-xs text-accent hover:underline" onClick={() => setAdding(true)}>
            {t('knowledge.addGitHub')}
          </button>
        )}
      </div>
      {adding && <AddGitHub kbId={kb.id} onDone={() => setAdding(false)} />}
      {kb.sources.length === 0 && !adding && <p className="text-xs text-text-secondary">{t('knowledge.sourcesHelp')}</p>}
      {kb.sources.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
          {kb.sources.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm" data-testid={`kb-source-${s.repo}`}>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">
                  {s.repo}
                  {s.ref ? <span className="text-text-secondary">@{s.ref}</span> : null}
                  {s.hasToken && <span className="ms-2 text-xs font-normal text-text-secondary">· {t('knowledge.private')}</span>}
                </div>
                <div className="truncate text-xs text-text-secondary">
                  {s.paths.length ? s.paths.join(', ') : t('knowledge.wholeRepo')}
                  {' · '}
                  {t('knowledge.sourceFiles', { count: s.fileCount })}
                  {s.commit && ` · ${s.commit.slice(0, 7)}`}
                  {s.lastSyncedAt && ` · ${t('knowledge.syncedAt', { when: new Date(s.lastSyncedAt).toLocaleString() })}`}
                </div>
                {s.error && <div className="text-xs text-error">{s.error}</div>}
              </div>
              <span className="text-xs text-text-secondary" data-testid="kb-source-status">
                {t(`knowledge.sourceStatus.${s.status}`)}
              </span>
              {kb.access.write && (
                <>
                  <Button size="sm" variant="secondary" disabled={s.status === 'queued' || s.status === 'syncing'} onClick={() => void sync({ id: kb.id, sourceId: s.id })}>
                    {t('knowledge.syncNow')}
                  </Button>
                  <Button size="sm" variant="ghost" className="text-error" onClick={() => void remove({ id: kb.id, sourceId: s.id })}>
                    {t('app.delete')}
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AddGitHub({ kbId, onDone }: { kbId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const [add, state] = useAddKnowledgeSourceMutation();
  const [repo, setRepo] = useState('');
  const [ref, setRef] = useState('');
  const [paths, setPaths] = useState('');
  const [token, setToken] = useState('');
  const [apiUrl, setApiUrl] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const res = await add({
      id: kbId,
      kind: 'github',
      repo: repo.trim(),
      ...(ref.trim() ? { ref: ref.trim() } : {}),
      paths: paths
        .split('\n')
        .map((p) => p.trim())
        .filter(Boolean),
      ...(token.trim() ? { token: token.trim() } : {}),
      ...(apiUrl.trim() ? { apiUrl: apiUrl.trim() } : {}),
    });
    if (!('error' in res)) onDone();
  };

  return (
    <form className="mb-3 space-y-2 rounded-lg border border-border p-3" onSubmit={submit} data-testid="add-github">
      <div className="grid gap-2 sm:grid-cols-3">
        <input
          className={`${field} sm:col-span-2`}
          placeholder="owner/repository"
          aria-label={t('knowledge.repo')}
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          required
        />
        <input className={field} placeholder={t('knowledge.refPlaceholder')} aria-label={t('knowledge.ref')} value={ref} onChange={(e) => setRef(e.target.value)} />
      </div>
      <textarea
        className={`${field} font-mono text-xs`}
        rows={3}
        placeholder={'docs/\nREADME.md'}
        aria-label={t('knowledge.paths')}
        value={paths}
        onChange={(e) => setPaths(e.target.value)}
      />
      <p className="text-xs text-text-secondary">{t('knowledge.pathsHelp')}</p>
      <details>
        <summary className="cursor-pointer text-xs text-text-secondary">{t('knowledge.privateRepo')}</summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <input
            className={field}
            type="password"
            autoComplete="off"
            placeholder={t('knowledge.token')}
            aria-label={t('knowledge.token')}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <input className={field} placeholder="https://github.example.com/api/v3" aria-label={t('knowledge.apiUrl')} value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} />
        </div>
        <p className="mt-1 text-xs text-text-secondary">{t('knowledge.tokenHelp')}</p>
      </details>
      {state.error && <p className="text-sm text-error">{errorMessage(state.error)}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={onDone}>
          {t('app.cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={!repo.trim() || state.isLoading}>
          {t('knowledge.addAndSync')}
        </Button>
      </div>
    </form>
  );
}

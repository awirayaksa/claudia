import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Modal } from '@/components/common/Modal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import type { KbFileEvent, KnowledgeDetail, SearchHit } from '@shared/knowledge';
import { KnowledgeSources } from './KnowledgeSources';
import {
  api,
  errorMessage,
  useAddKnowledgeFileMutation,
  useCreateKnowledgeMutation,
  useDeleteKnowledgeMutation,
  useKnowledgeListQuery,
  useKnowledgeQuery,
  usePermissions,
  useReindexKnowledgeMutation,
  useRemoveKnowledgeFileMutation,
  useSearchKnowledgeMutation,
  useUpdateKnowledgeMutation,
} from '../../api/rtk-api';
import { apiFetchRaw, toApiError } from '../../api/http';
import { useTopic } from '../../api/ws';
import { useWebDispatch } from '../../hooks';
import { AccessDialog } from '../../workspace/AccessDialog';

/** Knowledge bases: documents chats can search and cite. */
export function KnowledgePage() {
  const { id } = useParams();
  return id ? <KnowledgeDetailView id={id} /> : <KnowledgeList />;
}

function KnowledgeList() {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const navigate = useNavigate();
  const { data, isLoading } = useKnowledgeListQuery();
  const [create, createState] = useCreateKnowledgeMutation();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const res = await create({ name: name.trim(), description });
    if (!('error' in res)) navigate(`/workspace/knowledge/${res.data.knowledge.id}`);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-text-secondary">{t('knowledge.help')}</p>
        {permissions?.['workspace.knowledge'] && (
          <Button size="sm" onClick={() => setCreating(true)}>
            {t('knowledge.new')}
          </Button>
        )}
      </div>
      <ul className="grid gap-3 sm:grid-cols-2" data-testid="knowledge-list">
        {isLoading && <li className="text-sm text-text-secondary">{t('app.loading')}</li>}
        {data?.knowledge.length === 0 && <li className="text-sm text-text-secondary">{t('knowledge.none')}</li>}
        {data?.knowledge.map((k) => (
          <li key={k.id}>
            <Link
              to={`/workspace/knowledge/${k.id}`}
              className="block rounded-lg border border-border bg-surface p-4 hover:border-accent"
              data-testid={`knowledge-${k.name}`}
            >
              <div className="truncate font-medium">{k.name}</div>
              <div className="truncate text-xs text-text-secondary">
                {t('knowledge.fileCount', { count: k.fileCount })}
                {!k.access.manage && ` · ${t('workspace.by', { name: k.ownerName })}`}
              </div>
              {k.description && <p className="mt-2 line-clamp-2 text-sm text-text-secondary">{k.description}</p>}
            </Link>
          </li>
        ))}
      </ul>
      <Modal isOpen={creating} onClose={() => setCreating(false)} title={t('knowledge.new')}>
        <form className="space-y-3" onSubmit={submit}>
          <Input label={t('workspace.name')} value={name} onChange={(e) => setName(e.target.value)} required />
          <Input label={t('workspace.description')} value={description} onChange={(e) => setDescription(e.target.value)} />
          {createState.error && <p className="text-sm text-error">{errorMessage(createState.error)}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setCreating(false)}>
              {t('app.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!name.trim() || createState.isLoading}>
              {t('app.create')}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  queued: 'text-text-secondary',
  processing: 'text-accent',
  ready: 'text-success',
  failed: 'text-error',
};

function KnowledgeDetailView({ id }: { id: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const dispatch = useWebDispatch();
  const { data, error } = useKnowledgeQuery(id);
  const [addFile] = useAddKnowledgeFileMutation();
  const [removeFile] = useRemoveKnowledgeFileMutation();
  const [remove] = useDeleteKnowledgeMutation();
  const [reindex] = useReindexKnowledgeMutation();
  const [uploading, setUploading] = useState<string[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [sharing, setSharing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Live status from the processing jobs
  useTopic(`kb:${id}`, (e: KbFileEvent) => {
    if (e.type !== 'kb.file') return;
    setProgress((p) => ({ ...p, [e.fileId]: e.progress }));
    dispatch(
      api.util.updateQueryData('knowledge', id, (draft) => {
        const f = draft.knowledge.files.find((x) => x.fileId === e.fileId);
        if (f) {
          f.status = e.status;
          f.error = e.error;
          if (e.status === 'ready') f.chunks = e.chunks;
        }
      })
    );
    if (e.status === 'ready') dispatch(api.util.invalidateTags([{ type: 'Knowledge', id }]));
  });

  if (error) return <p className="text-sm text-text-secondary">{t('knowledge.notFound')}</p>;
  if (!data) return <p className="text-sm text-text-secondary">{t('app.loading')}</p>;
  const kb = data.knowledge;

  const upload = async (files: FileList | File[]) => {
    setUploadError(null);
    for (const file of Array.from(files)) {
      setUploading((u) => [...u, file.name]);
      try {
        const form = new FormData();
        form.append('file', file, file.name);
        const res = await apiFetchRaw('/api/files', { method: 'POST', body: form });
        if (!res.ok) throw await toApiError(res);
        const { file: stored } = await res.json();
        const added = await addFile({ id, fileId: stored.id });
        if ('error' in added) throw added.error;
      } catch (err) {
        setUploadError(`${file.name}: ${errorMessage(err)}`);
      } finally {
        setUploading((u) => u.filter((n) => n !== file.name));
      }
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <Link to="/workspace/knowledge" className="text-xs text-text-secondary hover:text-accent">
            ← {t('workspace.knowledge')}
          </Link>
          <h2 className="truncate text-lg font-semibold" data-testid="knowledge-name">
            {kb.name}
          </h2>
          {kb.description && <p className="text-sm text-text-secondary">{kb.description}</p>}
          <p className="mt-1 text-xs text-text-secondary">
            {kb.embedModel ? t('knowledge.searchHybrid', { model: kb.embedModel }) : t('knowledge.searchKeyword')}
            {kb.fullContext && ` · ${t('knowledge.fullContextOn')}`}
          </p>
        </div>
        {kb.access.write && (
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
            {t('app.edit')}
          </Button>
        )}
        {kb.access.manage && (
          <>
            <Button size="sm" variant="secondary" onClick={() => setSharing(true)}>
              {t('access.share')}
            </Button>
            <Button size="sm" variant="ghost" className="text-error" onClick={() => setConfirm(true)}>
              {t('app.delete')}
            </Button>
          </>
        )}
      </div>

      {kb.access.write && (
        <div
          className={`rounded-lg border-2 border-dashed p-5 text-center text-sm ${dragging ? 'border-accent bg-accent/5' : 'border-border'}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void upload(e.dataTransfer.files);
          }}
        >
          <p className="mb-2 text-text-secondary">{t('knowledge.dropHelp')}</p>
          <Button size="sm" onClick={() => fileInput.current?.click()} disabled={uploading.length > 0}>
            {uploading.length > 0 ? t('knowledge.uploading', { name: uploading[0] }) : t('knowledge.addFiles')}
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            data-testid="knowledge-upload"
            onChange={(e) => {
              if (e.target.files) void upload(e.target.files);
              e.target.value = '';
            }}
          />
          {uploadError && <p className="mt-2 text-error">{uploadError}</p>}
        </div>
      )}

      <KnowledgeSources kb={kb} />

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t('knowledge.files', { count: kb.files.length })}</h3>
          {kb.access.write && kb.files.length > 0 && (
            <button className="text-xs text-text-secondary hover:text-accent" onClick={() => void reindex(id)}>
              {t('knowledge.reindex')}
            </button>
          )}
        </div>
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface" data-testid="knowledge-files">
          {kb.files.length === 0 && <li className="p-4 text-sm text-text-secondary">{t('knowledge.noFiles')}</li>}
          {kb.files.map((f) => (
            <li key={f.fileId} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm" data-testid={`kb-file-${f.name}`}>
              <div className="min-w-0 flex-1">
                <div className="truncate">{f.name}</div>
                {f.error && <div className="truncate text-xs text-error">{f.error}</div>}
              </div>
              <span className={`text-xs ${STATUS_STYLE[f.status]}`} data-testid="kb-file-status">
                {f.status === 'processing' && progress[f.fileId]
                  ? t('knowledge.status.embedding', { percent: Math.round(progress[f.fileId] * 100) })
                  : f.status === 'ready'
                    ? t('knowledge.status.ready', { count: f.chunks })
                    : t(`knowledge.status.${f.status}`)}
              </span>
              {kb.access.write && (
                <button className="text-xs text-text-secondary hover:text-error" onClick={() => void removeFile({ id, fileId: f.fileId })}>
                  {t('access.remove')}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <TryQuery id={id} />

      {editing && <EditKnowledge kb={kb} onClose={() => setEditing(false)} />}
      {sharing && <AccessDialog kind="knowledge" id={kb.id} name={kb.name} onClose={() => setSharing(false)} />}
      <ConfirmDialog
        isOpen={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          setConfirm(false);
          await remove(kb.id);
          navigate('/workspace/knowledge');
        }}
        title={t('knowledge.deleteTitle')}
        message={t('knowledge.deleteBody', { name: kb.name })}
        confirmText={t('app.delete')}
        cancelText={t('app.cancel')}
        isDestructive
      />
    </div>
  );
}

/** What a chat would get from this knowledge base for a question. */
function TryQuery({ id }: { id: string }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [search, state] = useSearchKnowledgeMutation();
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">{t('knowledge.tryQuery')}</h3>
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const res = await search({ id, query: query.trim() });
          if (!('error' in res)) setHits(res.data.hits);
        }}
      >
        <input
          className="min-w-0 flex-1 rounded border border-border bg-background px-3 py-2 text-sm"
          placeholder={t('knowledge.tryPlaceholder')}
          aria-label={t('knowledge.tryQuery')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button type="submit" size="sm" disabled={!query.trim() || state.isLoading}>
          {t('knowledge.search')}
        </Button>
      </form>
      {hits && (
        <ol className="mt-3 space-y-2" data-testid="knowledge-hits">
          {hits.length === 0 && <li className="text-sm text-text-secondary">{t('knowledge.noHits')}</li>}
          {hits.map((h, i) => (
            <li key={h.chunkId} className="rounded border border-border bg-surface p-3 text-sm">
              <div className="mb-1 text-xs text-text-secondary">
                {i + 1}. {h.title}
                {h.page ? ` · p. ${h.page}` : ''}
                {h.heading ? ` · ${h.heading}` : ''}
              </div>
              <p className="line-clamp-4 whitespace-pre-wrap">{h.text.replace(/^#{1,6}\s+.*\n+/gm, '')}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function EditKnowledge({ kb, onClose }: { kb: KnowledgeDetail; onClose: () => void }) {
  const { t } = useTranslation();
  const [update, state] = useUpdateKnowledgeMutation();
  const [name, setName] = useState(kb.name);
  const [description, setDescription] = useState(kb.description);
  const [chunkSize, setChunkSize] = useState(kb.chunkSize?.toString() ?? '');
  const [chunkOverlap, setChunkOverlap] = useState(kb.chunkOverlap?.toString() ?? '');
  const [fullContext, setFullContext] = useState(kb.fullContext);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const res = await update({
      id: kb.id,
      name: name.trim(),
      description,
      chunkSize: chunkSize ? Number(chunkSize) : null,
      chunkOverlap: chunkOverlap ? Number(chunkOverlap) : null,
      fullContext,
    });
    if (!('error' in res)) onClose();
  };

  return (
    <Modal isOpen onClose={onClose} title={t('knowledge.edit')}>
      <form className="space-y-3" onSubmit={submit}>
        <Input label={t('workspace.name')} value={name} onChange={(e) => setName(e.target.value)} required />
        <Input label={t('workspace.description')} value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label={t('knowledge.chunkSize')}
            type="number"
            min={100}
            max={8000}
            placeholder={t('workspace.default')}
            value={chunkSize}
            onChange={(e) => setChunkSize(e.target.value)}
          />
          <Input
            label={t('knowledge.chunkOverlap')}
            type="number"
            min={0}
            max={2000}
            placeholder={t('workspace.default')}
            value={chunkOverlap}
            onChange={(e) => setChunkOverlap(e.target.value)}
          />
        </div>
        <p className="text-xs text-text-secondary">{t('knowledge.chunkHelp')}</p>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={fullContext} onChange={(e) => setFullContext(e.target.checked)} />
          <span>
            {t('knowledge.fullContext')}
            <span className="block text-xs text-text-secondary">{t('knowledge.fullContextHelp')}</span>
          </span>
        </label>
        {state.error && <p className="text-sm text-error">{errorMessage(state.error)}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={!name.trim() || state.isLoading}>
            {t('app.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

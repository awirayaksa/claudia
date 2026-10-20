import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import type { NoteDetail } from '@shared/notes';
import { errorMessage, useCreateNoteMutation, useDeleteNoteMutation, useNoteQuery, useNotesQuery, useUpdateNoteMutation } from '../api/rtk-api';
import { AccessDialog } from '../workspace/AccessDialog';

const SAVE_DELAY_MS = 800;

/** Notes: a list, and the open note (edited in place, saved as you type). */
export function NotesPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const handle = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(handle);
  }, [search]);
  const { data, error } = useNotesQuery(query || undefined);
  const [create] = useCreateNoteMutation();

  const newNote = async () => {
    const res = await create({ title: '', content: '' });
    if ('data' in res && res.data) navigate(`/notes/${res.data.note.id}`);
  };

  return (
    <div className="flex h-full min-h-0" data-testid="notes">
      <aside className={`w-full shrink-0 flex-col border-e border-border md:flex md:w-72 ${id ? 'hidden' : 'flex'}`}>
        <div className="flex items-center gap-2 border-b border-border p-3">
          <h1 className="flex-1 font-semibold">{t('notes.title')}</h1>
          <Button size="sm" onClick={() => void newNote()}>
            {t('notes.new')}
          </Button>
        </div>
        <div className="p-3">
          <input
            className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
            placeholder={t('notes.search')}
            aria-label={t('notes.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {error && <p className="px-3 text-sm text-error">{errorMessage(error)}</p>}
        <ul className="min-h-0 flex-1 overflow-y-auto" aria-label={t('notes.title')}>
          {data?.notes.length === 0 && <li className="px-3 py-2 text-sm text-text-secondary">{t('notes.none')}</li>}
          {data?.notes.map((n) => (
            <li key={n.id}>
              <button
                className={`block w-full px-3 py-2 text-start hover:bg-surface ${n.id === id ? 'bg-surface' : ''}`}
                onClick={() => navigate(`/notes/${n.id}`)}
              >
                <div className="flex items-center gap-1 truncate text-sm font-medium">
                  {n.pinned && <span aria-label={t('notes.pinned')}>📌</span>}
                  {n.title || t('notes.untitled')}
                </div>
                <div className="truncate text-xs text-text-secondary">{n.snippet || '—'}</div>
                {!n.mine && <div className="text-xs text-accent">{t('notes.sharedBy', { name: n.ownerName })}</div>}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className={`min-w-0 flex-1 ${id ? 'flex' : 'hidden md:flex'} flex-col`}>
        {id ? <NoteEditor key={id} id={id} onBack={() => navigate('/notes')} /> : <p className="m-auto text-sm text-text-secondary">{t('notes.pick')}</p>}
      </section>
    </div>
  );
}

function NoteEditor({ id, onBack }: { id: string; onBack: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data, error } = useNoteQuery(id);
  const [update, updateState] = useUpdateNoteMutation();
  const [remove] = useDeleteNoteMutation();
  const [draft, setDraft] = useState<Pick<NoteDetail, 'title' | 'content'> | null>(null);
  const [preview, setPreview] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const note = data?.note;

  useEffect(() => {
    if (note && !draft) setDraft({ title: note.title, content: note.content });
  }, [note, draft]);
  // Save what is pending when leaving the note
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  if (error) return <p className="m-auto text-sm text-error">{errorMessage(error)}</p>;
  if (!note || !draft) return <p className="m-auto text-sm text-text-secondary">{t('app.loading')}</p>;
  const readOnly = !note.canEdit;

  const change = (patch: Partial<typeof draft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void update({ id, ...patch }), SAVE_DELAY_MS);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <button className="text-sm text-accent md:hidden" onClick={onBack}>
          ← {t('notes.title')}
        </button>
        <span className="text-xs text-text-secondary" role="status">
          {readOnly ? t('notes.readOnly') : updateState.isLoading ? t('notes.saving') : updateState.isSuccess ? t('notes.saved') : ''}
        </span>
        <div className="ms-auto flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" aria-pressed={preview} onClick={() => setPreview((p) => !p)}>
            {preview ? t('notes.edit') : t('notes.preview')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => navigate(`/?note=${note.id}&title=${encodeURIComponent(draft.title || t('notes.untitled'))}`)}>
            {t('notes.askInChat')}
          </Button>
          {!readOnly && (
            <Button size="sm" variant="ghost" onClick={() => void update({ id, pinned: !note.pinned })}>
              {note.pinned ? t('notes.unpin') : t('notes.pin')}
            </Button>
          )}
          {note.canManage && (
            <>
              <Button size="sm" variant="ghost" onClick={() => setSharing(true)}>
                {t('access.share')}
              </Button>
              <Button size="sm" variant="ghost" className="text-error" onClick={() => setDeleting(true)}>
                {t('app.delete')}
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <input
          className="mb-3 w-full bg-transparent text-2xl font-semibold outline-none"
          placeholder={t('notes.untitled')}
          aria-label={t('notes.noteTitle')}
          value={draft.title}
          readOnly={readOnly}
          onChange={(e) => change({ title: e.target.value })}
        />
        {preview || readOnly ? (
          <div className="text-[14px] leading-[1.7]" data-testid="note-preview">
            <MarkdownRenderer content={draft.content || `*${t('notes.empty')}*`} isUser={false} />
          </div>
        ) : (
          <textarea
            className="min-h-[60vh] w-full resize-none bg-transparent font-mono text-sm leading-relaxed outline-none"
            placeholder={t('notes.placeholder')}
            aria-label={t('notes.content')}
            value={draft.content}
            onChange={(e) => change({ content: e.target.value })}
          />
        )}
      </div>
      {sharing && <AccessDialog kind="notes" id={note.id} name={note.title || t('notes.untitled')} onClose={() => setSharing(false)} />}
      <ConfirmDialog
        isOpen={deleting}
        onClose={() => setDeleting(false)}
        onConfirm={async () => {
          await remove(note.id);
          setDeleting(false);
          navigate('/notes');
        }}
        title={t('notes.deleteTitle')}
        message={t('notes.deleteBody', { title: note.title || t('notes.untitled') })}
        confirmText={t('app.delete')}
        isDestructive
      />
    </div>
  );
}

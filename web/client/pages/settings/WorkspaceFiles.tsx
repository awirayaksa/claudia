import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { workspaceFileUrl, type WorkspaceEntry } from '@shared/workspace-files';
import { apiFetchRaw, toApiError } from '../../api/http';
import { api, errorMessage, useCreateWorkspaceFolderMutation, useDeleteWorkspaceEntryMutation, useWorkspaceFilesQuery } from '../../api/rtk-api';
import { useWebDispatch } from '../../hooks';
import { FolderIcon } from '../../components/icons';
import { formatSize } from './FilesSettings';

/** The workspace the built-in Files, Word and Diagrams tools work in: browse, download, upload, add folders, delete. */
export function WorkspaceFiles() {
  const { t } = useTranslation();
  const dispatch = useWebDispatch();
  const [dir, setDir] = useState('');
  const { data, error, isFetching } = useWorkspaceFilesQuery(dir, { refetchOnMountOrArgChange: true });
  const [createFolder] = useCreateWorkspaceFolderMutation();
  const [remove, removeState] = useDeleteWorkspaceEntryMutation();
  const [folderName, setFolderName] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<WorkspaceEntry | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const crumbs = dir ? dir.split('/') : [];

  const addFolder = async (e: FormEvent) => {
    e.preventDefault();
    if (!folderName?.trim()) return;
    setProblem(null);
    const res = await createFolder({ parent: dir, name: folderName.trim() });
    if ('error' in res) setProblem(errorMessage(res.error));
    else setFolderName(null);
  };

  const upload = async (files: FileList) => {
    setProblem(null);
    for (const file of Array.from(files)) {
      setUploading(file.name);
      try {
        const form = new FormData();
        form.append('file', file, file.name);
        const res = await apiFetchRaw(`/api/workspace-files/upload?path=${encodeURIComponent(dir)}`, { method: 'POST', body: form });
        if (!res.ok) throw await toApiError(res);
      } catch (err) {
        setProblem(`${file.name}: ${errorMessage(err)}`);
      }
    }
    setUploading(null);
    dispatch(api.util.invalidateTags(['WorkspaceFiles']));
  };

  return (
    <div className="space-y-3" data-testid="workspace-files">
      <div>
        <h3 className="font-medium">{t('workspaceFiles.title')}</h3>
        <p className="mt-1 text-sm text-text-secondary">{t('workspaceFiles.help')}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm" aria-label={t('workspaceFiles.title')}>
          <button className="hover:underline" onClick={() => setDir('')}>
            {t('workspaceFiles.top')}
          </button>
          {crumbs.map((name, i) => (
            <span key={i} className="flex items-center gap-1">
              <span className="text-text-secondary">/</span>
              <button className="hover:underline" onClick={() => setDir(crumbs.slice(0, i + 1).join('/'))}>
                {name}
              </button>
            </span>
          ))}
        </nav>
        <Button size="sm" variant="secondary" onClick={() => setFolderName('')}>
          {t('workspaceFiles.newFolder')}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => fileInput.current?.click()} disabled={uploading !== null}>
          {t('workspaceFiles.upload')}
        </Button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          data-testid="workspace-upload"
          onChange={(e) => {
            if (e.target.files?.length) void upload(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {folderName !== null && (
        <form className="flex gap-2" onSubmit={addFolder}>
          <input
            autoFocus
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-sm"
            placeholder={t('workspaceFiles.folderName')}
            aria-label={t('workspaceFiles.folderName')}
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
          />
          <Button size="sm" type="submit" disabled={!folderName.trim()}>
            {t('app.create')}
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setFolderName(null)}>
            {t('app.cancel')}
          </Button>
        </form>
      )}

      {uploading && <p className="text-sm text-text-secondary">{t('workspaceFiles.uploading', { name: uploading })}</p>}
      {problem && <p className="text-sm text-error">{problem}</p>}
      {error && <p className="text-sm text-error">{errorMessage(error)}</p>}

      {data && data.entries.length === 0 && !isFetching && <p className="text-sm text-text-secondary">{t('workspaceFiles.empty')}</p>}
      {data && data.entries.length > 0 && (
        <ul className="divide-y divide-border rounded border border-border">
          {data.entries.map((entry) => (
            <li key={entry.path} className="flex items-center gap-3 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                {entry.type === 'directory' ? (
                  <button className="flex max-w-full items-center gap-1.5 hover:underline" onClick={() => setDir(entry.path)}>
                    <FolderIcon />
                    <span className="truncate">{entry.name}</span>
                  </button>
                ) : (
                  <a className="block truncate hover:underline" href={workspaceFileUrl(entry.path)} download={entry.name}>
                    {entry.name}
                  </a>
                )}
                <div className="text-xs text-text-secondary">
                  {entry.size !== undefined && `${formatSize(entry.size)} · `}
                  {new Date(entry.modifiedAt).toLocaleString()}
                </div>
              </div>
              <Button size="sm" variant="ghost" className="text-error" onClick={() => setToDelete(entry)}>
                {t('app.delete')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        isOpen={toDelete !== null}
        onClose={() => setToDelete(null)}
        onConfirm={async () => {
          if (!toDelete) return;
          const res = await remove(toDelete.path);
          if ('error' in res) setProblem(errorMessage(res.error));
          setToDelete(null);
        }}
        title={t('workspaceFiles.deleteTitle', { name: toDelete?.name ?? '' })}
        message={toDelete?.type === 'directory' ? t('workspaceFiles.deleteFolderBody') : t('workspaceFiles.deleteFileBody')}
        confirmText={t('app.delete')}
        isDestructive
        isLoading={removeState.isLoading}
      />
    </div>
  );
}

import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { useDeleteFileMutation, useFilesQuery } from '../../api/rtk-api';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Files you uploaded as attachments. */
export function FilesSettings() {
  const { t } = useTranslation();
  const { data, isLoading } = useFilesQuery();
  const [remove] = useDeleteFileMutation();

  return (
    <div className="space-y-4 p-5">
      <p className="text-sm text-text-secondary">{t('settings.filesHelp')}</p>
      {isLoading && <p className="text-sm text-text-secondary">{t('app.loading')}</p>}
      {data?.files.length === 0 && <p className="text-sm text-text-secondary">{t('settings.noFiles')}</p>}
      <ul className="divide-y divide-border rounded border border-border">
        {data?.files.map((f) => (
          <li key={f.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <a className="block truncate hover:underline" href={`/api/files/${f.id}/content`} download={f.name}>
                {f.name}
              </a>
              <div className="text-xs text-text-secondary">
                {formatSize(f.size)} · {new Date(f.createdAt).toLocaleString()}
                {f.status === 'failed' && <span className="text-error"> · {f.error}</span>}
                {f.textTruncated && ` · ${t('settings.fileTruncated')}`}
              </div>
            </div>
            <Button size="sm" variant="ghost" className="text-error" onClick={() => void remove(f.id)}>
              {t('app.delete')}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

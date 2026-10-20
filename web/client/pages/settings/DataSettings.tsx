/**
 * Your chats in and out: export everything as Claudia JSON, import exports
 * (Claudia, Claudia desktop, Open WebUI, ChatGPT; converted here in the
 * browser and sent in batches), and the share links you created.
 */
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { batchChats, convertImportFiles, type ConvertedImport } from '@shared/import';
import { errorMessage, useImportChatsMutation, useMySharesQuery, useRevokeShareMutation, usePermissions } from '../../api/rtk-api';
import { downloadFrom } from '../../chat/download';

interface Progress {
  done: number;
  total: number;
}

export function DataSettings() {
  const { t } = useTranslation();
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [importChats] = useImportChatsMutation();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [summary, setSummary] = useState<{ imported: number; skipped: number; converted: ConvertedImport } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: shareData } = useMySharesQuery();
  const [revoke] = useRevokeShareMutation();
  const permissions = usePermissions();

  const runImport = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setError(null);
    setSummary(null);
    setBusy(true);
    try {
      const files = await Promise.all(
        [...list].filter((f) => f.name.toLowerCase().endsWith('.json')).map(async (f) => ({ name: f.webkitRelativePath || f.name, text: await f.text() }))
      );
      const converted = convertImportFiles(files);
      if (files.length === 0) converted.problems.push({ file: '', message: t('settings.importNoJson') });
      const batches = batchChats(converted.chats);
      let imported = 0;
      let skipped = 0;
      setProgress({ done: 0, total: converted.chats.length });
      for (const batch of batches) {
        const res = await importChats({ chats: batch }).unwrap();
        imported += res.imported;
        skipped += res.skippedMessages;
        setProgress({ done: imported, total: converted.chats.length });
      }
      setSummary({ imported, skipped, converted });
    } catch (e) {
      setError(errorMessage(e) ?? String(e));
    } finally {
      setBusy(false);
      setProgress(null);
      if (filesRef.current) filesRef.current.value = '';
      if (folderRef.current) folderRef.current.value = '';
    }
  };

  const shares = shareData?.shares ?? [];

  return (
    <div className="space-y-8 p-5 text-sm">
      {permissions?.['chat.export'] && (
        <section>
          <h3 className="mb-1 font-semibold">{t('settings.exportTitle')}</h3>
          <p className="mb-3 text-text-secondary">{t('settings.exportHelp')}</p>
          <Button
            size="sm"
            onClick={() => void downloadFrom('/api/chats/export', 'claudia-chats.json').catch((e) => setError(errorMessage(e)))}
          >
            {t('settings.exportAll')}
          </Button>
        </section>
      )}

      <section>
        <h3 className="mb-1 font-semibold">{t('settings.importTitle')}</h3>
        <p className="mb-3 text-text-secondary">{t('settings.importHelp')}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => filesRef.current?.click()}>
            {t('settings.importFiles')}
          </Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => folderRef.current?.click()}>
            {t('settings.importFolder')}
          </Button>
        </div>
        <input
          ref={filesRef}
          type="file"
          accept=".json,application/json"
          multiple
          className="hidden"
          data-testid="import-files"
          onChange={(e) => void runImport(e.target.files)}
        />
        <input
          ref={folderRef}
          type="file"
          multiple
          className="hidden"
          // Desktop conversations are a folder of JSON files (one subfolder per project)
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          onChange={(e) => void runImport(e.target.files)}
        />
        {progress && (
          <p className="mt-3 text-text-secondary" role="status">
            {t('settings.importProgress', { done: progress.done, total: progress.total })}
          </p>
        )}
        {summary && (
          <div className="mt-3 rounded border border-border p-3" role="status" data-testid="import-summary">
            <p>{t('settings.importDone', { count: summary.imported })}</p>
            {summary.skipped > 0 && <p className="text-text-secondary">{t('settings.importSkipped', { count: summary.skipped })}</p>}
            {summary.converted.problems.length > 0 && (
              <details className="mt-1 text-text-secondary">
                <summary>{t('settings.importProblems', { count: summary.converted.problems.length })}</summary>
                <ul className="mt-1 list-disc ps-5">
                  {summary.converted.problems.slice(0, 50).map((p, i) => (
                    <li key={i}>
                      {p.file ? `${p.file}: ` : ''}
                      {p.message}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-1 font-semibold">{t('settings.sharedLinks')}</h3>
        {shares.length === 0 ? (
          <p className="text-text-secondary">{t('settings.noSharedLinks')}</p>
        ) : (
          <ul className="divide-y divide-border rounded border border-border">
            {shares.map((s) => (
              <li key={s.token} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <Link to={`/c/${s.chatId}`} className="block truncate hover:underline">
                    {s.title}
                  </Link>
                  <a className="block truncate text-xs text-text-secondary hover:underline" href={`/s/${s.token}`} target="_blank" rel="noreferrer">
                    {`${window.location.origin}/s/${s.token}`}
                  </a>
                </div>
                <Button size="sm" variant="ghost" className="text-error" onClick={() => void revoke(s.token)}>
                  {t('settings.revokeLink')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && (
        <p className="text-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

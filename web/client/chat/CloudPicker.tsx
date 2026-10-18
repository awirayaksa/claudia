import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import type { CloudItem, CloudProvider } from '@shared/cloud';
import type { FileView } from '@shared/files';
import { errorMessage, useCloudAccountsQuery, useCloudFilesQuery, useImportCloudFileMutation, useSessionQuery } from '../api/rtk-api';

/** The composer's button: shown when the admin set up Google Drive or OneDrive. */
export function CloudButton({ disabled, onImported }: { disabled?: boolean; onImported: (file: FileView) => void }) {
  const { t } = useTranslation();
  const { data: session } = useSessionQuery();
  const [open, setOpen] = useState(false);
  const cloud = session?.features?.cloudFiles;
  if (!cloud?.google && !cloud?.microsoft) return null;
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="rounded p-1.5 text-text-secondary transition-colors hover:bg-surface hover:text-accent disabled:opacity-50"
        title={t('cloud.addFrom')}
        aria-label={t('cloud.addFrom')}
        data-testid="cloud-button"
      >
        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
        </svg>
      </button>
      {open && (
        <CloudPicker
          onClose={() => setOpen(false)}
          onPicked={(f) => {
            onImported(f);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

/** Browse a connected Google Drive / OneDrive and copy a file in. */
export function CloudPicker({ onClose, onPicked }: { onClose: () => void; onPicked: (file: FileView) => void }) {
  const { t } = useTranslation();
  const { data, refetch } = useCloudAccountsQuery();
  const accounts = data?.accounts ?? [];
  const [provider, setProvider] = useState<CloudProvider | null>(null);
  const current = accounts.find((a) => a.provider === provider) ?? accounts[0];
  useEffect(() => {
    if (!provider && accounts[0]) setProvider(accounts[0].provider);
  }, [accounts, provider]);
  const popup = useRef<Window | null>(null);

  // Connecting happens in a pop-up; when the account shows up, close it
  const connect = (p: CloudProvider) => {
    popup.current = window.open(`/api/cloud/${p}/connect`, 'claudia-cloud', 'width=520,height=680');
    const timer = setInterval(async () => {
      const res = await refetch();
      const done = res.data?.accounts.find((a) => a.provider === p)?.connected;
      if (done || !popup.current || popup.current.closed) {
        clearInterval(timer);
        popup.current?.close();
      }
    }, 1500);
  };

  return (
    <Modal isOpen onClose={onClose} title={t('cloud.pickTitle')} size="lg">
      {accounts.length > 1 && (
        <div role="tablist" className="mb-3 flex gap-1">
          {accounts.map((a) => (
            <button
              key={a.provider}
              role="tab"
              aria-selected={current?.provider === a.provider}
              onClick={() => setProvider(a.provider)}
              className={`rounded border px-3 py-1 text-sm ${current?.provider === a.provider ? 'border-accent text-accent' : 'border-border'}`}
            >
              {t(`cloud.${a.provider}`)}
            </button>
          ))}
        </div>
      )}
      {current && !current.connected && (
        <div className="space-y-3 py-6 text-center">
          <p className="text-sm text-text-secondary">{t('cloud.connectHelp', { name: t(`cloud.${current.provider}`) })}</p>
          <Button onClick={() => connect(current.provider)}>{t('cloud.connect', { name: t(`cloud.${current.provider}`) })}</Button>
        </div>
      )}
      {current?.connected && <Browser provider={current.provider} account={current.accountEmail} onPicked={onPicked} />}
    </Modal>
  );
}

function Browser({ provider, account, onPicked }: { provider: CloudProvider; account: string | null; onPicked: (file: FileView) => void }) {
  const { t } = useTranslation();
  const [trail, setTrail] = useState<Array<{ id: string; name: string }>>([]);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const folder = trail.at(-1)?.id;
  const { data, error, isFetching } = useCloudFilesQuery({ provider, folder, q: q || undefined });
  const [importFile, importState] = useImportCloudFileMutation();

  const open = async (item: CloudItem) => {
    if (item.folder) {
      setTrail((tr) => [...tr, { id: item.id, name: item.name }]);
      setQ('');
      setSearch('');
      return;
    }
    const res = await importFile({ provider, fileId: item.id });
    if ('data' in res && res.data) onPicked(res.data.file);
  };

  return (
    <div className="space-y-3" data-testid="cloud-browser">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-text-secondary">{account}</span>
        <form
          className="ml-auto flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setQ(search.trim());
          }}
        >
          <input
            className="rounded border border-border bg-background px-2 py-1"
            placeholder={t('cloud.search')}
            aria-label={t('cloud.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </form>
      </div>
      <nav className="flex flex-wrap gap-1 text-sm" aria-label={t('cloud.path')}>
        <button className="text-accent hover:underline" onClick={() => setTrail([])}>
          {t('cloud.root')}
        </button>
        {trail.map((f, i) => (
          <span key={f.id}>
            {' / '}
            <button className="text-accent hover:underline" onClick={() => setTrail(trail.slice(0, i + 1))}>
              {f.name}
            </button>
          </span>
        ))}
      </nav>
      {error && <p className="text-sm text-error">{errorMessage(error)}</p>}
      {importState.error && <p className="text-sm text-error">{errorMessage(importState.error)}</p>}
      <ul className="max-h-[50vh] divide-y divide-border overflow-y-auto rounded border border-border">
        {isFetching && !data && <li className="p-3 text-sm text-text-secondary">{t('app.loading')}</li>}
        {data?.items.length === 0 && <li className="p-3 text-sm text-text-secondary">{t('cloud.empty')}</li>}
        {data?.items.map((item) => (
          <li key={item.id}>
            <button
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-background disabled:opacity-50"
              onClick={() => void open(item)}
              disabled={importState.isLoading}
            >
              <span aria-hidden>{item.folder ? '📁' : '📄'}</span>
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              {item.size !== null && <span className="text-xs text-text-secondary">{Math.max(1, Math.round(item.size / 1024))} KB</span>}
            </button>
          </li>
        ))}
      </ul>
      {importState.isLoading && <p className="text-sm text-text-secondary">{t('cloud.importing')}</p>}
    </div>
  );
}

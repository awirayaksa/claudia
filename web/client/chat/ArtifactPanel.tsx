/**
 * A reply's HTML, SVG or React code shown live. It renders on the sandbox
 * origin (sandbox/artifact.html) in a script-only sandboxed frame, so the
 * code can't reach the app, its cookies or the network.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ARTIFACT_EXTENSIONS, type Artifact } from '@/utils/artifacts';
import { usePublicConfigQuery } from '../api/rtk-api';
import { CloseIcon } from '../components/icons';
import { saveBlob } from './download';

export function ArtifactPanel({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: config } = usePublicConfigQuery();
  const sandbox = config?.sandboxOrigin ?? null;
  const frame = useRef<HTMLIFrameElement>(null);
  const [tab, setTab] = useState<'preview' | 'code'>(sandbox ? 'preview' : 'code');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // The host page has an opaque origin: recognize it by its window
      if (e.source !== frame.current?.contentWindow) return;
      if (e.data?.type === 'claudia-artifact-ready') {
        frame.current?.contentWindow?.postMessage({ type: 'claudia-artifact-render', kind: artifact.kind, code: artifact.code }, '*');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [artifact]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tabClass = (on: boolean) =>
    `rounded px-2.5 py-1 text-sm ${on ? 'bg-background font-medium text-text-primary' : 'text-text-secondary hover:text-text-primary'}`;

  return (
    <div className="fixed inset-0 z-40 flex justify-end md:left-auto md:w-[min(48rem,55vw)]" role="dialog" aria-label={artifact.title} data-testid="artifact-panel">
      <div className="flex h-full w-full flex-col border-l border-border bg-surface shadow-xl">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{artifact.title}</div>
            <div className="text-xs text-text-secondary">{t(`artifacts.kind.${artifact.kind}`)}</div>
          </div>
          {sandbox && (
            <div className="flex gap-1 rounded bg-surface p-0.5">
              <button className={tabClass(tab === 'preview')} onClick={() => setTab('preview')} aria-pressed={tab === 'preview'}>
                {t('artifacts.preview')}
              </button>
              <button className={tabClass(tab === 'code')} onClick={() => setTab('code')} aria-pressed={tab === 'code'}>
                {t('artifacts.code')}
              </button>
            </div>
          )}
          <button
            className="rounded px-2 py-1 text-sm text-text-secondary hover:text-text-primary"
            onClick={() => void navigator.clipboard?.writeText(artifact.code).then(() => setCopied(true))}
          >
            {copied ? t('apiKeys.copied') : t('apiKeys.copy')}
          </button>
          <button
            className="rounded px-2 py-1 text-sm text-text-secondary hover:text-text-primary"
            onClick={() =>
              saveBlob(new Blob([artifact.code], { type: 'text/plain' }), `${artifact.title.replace(/[^\w-]+/g, '-').toLowerCase() || 'artifact'}.${ARTIFACT_EXTENSIONS[artifact.kind]}`)
            }
          >
            {t('artifacts.download')}
          </button>
          <button className="rounded p-1.5 text-text-secondary hover:text-text-primary" aria-label={t('app.close')} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          {tab === 'preview' && sandbox ? (
            <iframe
              ref={frame}
              key={`${artifact.kind}:${artifact.code.length}:${artifact.title}`}
              src={`${sandbox}/artifact.html`}
              sandbox="allow-scripts"
              title={artifact.title}
              className="h-full w-full bg-white"
              data-testid="artifact-frame"
            />
          ) : (
            <pre className="h-full overflow-auto bg-background p-4 text-xs leading-relaxed">
              <code>{artifact.code}</code>
            </pre>
          )}
        </div>
        {!sandbox && <p className="border-t border-border px-3 py-2 text-xs text-text-secondary">{t('artifacts.noSandbox')}</p>}
      </div>
    </div>
  );
}

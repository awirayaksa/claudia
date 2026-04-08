import { useEffect, useState } from 'react';
import { Button } from '../common/Button';

interface UpdateStatus {
  state: string;
  currentVersion: string;
  latestVersion?: string;
  downloadedPath?: string;
  downloadProgress?: number;
  error?: string;
}

export function UpdateNotification() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [relaunching, setRelaunching] = useState(false);

  useEffect(() => {
    // Fetch initial status
    window.electron.updater.getStatus().then((s) => {
      if (s && (s.state === 'update-available' || s.state === 'downloading' || s.state === 'downloaded')) {
        setStatus(s);
        setDownloadProgress(s.downloadProgress ?? 0);
      }
    });

    const unsubStatus = window.electron.updater.onStatusChanged((s: UpdateStatus) => {
      if (s.state === 'update-available' || s.state === 'downloading' || s.state === 'downloaded') {
        setStatus(s);
        setDownloadProgress(s.downloadProgress ?? 0);
      } else if (s.state === 'idle' || s.state === 'error') {
        // Clear notification when there's no pending update
        setStatus(null);
      }
    });

    const unsubProgress = window.electron.updater.onDownloadProgress((percent: number) => {
      setDownloadProgress(percent);
    });

    return () => {
      unsubStatus();
      unsubProgress();
    };
  }, []);

  if (!status) return null;
  if (status.state !== 'update-available' && status.state !== 'downloading' && status.state !== 'downloaded') {
    return null;
  }

  const handleRelaunch = async () => {
    setRelaunching(true);
    await window.electron.updater.relaunch();
  };

  const isDownloading = status.state === 'downloading';
  const isReady = status.state === 'downloaded';

  return (
    <div className="border-t border-border bg-surface p-3">
      <div className="mb-2 flex items-start gap-2">
        <div className="mt-0.5 flex-shrink-0 text-accent">
          {isReady ? (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M8 1v9M8 10l-3-3M8 10l3-3M2 13h12"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M8 5v3.5l2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-text-primary">
            {isReady
              ? `Updated to ${status.latestVersion}`
              : `Newer Version ${status.latestVersion} available`}
          </p>
          <p className="mt-0.5 text-xs text-text-secondary">
            {isReady
              ? 'Relaunch to apply'
              : isDownloading
              ? `Downloading\u2026 ${downloadProgress}%`
              : 'Preparing download\u2026'}
          </p>
          {isDownloading && (
            <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-border">
              <div
                className="h-full rounded-full bg-accent transition-all duration-300"
                style={{ width: `${downloadProgress}%` }}
              />
            </div>
          )}
        </div>
      </div>
      {isReady && (
        <Button
          variant="primary"
          size="sm"
          className="w-full"
          onClick={handleRelaunch}
          disabled={relaunching}
        >
          {relaunching ? 'Relaunching\u2026' : 'Relaunch'}
        </Button>
      )}
    </div>
  );
}

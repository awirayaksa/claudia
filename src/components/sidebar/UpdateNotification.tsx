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

interface LastAttemptFailedPayload {
  result: 'failed';
  stage: string;
  errorlevel: number;
  timestamp: string;
  batchLogPath?: string;
}

export function UpdateNotification() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [relaunching, setRelaunching] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastFailed, setLastFailed] = useState<LastAttemptFailedPayload | null>(null);

  useEffect(() => {
    window.electron.updater.getStatus().then((s) => {
      if (s && (s.state === 'update-available' || s.state === 'downloading' || s.state === 'downloaded')) {
        setStatus(s);
        setDownloadProgress(s.downloadProgress ?? 0);
      } else if (s && s.state === 'error' && s.error) {
        setErrorMessage(s.error);
      }
    });

    const unsubStatus = window.electron.updater.onStatusChanged((s: UpdateStatus) => {
      if (s.state === 'update-available' || s.state === 'downloading' || s.state === 'downloaded') {
        setStatus(s);
        setDownloadProgress(s.downloadProgress ?? 0);
        setErrorMessage(null);
      } else if (s.state === 'error') {
        setStatus(null);
        setRelaunching(false);
        setErrorMessage(s.error ?? 'Update failed');
      } else if (s.state === 'idle') {
        setStatus(null);
      }
    });

    const unsubProgress = window.electron.updater.onDownloadProgress((percent: number) => {
      setDownloadProgress(percent);
    });

    const unsubFailed = window.electron.updater.onLastAttemptFailed((payload: LastAttemptFailedPayload) => {
      setLastFailed(payload);
    });

    return () => {
      unsubStatus();
      unsubProgress();
      unsubFailed();
    };
  }, []);

  const handleRelaunch = async () => {
    setRelaunching(true);
    await window.electron.updater.relaunch();
  };

  const handleOpenLogs = () => {
    window.electron.logger.openLogsFolder();
  };

  // Nothing to show
  if (!status && !errorMessage && !lastFailed) return null;

  // Error from current attempt (pre-flight failed, hash mismatch, spawn failed, etc.)
  if (errorMessage) {
    return (
      <div className="border-t border-border bg-surface p-3">
        <div className="mb-2 flex items-start gap-2">
          <div className="mt-0.5 flex-shrink-0 text-red-500">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M8 4v5M8 11.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-text-primary">Update failed</p>
            <p className="mt-0.5 break-words text-xs text-text-secondary">{errorMessage}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" className="flex-1" onClick={handleOpenLogs}>
            View Logs
          </Button>
          <Button variant="secondary" size="sm" className="flex-1" onClick={() => setErrorMessage(null)}>
            Dismiss
          </Button>
        </div>
      </div>
    );
  }

  // Previous launch detected a failed swap
  if (lastFailed && !status) {
    return (
      <div className="border-t border-border bg-surface p-3">
        <div className="mb-2 flex items-start gap-2">
          <div className="mt-0.5 flex-shrink-0 text-amber-500">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M8 1.5L1.5 13.5h13L8 1.5z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
              <path d="M8 6v3.5M8 11.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-text-primary">Last update did not complete</p>
            <p className="mt-0.5 text-xs text-text-secondary">
              Failed at stage &quot;{lastFailed.stage}&quot; (code {lastFailed.errorlevel}). Your previous version is still installed.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" className="flex-1" onClick={handleOpenLogs}>
            View Logs
          </Button>
          <Button variant="secondary" size="sm" className="flex-1" onClick={() => setLastFailed(null)}>
            Dismiss
          </Button>
        </div>
      </div>
    );
  }

  if (!status) return null;
  if (status.state !== 'update-available' && status.state !== 'downloading' && status.state !== 'downloaded') {
    return null;
  }

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
              ? `Downloading… ${downloadProgress}%`
              : 'Preparing download…'}
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
          {relaunching ? 'Relaunching…' : 'Relaunch'}
        </Button>
      )}
    </div>
  );
}

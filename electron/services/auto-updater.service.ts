import { EventEmitter } from 'events';
import { app } from 'electron';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'update-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'relaunching';

export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  latestVersion?: string;
  downloadedPath?: string;
  error?: string;
  downloadProgress?: number;
}

interface VersionManifest {
  version: string;
  url: string;
}

/**
 * Compares two semver version strings.
 * Returns true if `a` is strictly less than `b`.
 */
function isOlderVersion(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const [aMajor, aMinor, aPatch] = parse(a);
  const [bMajor, bMinor, bPatch] = parse(b);
  if (aMajor !== bMajor) return aMajor < bMajor;
  if (aMinor !== bMinor) return aMinor < bMinor;
  return aPatch < bPatch;
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https://') ? https : http;
    const req = protocol.get(url, { headers: { 'Cache-Control': 'no-cache' }, family: 4 } as any, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect (single level)
        fetchJson(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} fetching manifest`));
        return;
      }
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Invalid JSON in manifest')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('Manifest fetch timed out')); });
  });
}

function downloadFile(url: string, destPath: string, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https://') ? https : http;
    const doGet = (targetUrl: string) => {
      const req = protocol.get(targetUrl, { family: 4 } as any, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          doGet(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} downloading update`));
          return;
        }
        const total = parseInt(res.headers['content-length'] ?? '0', 10);
        let received = 0;
        const out = fs.createWriteStream(destPath);
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (total > 0) onProgress(Math.round((received / total) * 100));
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
        res.on('error', reject);
      });
      req.on('error', reject);
    };
    doGet(url);
  });
}

export class AutoUpdaterService extends EventEmitter {
  private status: UpdateStatus;
  private timer: ReturnType<typeof setInterval> | null = null;
  private manifestUrl = '';

  constructor() {
    super();
    this.status = {
      state: 'idle',
      currentVersion: app.getVersion(),
    };
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  private setState(patch: Partial<UpdateStatus>) {
    this.status = { ...this.status, ...patch };
    this.emit('status-changed', this.getStatus());
  }

  /**
   * Start a periodic check. Runs immediately, then every `intervalMs`.
   * Replaces any existing timer.
   */
  startPeriodicCheck(manifestUrl: string, intervalMs: number) {
    this.stopPeriodicCheck();
    this.manifestUrl = manifestUrl;
    // Run immediately
    this.runCheck();
    this.timer = setInterval(() => this.runCheck(), intervalMs);
  }

  stopPeriodicCheck() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Trigger a one-off check. */
  async runCheck() {
    if (!this.manifestUrl) return;
    if (this.status.state === 'downloading' || this.status.state === 'relaunching') return;
    await this.checkForUpdate(this.manifestUrl);
  }

  async checkForUpdate(manifestUrl: string): Promise<UpdateStatus> {
    this.setState({ state: 'checking', error: undefined });
    try {
      const manifest = await fetchJson(manifestUrl) as VersionManifest;
      if (!manifest.version || !manifest.url) {
        throw new Error('Manifest missing "version" or "url" fields');
      }
      const current = app.getVersion();
      if (isOlderVersion(current, manifest.version)) {
        console.log(`[AutoUpdater] Update found: ${current} → ${manifest.version}`);
        this.setState({ state: 'update-available', latestVersion: manifest.version });
        // Start downloading automatically in background
        this.downloadUpdate(manifest.url, manifest.version).catch((err) => {
          console.error('[AutoUpdater] Download failed:', err);
          this.setState({ state: 'error', error: String(err) });
        });
      } else {
        console.log(`[AutoUpdater] Already up to date: ${current}`);
        this.setState({ state: 'idle' });
      }
    } catch (err) {
      console.error('[AutoUpdater] Check failed:', err);
      this.setState({ state: 'error', error: String(err) });
    }
    return this.getStatus();
  }

  async downloadUpdate(url: string, version: string): Promise<string> {
    const filename = `Claudia-${version}-Portable.exe`;
    const destPath = path.join(os.tmpdir(), filename);

    this.setState({ state: 'downloading', downloadProgress: 0 });
    console.log(`[AutoUpdater] Downloading to ${destPath}`);

    await downloadFile(url, destPath, (percent) => {
      this.status.downloadProgress = percent;
      this.emit('download-progress', percent);
    });

    console.log(`[AutoUpdater] Download complete: ${destPath}`);
    this.setState({ state: 'downloaded', downloadedPath: destPath, downloadProgress: 100 });
    return destPath;
  }

  /**
   * Replace the current portable EXE and relaunch.
   * Only effective when `app.isPackaged` on Windows.
   */
  applyUpdate() {
    const downloadedPath = this.status.downloadedPath;
    if (!downloadedPath) {
      console.error('[AutoUpdater] No downloaded update to apply');
      return;
    }

    this.setState({ state: 'relaunching' });

    if (!app.isPackaged || process.platform !== 'win32') {
      // Dev mode: relaunch without file replacement
      console.log('[AutoUpdater] Dev mode — skipping self-replace. Would replace with:', downloadedPath);
      app.relaunch();
      app.exit(0);
      return;
    }

    const currentExe = process.execPath;
    const batchPath = path.join(os.tmpdir(), 'claudia-update.bat');

    // Escape paths for batch script (wrap in quotes, no escaping needed for well-formed paths)
    const batchContent = [
      '@echo off',
      'timeout /t 3 /nobreak >nul',
      `copy /y "${downloadedPath}" "${currentExe}"`,
      'if errorlevel 1 (',
      '  exit /b 1',
      ')',
      `start "" "${currentExe}"`,
      'del "%~f0"',
    ].join('\r\n');

    fs.writeFileSync(batchPath, batchContent, 'utf8');

    const child = spawn('cmd.exe', ['/c', batchPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();

    app.exit(0);
  }
}

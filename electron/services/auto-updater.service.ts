import { EventEmitter } from 'events';
import { app } from 'electron';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { logUpdater, getUpdaterBatchLogPath } from './auto-updater-logger.js';

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'update-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'relaunching';

export type UpdateCheckSource = 'menu' | 'periodic' | 'ipc' | 'unknown';

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
    const req = protocol.get(url, { headers: { 'Cache-Control': 'no-cache' }, family: 4, rejectUnauthorized: false } as any, (res) => {
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

function downloadFile(
  url: string,
  destPath: string,
  onProgress: (percent: number) => void,
  onStart?: (totalBytes: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https://') ? https : http;
    const doGet = (targetUrl: string) => {
      const req = protocol.get(targetUrl, { family: 4, rejectUnauthorized: false } as any, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          doGet(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} downloading update`));
          return;
        }
        const total = parseInt(res.headers['content-length'] ?? '0', 10);
        onStart?.(total);
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
    logUpdater('info', 'AutoUpdaterService instantiated', {
      currentVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      isPackaged: app.isPackaged,
      execPath: process.execPath,
      appPath: app.getAppPath(),
    });
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
    logUpdater('info', 'Periodic update check started', { manifestUrl, intervalMs });
    // Run immediately
    this.runCheck('periodic');
    this.timer = setInterval(() => this.runCheck('periodic'), intervalMs);
  }

  stopPeriodicCheck() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
      logUpdater('info', 'Periodic update check stopped');
    }
  }

  /** Trigger a one-off check. */
  async runCheck(source: UpdateCheckSource = 'periodic') {
    if (!this.manifestUrl) {
      logUpdater('warn', 'runCheck skipped: no manifest URL configured', { source });
      return;
    }
    if (this.status.state === 'downloading' || this.status.state === 'relaunching') {
      logUpdater('info', 'runCheck skipped: already busy', { source, state: this.status.state });
      return;
    }
    await this.checkForUpdate(this.manifestUrl, source);
  }

  async checkForUpdate(manifestUrl: string, source: UpdateCheckSource = 'unknown'): Promise<UpdateStatus> {
    const startedAt = Date.now();
    logUpdater('info', 'checkForUpdate: begin', { source, manifestUrl, currentVersion: app.getVersion() });
    this.setState({ state: 'checking', error: undefined });
    try {
      const manifest = await fetchJson(manifestUrl) as VersionManifest;
      logUpdater('info', 'checkForUpdate: manifest fetched', {
        source,
        elapsedMs: Date.now() - startedAt,
        manifest,
      });
      if (!manifest.version || !manifest.url) {
        throw new Error('Manifest missing "version" or "url" fields');
      }
      const current = app.getVersion();
      const isOlder = isOlderVersion(current, manifest.version);
      logUpdater('info', 'checkForUpdate: version comparison', {
        source,
        current,
        latest: manifest.version,
        isOlder,
      });
      if (isOlder) {
        console.log(`[AutoUpdater] Update found: ${current} → ${manifest.version}`);
        this.setState({ state: 'update-available', latestVersion: manifest.version });
        // Start downloading automatically in background
        this.downloadUpdate(manifest.url, manifest.version).catch((err) => {
          console.error('[AutoUpdater] Download failed:', err);
          logUpdater('error', 'downloadUpdate failed', { error: err });
          this.setState({ state: 'error', error: String(err) });
        });
      } else {
        console.log(`[AutoUpdater] Already up to date: ${current}`);
        this.setState({ state: 'idle' });
      }
    } catch (err) {
      console.error('[AutoUpdater] Check failed:', err);
      logUpdater('error', 'checkForUpdate failed', {
        source,
        manifestUrl,
        elapsedMs: Date.now() - startedAt,
        error: err,
      });
      this.setState({ state: 'error', error: String(err) });
    }
    return this.getStatus();
  }

  async downloadUpdate(url: string, version: string): Promise<string> {
    const filename = `Claudia-${version}-Portable.exe`;
    const destPath = path.join(os.tmpdir(), filename);
    const startedAt = Date.now();
    const checkpointsSeen = new Set<number>();

    this.setState({ state: 'downloading', downloadProgress: 0 });
    console.log(`[AutoUpdater] Downloading to ${destPath}`);
    logUpdater('info', 'downloadUpdate: begin', { url, version, destPath });

    await downloadFile(
      url,
      destPath,
      (percent) => {
        this.status.downloadProgress = percent;
        this.emit('download-progress', percent);
        for (const checkpoint of [25, 50, 75, 100]) {
          if (percent >= checkpoint && !checkpointsSeen.has(checkpoint)) {
            checkpointsSeen.add(checkpoint);
            logUpdater('info', 'downloadUpdate: progress checkpoint', {
              percent: checkpoint,
              elapsedMs: Date.now() - startedAt,
            });
          }
        }
      },
      (totalBytes) => {
        logUpdater('info', 'downloadUpdate: response headers', { totalBytes, url });
      },
    );

    let actualSize: number | undefined;
    try { actualSize = fs.statSync(destPath).size; } catch { /* ignore */ }

    console.log(`[AutoUpdater] Download complete: ${destPath}`);
    logUpdater('info', 'downloadUpdate: complete', {
      destPath,
      sizeBytes: actualSize,
      elapsedMs: Date.now() - startedAt,
    });
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
      logUpdater('error', 'applyUpdate: no downloaded update to apply');
      return;
    }

    this.setState({ state: 'relaunching' });

    const currentExe = process.execPath;
    let downloadedSize: number | undefined;
    let downloadedExists = false;
    try {
      const stat = fs.statSync(downloadedPath);
      downloadedExists = true;
      downloadedSize = stat.size;
    } catch { /* file missing */ }

    let currentExeWritable = false;
    try {
      fs.accessSync(currentExe, fs.constants.W_OK);
      currentExeWritable = true;
    } catch { /* not writable */ }

    logUpdater('info', 'applyUpdate: begin', {
      downloadedPath,
      downloadedExists,
      downloadedSize,
      currentExe,
      currentExeWritable,
      isPackaged: app.isPackaged,
      platform: process.platform,
    });

    if (!app.isPackaged || process.platform !== 'win32') {
      // Dev mode: relaunch without file replacement
      console.log('[AutoUpdater] Dev mode — skipping self-replace. Would replace with:', downloadedPath);
      logUpdater('info', 'applyUpdate: dev mode — skipping self-replace, calling app.relaunch()', { downloadedPath });
      app.relaunch();
      app.exit(0);
      return;
    }

    const batchPath = path.join(os.tmpdir(), 'claudia-update.bat');
    const batchLogPath = getUpdaterBatchLogPath();

    // Batch script tees progress to batchLogPath so we can diagnose failures
    // even though the spawned process runs detached with stdio:'ignore'.
    const batchContent = [
      '@echo off',
      `set "LOG=${batchLogPath}"`,
      'echo [%date% %time%] --- claudia-update.bat start --- >> "%LOG%" 2>&1',
      `echo [%date% %time%] source: "${downloadedPath}" >> "%LOG%" 2>&1`,
      `echo [%date% %time%] target: "${currentExe}" >> "%LOG%" 2>&1`,
      'timeout /t 3 /nobreak >nul',
      'echo [%date% %time%] running copy... >> "%LOG%" 2>&1',
      `copy /y "${downloadedPath}" "${currentExe}" >> "%LOG%" 2>&1`,
      'if errorlevel 1 (',
      '  echo [%date% %time%] copy FAILED with errorlevel %errorlevel% >> "%LOG%" 2>&1',
      '  exit /b 1',
      ')',
      'echo [%date% %time%] copy OK, starting new exe... >> "%LOG%" 2>&1',
      `start "" "${currentExe}"`,
      'echo [%date% %time%] start issued, deleting self >> "%LOG%" 2>&1',
      'del "%~f0"',
    ].join('\r\n');

    logUpdater('info', 'applyUpdate: writing batch script', {
      batchPath,
      batchLogPath,
      batchContent,
    });

    try {
      fs.writeFileSync(batchPath, batchContent, 'utf8');
    } catch (err) {
      logUpdater('error', 'applyUpdate: failed to write batch script', { batchPath, error: err });
      this.setState({ state: 'error', error: String(err) });
      return;
    }

    try {
      const child = spawn('cmd.exe', ['/c', batchPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      logUpdater('info', 'applyUpdate: batch spawned', { pid: child.pid });
    } catch (err) {
      logUpdater('error', 'applyUpdate: failed to spawn batch', { error: err });
      this.setState({ state: 'error', error: String(err) });
      return;
    }

    logUpdater('info', 'applyUpdate: calling app.exit(0) — main process terminating');
    app.exit(0);
  }
}

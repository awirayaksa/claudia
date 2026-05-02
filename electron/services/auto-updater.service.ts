import { EventEmitter } from 'events';
import { app } from 'electron';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import {
  logUpdater,
  getUpdaterBatchLogPath,
  getUpdaterStagingDir,
  getUpdaterFlagPath,
} from './auto-updater-logger.js';

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
  /** Optional SHA-256 of the published exe (lowercase hex). When present, verified after download. */
  sha256?: string;
}

export interface LastAttemptResult {
  result: 'ok' | 'failed';
  stage: string;
  errorlevel: number;
  timestamp: string;
}

const MIN_VALID_DOWNLOAD_BYTES = 1024 * 1024; // 1 MB sanity floor

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

function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    stream.on('error', reject);
  });
}

// `set "VAR=..."` in cmd treats the value as literal except for % expansion.
// Doubling % blocks expansion when the path contains a literal % character.
function escapeBatchValue(s: string): string {
  return s.replace(/%/g, '%%');
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

  startPeriodicCheck(manifestUrl: string, intervalMs: number) {
    this.stopPeriodicCheck();
    this.manifestUrl = manifestUrl;
    logUpdater('info', 'Periodic update check started', { manifestUrl, intervalMs });
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
        this.downloadUpdate(manifest).catch((err) => {
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

  async downloadUpdate(manifest: VersionManifest): Promise<string> {
    const stagingDir = getUpdaterStagingDir();
    const filename = `Claudia-${manifest.version}-Portable.exe`;
    const destPath = path.join(stagingDir, filename);
    const startedAt = Date.now();
    const checkpointsSeen = new Set<number>();

    // Clear any previous staged download to avoid resuming a partial file.
    try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch { /* ignore */ }

    this.setState({ state: 'downloading', downloadProgress: 0 });
    console.log(`[AutoUpdater] Downloading to ${destPath}`);
    logUpdater('info', 'downloadUpdate: begin', { url: manifest.url, version: manifest.version, destPath });

    await downloadFile(
      manifest.url,
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
        logUpdater('info', 'downloadUpdate: response headers', { totalBytes, url: manifest.url });
      },
    );

    let actualSize: number | undefined;
    try { actualSize = fs.statSync(destPath).size; } catch { /* ignore */ }

    if (manifest.sha256) {
      const expected = manifest.sha256.toLowerCase();
      const actual = await sha256OfFile(destPath);
      if (actual !== expected) {
        try { fs.unlinkSync(destPath); } catch { /* ignore */ }
        const msg = `SHA-256 mismatch: expected ${expected}, got ${actual}`;
        logUpdater('error', 'downloadUpdate: hash verification FAILED', { destPath, expected, actual });
        throw new Error(msg);
      }
      logUpdater('info', 'downloadUpdate: hash verified', { sha256: actual });
    } else {
      logUpdater('warn', 'downloadUpdate: manifest did not provide sha256 — skipping hash verification', { destPath });
    }

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
   * Free-disk-space probe. Returns Number.POSITIVE_INFINITY on platforms or
   * Node versions where statfs is unavailable so the check degrades open.
   */
  private getFreeBytes(dir: string): number {
    try {
      const statfs = (fs as unknown as { statfsSync?: (p: string) => { bavail: bigint; bsize: bigint } }).statfsSync;
      if (!statfs) return Number.POSITIVE_INFINITY;
      const s = statfs(dir);
      return Number(s.bavail * s.bsize);
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  /**
   * Pre-flight gate. Returns null if everything looks good, or an error string
   * to surface to the user. We deliberately do NOT exit the app on failure —
   * surfacing the error is more useful than silently disappearing.
   */
  private preflight(downloadedPath: string, currentExe: string): string | null {
    let downloadedSize = 0;
    try {
      downloadedSize = fs.statSync(downloadedPath).size;
    } catch {
      return `Downloaded update file is missing at ${downloadedPath}.`;
    }
    if (downloadedSize < MIN_VALID_DOWNLOAD_BYTES) {
      return `Downloaded update is suspiciously small (${downloadedSize} bytes). Refusing to apply.`;
    }
    try {
      const fd = fs.openSync(downloadedPath, 'r');
      const buf = Buffer.alloc(2);
      fs.readSync(fd, buf, 0, 2, 0);
      fs.closeSync(fd);
      if (buf[0] !== 0x4d || buf[1] !== 0x5a) {
        return 'Downloaded file is not a valid Windows executable (missing MZ header).';
      }
    } catch (err) {
      return `Could not read downloaded update: ${String(err)}`;
    }
    try {
      fs.accessSync(currentExe, fs.constants.W_OK);
    } catch {
      return 'Install location is not writable. Try moving Claudia to a writable folder (e.g. %LOCALAPPDATA%) or running once as administrator.';
    }
    const free = this.getFreeBytes(path.dirname(currentExe));
    if (free < downloadedSize * 2) {
      return `Not enough free disk space to apply update (need ~${Math.ceil(downloadedSize * 2 / 1_000_000)} MB).`;
    }
    return null;
  }

  /**
   * Build the swap-and-relaunch helper script. Args (PID, src, dst) are baked
   * into the script as `set` variables so we don't go through cmd's brittle
   * `/c "..." "..."` argument parsing.
   *
   * Strategy:
   *  1. Wait up to 60 s for the parent PID to actually exit.
   *  2. `move` the running exe to <exe>.bak — works on Windows for running EXEs
   *     within the same volume because it is a directory-entry rename, not a
   *     content rewrite. This frees the path so a new file can take its place.
   *  3. Retry `copy /y` up to 30 times, 1 s apart, to handle AV scan locks
   *     holding the freshly-downloaded source file.
   *  4. On any failure after backup, restore the .bak so the user is not
   *     stranded with a missing exe.
   *  5. Always write a sentinel JSON to last-attempt.json so the next launch
   *     can detect failure and surface it in the UI.
   */
  private buildHelperScript(downloadedPath: string, currentExe: string, parentPid: number): string {
    const dstDir = path.dirname(currentExe);
    const batchLogPath = getUpdaterBatchLogPath();
    const flagPath = getUpdaterFlagPath();

    const e = escapeBatchValue;
    return [
      '@echo off',
      `set "LOG=${e(batchLogPath)}"`,
      `set "FLAG=${e(flagPath)}"`,
      `set "PID=${parentPid}"`,
      `set "SRC=${e(downloadedPath)}"`,
      `set "DST=${e(currentExe)}"`,
      `set "BAK=${e(currentExe)}.bak"`,
      `set "DSTDIR=${e(dstDir)}"`,
      'set "STAGE=init"',
      'call :log "--- claudia-update.cmd start ---"',
      'call :log "pid=%PID%"',
      'call :log "src=%SRC%"',
      'call :log "dst=%DST%"',
      // 1) Wait for parent to exit (60 s cap)
      'set "STAGE=wait-parent"',
      'set /a WAITED=0',
      ':waitloop',
      'tasklist /FI "PID eq %PID%" /NH 2>nul | find /I "INFO:" >nul',
      'if not errorlevel 1 goto waitdone',
      'if %WAITED% GEQ 60 (',
      '  call :log "parent still running after 60s, aborting"',
      '  goto fail',
      ')',
      'timeout /t 1 /nobreak >nul',
      'set /a WAITED+=1',
      'goto waitloop',
      ':waitdone',
      'call :log "parent exited (waited %WAITED%s)"',
      // 2) Backup current exe via rename (works on running EXE)
      'set "STAGE=backup"',
      'if exist "%BAK%" del /f /q "%BAK%" >nul 2>&1',
      'move /y "%DST%" "%BAK%" >>"%LOG%" 2>&1',
      'if errorlevel 1 (',
      '  call :log "backup move FAILED el=%errorlevel%"',
      '  goto fail',
      ')',
      'call :log "backup OK"',
      // 3) Copy new exe with up to 30 retries (1s apart)
      'set "STAGE=copy"',
      'set /a TRIES=0',
      ':copyloop',
      'copy /y "%SRC%" "%DST%" >>"%LOG%" 2>&1',
      'if not errorlevel 1 goto copydone',
      'set /a TRIES+=1',
      'if %TRIES% GEQ 30 (',
      '  call :log "copy FAILED after 30 retries el=%errorlevel%, restoring backup"',
      '  move /y "%BAK%" "%DST%" >>"%LOG%" 2>&1',
      '  goto fail',
      ')',
      'timeout /t 1 /nobreak >nul',
      'goto copyloop',
      ':copydone',
      'call :log "copy OK after %TRIES% retries"',
      // 4) Relaunch with correct working directory
      'set "STAGE=relaunch"',
      'start "" /D "%DSTDIR%" "%DST%"',
      'call :log "relaunch issued"',
      // 5) Success sentinel
      'set "STAGE=success"',
      '> "%FLAG%" echo {"result":"ok","stage":"success","errorlevel":0,"timestamp":"%date% %time%"}',
      'del /f /q "%BAK%" >nul 2>&1',
      'del /f /q "%SRC%" >nul 2>&1',
      '(goto) 2>nul & del /f /q "%~f0"',
      'exit /b 0',
      ':fail',
      '> "%FLAG%" echo {"result":"failed","stage":"%STAGE%","errorlevel":%errorlevel%,"timestamp":"%date% %time%"}',
      'call :log "FAILED stage=%STAGE%"',
      'exit /b 1',
      ':log',
      'echo [%date% %time%] %~1 >> "%LOG%" 2>&1',
      'goto :eof',
    ].join('\r\n');
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
      this.setState({ state: 'error', error: 'No downloaded update to apply.' });
      return;
    }

    const currentExe = process.execPath;

    if (!app.isPackaged || process.platform !== 'win32') {
      // Dev mode: relaunch without file replacement
      console.log('[AutoUpdater] Dev mode — skipping self-replace. Would replace with:', downloadedPath);
      logUpdater('info', 'applyUpdate: dev mode — skipping self-replace, calling app.relaunch()', { downloadedPath });
      app.relaunch();
      app.exit(0);
      return;
    }

    // Hard pre-flight gates. If any check fails we surface the error and do
    // NOT exit — the previous behavior of exiting on failed pre-flight left
    // the user with a closed app and no explanation.
    const preflightError = this.preflight(downloadedPath, currentExe);
    logUpdater('info', 'applyUpdate: preflight', {
      downloadedPath,
      currentExe,
      preflightError,
      isPackaged: app.isPackaged,
      platform: process.platform,
    });
    if (preflightError) {
      this.setState({ state: 'error', error: preflightError });
      return;
    }

    const stagingDir = getUpdaterStagingDir();
    const helperPath = path.join(stagingDir, 'claudia-update.cmd');
    const helperContent = this.buildHelperScript(downloadedPath, currentExe, process.pid);

    logUpdater('info', 'applyUpdate: writing helper script', {
      helperPath,
      batchLogPath: getUpdaterBatchLogPath(),
      flagPath: getUpdaterFlagPath(),
      helperContent,
    });

    try {
      fs.writeFileSync(helperPath, helperContent, 'utf8');
    } catch (err) {
      logUpdater('error', 'applyUpdate: failed to write helper script', { helperPath, error: err });
      this.setState({ state: 'error', error: `Failed to stage updater: ${String(err)}` });
      return;
    }

    // Clear any leftover sentinel from a prior attempt so checkLastAttempt on
    // next launch only sees the result of THIS attempt.
    try { fs.unlinkSync(getUpdaterFlagPath()); } catch { /* ignore */ }

    this.setState({ state: 'relaunching' });

    try {
      const child = spawn('cmd.exe', ['/c', helperPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: stagingDir,
      });
      child.unref();
      logUpdater('info', 'applyUpdate: helper spawned', { pid: child.pid });
    } catch (err) {
      logUpdater('error', 'applyUpdate: failed to spawn helper', { error: err });
      this.setState({ state: 'error', error: `Failed to launch updater: ${String(err)}` });
      return;
    }

    logUpdater('info', 'applyUpdate: calling app.exit(0) — main process terminating');
    app.exit(0);
  }

  /**
   * Read the sentinel left by the helper script on its previous run. If it
   * indicates failure, emit `last-attempt-failed` so the UI can show a banner
   * with the failure stage and a pointer to the batch log. Always deletes the
   * sentinel after reading so we don't surface it twice.
   */
  checkLastAttempt(): void {
    const flagPath = getUpdaterFlagPath();
    if (!fs.existsSync(flagPath)) return;
    let parsed: LastAttemptResult | null = null;
    try {
      const content = fs.readFileSync(flagPath, 'utf8').trim();
      parsed = JSON.parse(content);
    } catch (err) {
      logUpdater('warn', 'checkLastAttempt: failed to parse sentinel', { flagPath, error: err });
    }
    try { fs.unlinkSync(flagPath); } catch { /* ignore */ }
    if (!parsed) return;
    logUpdater('info', 'checkLastAttempt: sentinel read', { parsed });
    if (parsed.result === 'failed') {
      this.emit('last-attempt-failed', { ...parsed, batchLogPath: getUpdaterBatchLogPath() });
    }
  }
}

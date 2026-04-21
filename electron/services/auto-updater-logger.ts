import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const MAX_LOG_BYTES = 1024 * 1024;

let cachedLogPath: string | null = null;

function resolveLogPath(): string {
  if (cachedLogPath) return cachedLogPath;
  const dir = path.join(app.getPath('logs'));
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Directory creation best-effort; appendFileSync below will surface real errors.
  }
  cachedLogPath = path.join(dir, 'auto-updater.log');
  return cachedLogPath;
}

function rotateIfNeeded(logPath: string): void {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size > MAX_LOG_BYTES) {
      const rotated = logPath + '.old';
      try { fs.rmSync(rotated, { force: true }); } catch { /* ignore */ }
      fs.renameSync(logPath, rotated);
    }
  } catch {
    // File doesn't exist yet — nothing to rotate.
  }
}

export type UpdaterLogLevel = 'info' | 'warn' | 'error';

export function logUpdater(level: UpdaterLogLevel, message: string, data?: Record<string, unknown>): void {
  const logPath = resolveLogPath();
  rotateIfNeeded(logPath);
  const timestamp = new Date().toISOString();
  const dataPart = data ? ' | ' + safeStringify(data) : '';
  const line = `[${timestamp}] [${level}] ${message}${dataPart}\n`;
  try {
    fs.appendFileSync(logPath, line, 'utf8');
  } catch (err) {
    // Last resort — at least surface to console so the failure isn't completely silent.
    console.error('[AutoUpdaterLogger] Failed to write log line:', err);
  }
}

export function getUpdaterLogPath(): string {
  return resolveLogPath();
}

export function getUpdaterBatchLogPath(): string {
  const dir = path.dirname(resolveLogPath());
  return path.join(dir, 'auto-updater-batch.log');
}

function safeStringify(data: Record<string, unknown>): string {
  try {
    return JSON.stringify(data, (_key, value) => {
      if (value instanceof Error) {
        return { name: value.name, message: value.message, stack: value.stack };
      }
      return value;
    });
  } catch {
    return '"[unserializable]"';
  }
}

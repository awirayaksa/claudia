/**
 * Shared by the built-in Spreadsheet, Presentation and PDF servers: where
 * files go, how they are written, and how a tool reports the files it wrote.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import JSZip from 'jszip';
import { assertPathAllowed, resolveRequestedPath } from './path-guard';

// ============================================================================
// Paths
// ============================================================================

export interface FileScope {
  /** Relative names resolve here. */
  workingDir: string;
  /** Web server: every path must stay inside workingDir. Desktop: any path works. */
  confine: boolean;
}

/** Desktop default: the user's Documents folder (their home when there is none). */
function defaultWorkingDir(): string {
  const docs = path.join(os.homedir(), 'Documents');
  return fs.existsSync(docs) ? docs : os.homedir();
}

export function fileScope(config?: Record<string, unknown>): FileScope {
  return {
    workingDir: (config?.workingDirectory as string) || defaultWorkingDir(),
    confine: config?.confineToWorkingDirectory === true,
  };
}

/**
 * Resolve a file name against the scope. With `ext`, the extension is added
 * when missing (".xlsx" → "budget" becomes "budget.xlsx").
 */
export function resolveFile(scope: FileScope, filename: string, ext?: string | string[]): string {
  const exts = ext === undefined ? [] : Array.isArray(ext) ? ext : [ext];
  const named = exts.length && !exts.some((e) => filename.toLowerCase().endsWith(e)) ? `${filename}${exts[0]}` : filename;
  if (!scope.confine) return path.isAbsolute(named) ? named : path.join(scope.workingDir, named);
  const resolved = resolveRequestedPath(named, [scope.workingDir]);
  assertPathAllowed(resolved, [scope.workingDir]);
  return resolved;
}

// ============================================================================
// Writing
// ============================================================================

/** Write through a temporary file, so a reader never sees half a file. */
export async function atomicWrite(filepath: string, data: Buffer | Uint8Array): Promise<void> {
  await fs.promises.mkdir(path.dirname(filepath), { recursive: true });
  const tmp = path.join(path.dirname(filepath), `.${path.basename(filepath)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, filepath);
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
}

/** One tool at a time per file: two edits of the same workbook must not interleave. */
const locks = new Map<string, Promise<unknown>>();

export function withFileLock<T>(filepath: string, op: () => Promise<T>): Promise<T> {
  const key = path.resolve(filepath).toLowerCase();
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(op);
  locks.set(key, next);
  return next.finally(() => {
    if (locks.get(key) === next) locks.delete(key);
  });
}

// ============================================================================
// Reporting written files
// ============================================================================

/** `_meta` key under which a built-in lists the files a call wrote (shown as cards on the desktop). */
export const WRITTEN_FILES_META = 'claudia/files';

export interface WrittenFile {
  /** Absolute path. */
  path: string;
  name: string;
  size: number;
}

const MIME: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export function mimeOf(filepath: string): string {
  return MIME[path.extname(filepath).toLowerCase()] ?? 'application/octet-stream';
}

/** `_meta` for a tool result that wrote these files (ones that no longer exist are left out). */
export function writtenFilesMeta(...paths: string[]): Record<string, unknown> {
  const files: WrittenFile[] = [];
  for (const p of paths) {
    try {
      files.push({ path: p, name: path.basename(p), size: fs.statSync(p).size });
    } catch {
      /* not written after all */
    }
  }
  return { [WRITTEN_FILES_META]: files };
}

/** A text result that also reports the files it wrote. */
export function wroteFiles(text: string, ...paths: string[]) {
  return { content: [{ type: 'text' as const, text }], _meta: writtenFilesMeta(...paths) };
}

export function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

// ============================================================================
// Opening Office packages
// ============================================================================

const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 500 * 1024 * 1024;
const MAX_ENTRIES = 10_000;

/**
 * Open an Office file (a zip) after checking its directory, so a zip bomb is
 * refused before anything is inflated (the web server opens users' files).
 */
export async function openPackage(buf: Buffer, name: string): Promise<JSZip> {
  if (buf.length > MAX_PACKAGE_BYTES) throw new Error(`${name} is larger than ${MAX_PACKAGE_BYTES / (1024 * 1024)} MB.`);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new Error(`${name} is not a valid Office file.`);
  }
  let entries = 0;
  let unpacked = 0;
  zip.forEach((_p, file) => {
    entries++;
    // Declared size from the zip directory (JSZip keeps it on the entry)
    unpacked += (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
  });
  if (entries > MAX_ENTRIES || unpacked > MAX_UNPACKED_BYTES) throw new Error(`${name} is too large when unpacked.`);
  return zip;
}

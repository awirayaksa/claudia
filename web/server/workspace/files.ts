/**
 * Files in a user's workspace (DATA_DIR/workspaces/<userId>), for the
 * workspace routes and for showing the files a built-in tool wrote under the
 * reply. Paths from requests are relative to the workspace; they are checked
 * with the built-in tools' path guard, so links can't lead outside it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertPathAllowed } from '../../../electron/services/builtin-mcp/path-guard';
import { badRequest, notFound } from '../lib/errors';
import type { WorkspaceEntry } from '../../shared/workspace-files';

/** Relative path ("reports/q3.md", "" for the workspace itself) → absolute path inside `root`. */
export function resolveInWorkspace(root: string, rel: string): string {
  if (rel.includes('\0') || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) throw badRequest('Invalid path.', 'invalid_path');
  const abs = path.resolve(root, rel);
  try {
    assertPathAllowed(abs, [root]);
  } catch {
    throw badRequest('Invalid path.', 'invalid_path');
  }
  return abs;
}

/** The path as the user sees it: relative to the workspace, with forward slashes. */
export function relativeToWorkspace(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

export async function listWorkspaceDir(root: string, rel: string): Promise<WorkspaceEntry[]> {
  const dir = resolveInWorkspace(root, rel);
  let dirents: fs.Dirent[];
  try {
    dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') throw notFound('Folder');
    throw err;
  }
  const entries: WorkspaceEntry[] = [];
  for (const d of dirents) {
    if (!d.isFile() && !d.isDirectory()) continue; // links and devices are not listed
    const abs = path.join(dir, d.name);
    const stat = await fs.promises.stat(abs).catch(() => null);
    if (!stat) continue;
    entries.push({
      name: d.name,
      path: relativeToWorkspace(root, abs),
      type: d.isDirectory() ? 'directory' : 'file',
      ...(d.isFile() ? { size: stat.size } : {}),
      modifiedAt: stat.mtime.toISOString(),
    });
  }
  return entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
}

/** An existing regular file in the workspace. */
export async function workspaceFile(root: string, rel: string): Promise<{ abs: string; size: number }> {
  const abs = resolveInWorkspace(root, rel);
  const stat = await fs.promises.stat(abs).catch(() => null);
  if (!stat?.isFile()) throw notFound('File');
  return { abs, size: stat.size };
}

// ---- What a tool call wrote ----

export type WorkspaceSnapshot = Map<string, { size: number; mtimeMs: number }>;

/** Above this many entries, written files are not looked for (too slow for every call). */
const SNAPSHOT_LIMIT = 5000;

/** Every file in the workspace with its size and time, or null when there are too many to look at. */
export async function snapshotWorkspace(root: string): Promise<WorkspaceSnapshot | null> {
  const out: WorkspaceSnapshot = new Map();
  let seen = 0;
  const walk = async (dir: string): Promise<boolean> => {
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const d of dirents) {
      if (++seen > SNAPSHOT_LIMIT) return false;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (!(await walk(abs))) return false;
      } else if (d.isFile()) {
        const stat = await fs.promises.stat(abs).catch(() => null);
        if (stat) out.set(relativeToWorkspace(root, abs), { size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
    return true;
  };
  return (await walk(root)) ? out : null;
}

/** Files that are new or changed between two snapshots. */
export function changedFiles(before: WorkspaceSnapshot, after: WorkspaceSnapshot): Array<{ path: string; size: number }> {
  const out: Array<{ path: string; size: number }> = [];
  for (const [p, now] of after) {
    const was = before.get(p);
    if (!was || was.size !== now.size || was.mtimeMs !== now.mtimeMs) out.push({ path: p, size: now.size });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Path checks for the built-in filesystem server.
 *
 * Paths are compared after resolving symlinks and junctions, so a link inside
 * an allowed directory cannot reach outside it. Comparison ignores case only
 * where the filesystem does (Windows).
 */
import * as fs from 'fs';
import * as path from 'path';

export interface PathGuardOptions {
  /** Defaults to the current platform. */
  caseInsensitive?: boolean;
}

const defaultCaseInsensitive = process.platform === 'win32';

/**
 * The real path of `p`. For a path that doesn't exist yet (a file about to be
 * written), the nearest existing ancestor is resolved and the rest appended.
 */
export function realPath(p: string): string {
  const resolved = path.resolve(p);
  const missing: string[] = [];
  let current = resolved;

  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return missing.length > 0 ? path.join(real, ...missing.reverse()) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      const parent = path.dirname(current);
      if (parent === current) return resolved; // reached the root without finding anything
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function comparable(p: string, caseInsensitive: boolean): string {
  return caseInsensitive ? p.toLowerCase() : p;
}

function isWithin(target: string, dir: string): boolean {
  if (target === dir) return true;
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return target.startsWith(prefix);
}

export function isPathAllowed(targetPath: string, allowedDirs: string[], opts: PathGuardOptions = {}): boolean {
  const ci = opts.caseInsensitive ?? defaultCaseInsensitive;
  const target = comparable(realPath(targetPath), ci);
  return allowedDirs.some((dir) => isWithin(target, comparable(realPath(dir), ci)));
}

export function assertPathAllowed(targetPath: string, allowedDirs: string[], opts: PathGuardOptions = {}): void {
  if (!isPathAllowed(targetPath, allowedDirs, opts)) {
    throw new Error(
      `Access denied: "${targetPath}" is outside allowed directories.\n` +
      `Allowed: ${allowedDirs.join(', ')}`
    );
  }
}

/**
 * Resolve a requested path against the allowed directories.
 *
 * The model often sends root-relative paths like "/hello.txt" or bare names
 * like "hello.txt" when a working directory is configured. This first tries
 * the path as an absolute path; if it falls outside every allowed directory it
 * retries by stripping leading separators and joining with the first allowed
 * directory (the configured working directory).
 */
export function resolveRequestedPath(requestedPath: string, allowedDirs: string[], opts: PathGuardOptions = {}): string {
  const absoluteResolved = path.resolve(requestedPath);

  if (allowedDirs.length === 0 || isPathAllowed(absoluteResolved, allowedDirs, opts)) {
    return absoluteResolved;
  }

  const stripped = requestedPath.replace(/^[/\\]+/, '');
  if (stripped) {
    const relativeResolved = path.resolve(allowedDirs[0], stripped);
    if (isPathAllowed(relativeResolved, allowedDirs, opts)) {
      return relativeResolved;
    }
  }

  return absoluteResolved; // Will fail assertPathAllowed with a clear error
}

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isPathAllowed, realPath, resolveRequestedPath } from './path-guard';

let root: string;
let allowed: string;
let outside: string;
let linkSupported = false;

beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'claudia-guard-')));
  allowed = path.join(root, 'allowed');
  outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(allowed, 'sub'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(allowed, 'a.txt'), 'a');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
  try {
    // A junction needs no admin rights on Windows; a plain dir symlink elsewhere
    fs.symlinkSync(outside, path.join(allowed, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    linkSupported = true;
  } catch {
    linkSupported = false;
  }
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('isPathAllowed', () => {
  it('allows the directory itself and paths inside it', () => {
    expect(isPathAllowed(allowed, [allowed])).toBe(true);
    expect(isPathAllowed(path.join(allowed, 'a.txt'), [allowed])).toBe(true);
    expect(isPathAllowed(path.join(allowed, 'sub', 'new-file.txt'), [allowed])).toBe(true);
    expect(isPathAllowed(path.join(allowed, 'new-dir', 'deep', 'x.txt'), [allowed])).toBe(true);
  });

  it('rejects ../ traversal and sibling prefixes', () => {
    expect(isPathAllowed(path.join(allowed, '..', 'outside', 'secret.txt'), [allowed])).toBe(false);
    expect(isPathAllowed(allowed + '-other', [allowed])).toBe(false);
    expect(isPathAllowed(outside, [allowed])).toBe(false);
  });

  it('rejects paths that escape through a symlink or junction', () => {
    if (!linkSupported) return;
    expect(isPathAllowed(path.join(allowed, 'escape', 'secret.txt'), [allowed])).toBe(false);
    expect(isPathAllowed(path.join(allowed, 'escape', 'new.txt'), [allowed])).toBe(false);
    expect(isPathAllowed(path.join(allowed, 'escape'), [allowed])).toBe(false);
  });

  it('allows a linked directory when the link target itself is allowed', () => {
    if (!linkSupported) return;
    expect(isPathAllowed(path.join(allowed, 'escape', 'secret.txt'), [allowed, outside])).toBe(true);
  });

  it('folds case only when the filesystem is case-insensitive', () => {
    const upper = path.join(allowed.toUpperCase(), 'a.txt');
    const lowerDir = allowed.toLowerCase();
    expect(isPathAllowed(path.join(lowerDir, 'x.txt'), [allowed.toUpperCase()], { caseInsensitive: true })).toBe(true);
    // Compared exactly, a differently-cased path is a different directory
    expect(isPathAllowed(upper, [allowed], { caseInsensitive: false })).toBe(
      fs.existsSync(upper) && realPath(upper) === realPath(path.join(allowed, 'a.txt'))
    );
  });

  it('allows nothing when no directory is configured', () => {
    expect(isPathAllowed(path.join(allowed, 'a.txt'), [])).toBe(false);
  });
});

describe('resolveRequestedPath', () => {
  it('resolves root-relative and bare names against the working directory', () => {
    expect(resolveRequestedPath('/a.txt', [allowed])).toBe(path.join(allowed, 'a.txt'));
    expect(resolveRequestedPath('sub/x.txt', [allowed])).toBe(path.join(allowed, 'sub', 'x.txt'));
  });

  it('keeps an absolute path that is already allowed', () => {
    const p = path.join(allowed, 'sub');
    expect(resolveRequestedPath(p, [allowed])).toBe(p);
  });

  it('does not rescue traversal out of the working directory', () => {
    const r = resolveRequestedPath('../outside/secret.txt', [allowed]);
    expect(isPathAllowed(r, [allowed])).toBe(false);
  });
});

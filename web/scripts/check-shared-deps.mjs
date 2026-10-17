#!/usr/bin/env node
/**
 * Claudia Web reuses ../src and ../electron/services. Their bare imports must
 * resolve from web/node_modules (Docker builds without the desktop deps), and
 * in development they resolve from the root node_modules — so each package
 * must be in web/package.json with a version range that overlaps the root's.
 *
 * Usage: node scripts/check-shared-deps.mjs [--list]
 *   --list  print every package the shared code imports, then exit 0
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = path.resolve(webDir, '..');

/** Shared code scanned for imports. */
const SHARED_DIRS = ['src', 'electron/services'];
/** Files the web app never loads (desktop entry points, tests). */
const IGNORE = [
  /\.test\.tsx?$/,
  /^src[\\/]test[\\/]/,
  /^src[\\/]main\.tsx$/,
  /^src[\\/]App\.tsx$/,
  /^src[\\/]platform[\\/]electron\.ts$/,
  /^src[\\/]store[\\/]desktop\.ts$/,
  /^src[\\/]assets\.d\.ts$/,
  /^src[\\/]global\.d\.ts$/,
];
/**
 * Packages only desktop-only files use. Listed explicitly so a new import of
 * them from shared code is a deliberate decision.
 */
const DESKTOP_ONLY = new Set(['electron', 'electron-store', 'electron-updater']);
/** Files under electron/services the server reuses; the rest is desktop-only. */
const SERVER_REUSED = [
  /^electron[\\/]services[\\/]mcp\.service\.ts$/,
  /^electron[\\/]services[\\/]skill-core\.ts$/,
  /^electron[\\/]services[\\/]builtin-mcp[\\/]/,
];

const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** "react-dom/client" → "react-dom"; "@scope/pkg/sub" → "@scope/pkg". */
function packageName(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const IMPORT_RE = [
  /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+(?:type\s+)?[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function importsOf(file) {
  const text = fs.readFileSync(file, 'utf8');
  const specs = new Set();
  for (const re of IMPORT_RE) {
    for (const m of text.matchAll(re)) specs.add(m[1]);
  }
  // Type-only imports don't need the package at runtime, but the client
  // type-check still needs their types, so they count too.
  return [...specs].filter((s) => !s.startsWith('.') && !s.startsWith('@/') && !s.startsWith('@electron/'));
}

/** package → files importing it */
const used = new Map();
for (const dir of SHARED_DIRS) {
  for (const file of walk(path.join(rootDir, dir))) {
    const rel = path.relative(rootDir, file);
    if (IGNORE.some((re) => re.test(rel))) continue;
    if (rel.startsWith('electron') && !SERVER_REUSED.some((re) => re.test(rel))) continue;
    for (const spec of importsOf(file)) {
      if (builtins.has(spec) || builtins.has(spec.split('/')[0])) continue;
      const name = packageName(spec);
      if (!used.has(name)) used.set(name, new Set());
      used.get(name).add(rel);
    }
  }
}

if (process.argv.includes('--list')) {
  for (const [name, files] of [...used].sort()) console.log(`${name}  (${[...files].slice(0, 3).join(', ')}${files.size > 3 ? ', …' : ''})`);
  process.exit(0);
}

const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const webPkg = JSON.parse(fs.readFileSync(path.join(webDir, 'package.json'), 'utf8'));
const rootDeps = { ...rootPkg.dependencies, ...rootPkg.devDependencies };
const webDeps = { ...webPkg.dependencies, ...webPkg.devDependencies };

// ─── Minimal semver range overlap (^, ~, exact, >=, x-ranges) ────────────────

function parseVersion(v) {
  const m = /^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(v.trim());
  if (!m) return null;
  const n = (s) => (s === undefined || s === 'x' || s === '*' ? null : Number(s));
  return [Number(m[1]), n(m[2]), n(m[3])];
}

/** A range as [min (inclusive), max (exclusive) | null] over [major, minor, patch]. */
function toInterval(range) {
  range = range.trim();
  if (range === '*' || range === '' || range === 'latest') return [[0, 0, 0], null];
  if (/^(npm:|file:|link:|git|https?:)/.test(range)) return null;
  const op = /^(\^|~|>=|>|<=|<|=)?\s*/.exec(range)[1] ?? '';
  const v = parseVersion(range.slice(op.length));
  if (!v) return null;
  const [maj, min, pat] = v;
  const lo = [maj, min ?? 0, pat ?? 0];
  switch (op) {
    case '^':
      if (maj > 0) return [lo, [maj + 1, 0, 0]];
      if ((min ?? 0) > 0) return [lo, [0, min + 1, 0]];
      return [lo, [0, 0, (pat ?? 0) + 1]];
    case '~':
      return [lo, min === null ? [maj + 1, 0, 0] : [maj, min + 1, 0]];
    case '>=':
      return [lo, null];
    case '':
    case '=':
      if (min === null) return [lo, [maj + 1, 0, 0]];
      if (pat === null) return [lo, [maj, min + 1, 0]];
      return [lo, [maj, min, pat + 1]];
    default:
      return [[0, 0, 0], null]; // be lenient with rarer operators
  }
}

const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function overlaps(a, b) {
  const ia = toInterval(a);
  const ib = toInterval(b);
  if (!ia || !ib) return true; // can't tell; don't fail on exotic specs
  const lo = cmp(ia[0], ib[0]) >= 0 ? ia[0] : ib[0];
  const his = [ia[1], ib[1]].filter(Boolean);
  if (his.length === 0) return true;
  const hi = his.reduce((x, y) => (cmp(x, y) <= 0 ? x : y));
  return cmp(lo, hi) < 0;
}

// ─── Check ───────────────────────────────────────────────────────────────────

const problems = [];
for (const [name, files] of [...used].sort()) {
  if (DESKTOP_ONLY.has(name)) {
    problems.push(`${name}: desktop-only package imported by shared code (${[...files].join(', ')})`);
    continue;
  }
  const webRange = webDeps[name];
  if (!webRange) {
    problems.push(`${name}: missing from web/package.json (used by ${[...files].slice(0, 3).join(', ')})`);
    continue;
  }
  const rootRange = rootDeps[name];
  if (rootRange && !overlaps(webRange, rootRange)) {
    problems.push(`${name}: web wants ${webRange} but the root has ${rootRange}; the ranges don't overlap`);
  }
}

if (problems.length > 0) {
  console.error(`check-shared-deps: ${problems.length} problem(s)\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`check-shared-deps: ${used.size} packages used by shared code, all present in web/package.json with compatible versions.`);

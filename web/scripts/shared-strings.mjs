// The shared components' strings: every t('key', 'English') call in ../src.
//   node scripts/shared-strings.mjs          writes client/i18n/locales/en.shared.json
//   node scripts/shared-strings.mjs --check  fails when that file is out of date (CI)
// Translators copy en.shared.json to <lang>.shared.json and translate the values.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(webDir, '..', 'src');
export const CATALOG = path.join(webDir, 'client', 'i18n', 'locales', 'en.shared.json');

// t('key', 'text' | "text") — quotes may be escaped; the call may span lines
const CALL = /\bt\(\s*'([A-Za-z0-9_.]+)'\s*,\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;

function unquote(literal) {
  return literal
    .slice(1, -1)
    .replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' })[c] ?? c);
}

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === '__tests__' ? [] : files(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** { key: english } from the sources; throws when one key has two texts. */
export function extract() {
  const found = new Map();
  for (const file of files(srcDir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(CALL)) {
      const [, key, literal] = m;
      const english = unquote(literal);
      const where = `${path.relative(srcDir, file)}`;
      const prev = found.get(key);
      if (prev && prev.english !== english) {
        throw new Error(`"${key}" is "${prev.english}" in ${prev.where} but "${english}" in ${where}`);
      }
      found.set(key, { english, where });
    }
  }
  return Object.fromEntries([...found].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.english]));
}

/** Nested the way i18next reads it ("a.b" → { a: { b } }); a key can't also be a group. */
export function nest(flat) {
  const out = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    let node = out;
    for (const [i, part] of parts.entries()) {
      if (i === parts.length - 1) {
        if (part in node) throw new Error(`"${key}" is both a text and a group of texts`);
        node[part] = value;
      } else {
        if (typeof node[part] === 'string') throw new Error(`"${parts.slice(0, i + 1).join('.')}" is both a text and a group of texts`);
        node = node[part] ??= {};
      }
    }
  }
  return out;
}

export function render() {
  return `${JSON.stringify(nest(extract()), null, 2)}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = render();
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(CATALOG) ? fs.readFileSync(CATALOG, 'utf8').replace(/\r\n/g, '\n') : '';
    if (current !== next) {
      console.error('client/i18n/locales/en.shared.json is out of date: run `node scripts/shared-strings.mjs`.');
      process.exit(1);
    }
    console.log('shared strings: up to date');
  } else {
    fs.writeFileSync(CATALOG, next);
    console.log(`shared strings: ${Object.keys(extract()).length} written to ${path.relative(process.cwd(), CATALOG)}`);
  }
}

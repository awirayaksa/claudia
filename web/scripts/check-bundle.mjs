#!/usr/bin/env node
/**
 * The client bundle must contain exactly one copy of React (and of Redux):
 * shared ../src code resolving its imports against the root node_modules
 * would silently pull in a second one and break hooks.
 *
 * Reads the source map of every built chunk and counts distinct package roots.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = path.join(webDir, 'dist', 'client', 'assets');
const SINGLETONS = ['react', 'react-dom', 'react-redux', '@reduxjs/toolkit', 'redux'];

if (!fs.existsSync(assetsDir)) {
  console.error('check-bundle: dist/client/assets not found; run `npm run build:client` first.');
  process.exit(1);
}

/** package name → set of node_modules roots it was bundled from */
const roots = new Map(SINGLETONS.map((p) => [p, new Set()]));

for (const file of fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js.map'))) {
  const map = JSON.parse(fs.readFileSync(path.join(assetsDir, file), 'utf8'));
  for (const source of map.sources ?? []) {
    const normalized = source.replace(/\\/g, '/');
    for (const pkg of SINGLETONS) {
      const marker = `node_modules/${pkg}/`;
      const idx = normalized.lastIndexOf(marker);
      if (idx >= 0) {
        // Resolve the root relative to the map so web/ and the repo root differ
        const root = path.resolve(assetsDir, normalized.slice(0, idx + marker.length));
        roots.get(pkg).add(root);
      }
    }
  }
}

let failed = false;
for (const [pkg, set] of roots) {
  if (set.size > 1) {
    failed = true;
    console.error(`check-bundle: ${pkg} is bundled ${set.size} times:\n  ${[...set].join('\n  ')}`);
  } else if (set.size === 1) {
    const root = [...set][0];
    const inWeb = root.startsWith(path.join(webDir, 'node_modules'));
    console.log(`check-bundle: ${pkg} ×1 ${inWeb ? '(web/node_modules)' : `(${root})`}`);
    if (!inWeb) {
      failed = true;
      console.error(`check-bundle: ${pkg} must come from web/node_modules`);
    }
  }
}
if (roots.get('react').size === 0) {
  failed = true;
  console.error('check-bundle: React not found in the bundle; are source maps enabled?');
}
process.exit(failed ? 1 : 0);

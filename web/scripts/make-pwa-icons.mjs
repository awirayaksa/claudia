// Web app icons from the desktop icon (build/icon.png). Run again after the icon changes:
//   node scripts/make-pwa-icons.mjs
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(webDir, '..', 'build', 'icon.png');
const out = path.join(webDir, 'public', 'icons');
fs.mkdirSync(out, { recursive: true });

// The logo sits in the middle ~60% on black, inside the maskable safe zone (80%)
const full = (size, name) => sharp(source).resize(size, size, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toFile(path.join(out, name));
// Small sizes: the rounded square alone, so it stays legible in a tab
const tight = (size, name) =>
  sharp(source)
    .extract({ left: 52, top: 60, width: 156, height: 156 })
    .resize(size, size, { kernel: 'lanczos3' })
    .png({ compressionLevel: 9 })
    .toFile(path.join(out, name));

await Promise.all([
  full(192, 'icon-192.png'),
  full(512, 'icon-512.png'),
  full(512, 'icon-maskable-512.png'),
  full(180, 'apple-touch-icon.png'),
  tight(32, 'favicon-32.png'),
]);
console.log(`icons written to ${path.relative(process.cwd(), out)}`);

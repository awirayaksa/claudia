/**
 * White-label branding, resolved at build time (see brands/README.md).
 *
 * The brand is picked by, in order:
 *   1. the BRAND environment variable (`BRAND=acme npm run build`,
 *      `docker build --build-arg BRAND=acme …`);
 *   2. the file brands/active, holding a brand id (a private fork commits it);
 *   3. otherwise none: the app is Claudia, exactly as without this file.
 *
 * Tests ignore brands/active, so they always see Claudia unless BRAND is set.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const brandsDir = path.join(webDir, 'brands');

/** What the client is built with (`__BRAND__`). */
export interface ClientBrand {
  /** Brand id: the folder under brands/, or "" for Claudia. */
  id: string;
  /** Product name, shown wherever the app names itself. */
  name: string;
  /** Logo URL (under the public folder), shown on the sign-in page. */
  logo?: string;
  /** Assistant avatar image URL, in place of the "C" badge. */
  avatar?: string;
  /** Default accent colours (users can still pick their own). */
  accent?: { light: string; dark: string };
}

export interface Brand extends ClientBrand {
  /** brands/<id>/, or null for Claudia. */
  dir: string | null;
  description?: string;
  /** Browser UI and PWA theme colour. */
  themeColor?: string;
  /** PWA splash background colour. */
  backgroundColor?: string;
}

export const DEFAULT_BRAND: Brand = { id: '', name: 'Claudia', dir: null };

const ID = /^[a-z0-9][a-z0-9_-]*$/;
const COLOR = /^#[0-9a-fA-F]{3,8}$/;

/** The brand id to build, or "" for Claudia. */
export function brandId(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.BRAND?.trim();
  if (fromEnv) return fromEnv;
  if (env.VITEST) return '';
  try {
    return fs.readFileSync(path.join(brandsDir, 'active'), 'utf8').trim();
  } catch {
    return '';
  }
}

/** Reads and checks brands/<id>/brand.json; throws on anything wrong, so a build never ships half a brand. */
export function loadBrand(id: string = brandId(), root: string = brandsDir): Brand {
  if (!id || id === 'claudia') return DEFAULT_BRAND;
  if (!ID.test(id)) throw new Error(`BRAND "${id}": use lowercase letters, digits, "-" and "_"`);
  const dir = path.join(root, id);
  const file = path.join(dir, 'brand.json');
  if (!fs.existsSync(file)) throw new Error(`BRAND "${id}": ${path.relative(webDir, file)} not found`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const str = (key: string, required = false): string | undefined => {
    const v = raw[key];
    if (v === undefined && !required) return undefined;
    if (typeof v !== 'string' || !v.trim()) throw new Error(`BRAND "${id}": "${key}" must be a non-empty string`);
    return v.trim();
  };
  const color = (key: string) => {
    const v = str(key);
    if (v !== undefined && !COLOR.test(v)) throw new Error(`BRAND "${id}": "${key}" must be a hex colour like #1a2b3c`);
    return v;
  };
  const url = (key: string) => {
    const v = str(key);
    if (v === undefined) return undefined;
    if (!v.startsWith('/')) throw new Error(`BRAND "${id}": "${key}" must be a path under public/, starting with "/"`);
    const inBrand = path.join(dir, 'public', v);
    const inApp = path.join(webDir, 'public', v);
    if (!fs.existsSync(inBrand) && !fs.existsSync(inApp)) {
      throw new Error(`BRAND "${id}": "${key}" ${v} is in neither brands/${id}/public nor public`);
    }
    return v;
  };
  let accent: Brand['accent'];
  if (raw.accent !== undefined) {
    const a = raw.accent as Record<string, unknown> | null;
    const ok = (v: unknown): v is string => typeof v === 'string' && COLOR.test(v);
    if (!a || typeof a !== 'object' || !ok(a.light) || !ok(a.dark)) {
      throw new Error(`BRAND "${id}": "accent" must be { "light": "#hex", "dark": "#hex" }`);
    }
    accent = { light: a.light, dark: a.dark };
  }
  return {
    id,
    dir,
    name: str('name', true)!,
    description: str('description'),
    themeColor: color('themeColor'),
    backgroundColor: color('backgroundColor'),
    logo: url('logo'),
    avatar: url('avatar'),
    accent,
  };
}

export function clientBrand(brand: Brand): ClientBrand {
  return { id: brand.id, name: brand.name, logo: brand.logo, avatar: brand.avatar, accent: brand.accent };
}

/** brands/<id>/theme.css, if the brand has one. */
export function brandThemeFile(brand: Brand): string | null {
  if (!brand.dir) return null;
  const file = path.join(brand.dir, 'theme.css');
  return fs.existsSync(file) ? file : null;
}

/**
 * The brand's stylesheet, loaded after the app's: its accent colours (same
 * selectors as src/styles/globals.css, so they win by order), then theme.css.
 */
export function brandThemeCss(brand: Brand): string {
  const parts: string[] = [];
  if (brand.accent) {
    const vars = (c: string, mix: string) =>
      `  --color-accent: ${c};\n  --color-accent-hover: color-mix(in srgb, ${c} 85%, ${mix});\n`;
    const light = vars(brand.accent.light, 'black');
    const dark = vars(brand.accent.dark, 'white');
    parts.push(
      `:root[data-theme="light"],\n:root {\n${light}}\n`,
      `:root[data-theme="dark"] {\n${dark}}\n`,
      `@media (prefers-color-scheme: dark) {\n  :root[data-theme="system"] {\n${dark}  }\n}\n`,
      `@media (prefers-color-scheme: light) {\n  :root[data-theme="system"] {\n${light}  }\n}\n`
    );
  }
  const file = brandThemeFile(brand);
  if (file) parts.push(fs.readFileSync(file, 'utf8'));
  return parts.join('\n');
}

/**
 * The public folder to serve: public/ itself for Claudia; for a brand, a copy
 * of it (in node_modules/.brand/public) with brands/<id>/public laid over it
 * and the web manifest renamed and recoloured.
 */
export function brandPublicDir(brand: Brand): string {
  const base = path.join(webDir, 'public');
  if (!brand.dir) return base;
  const out = path.join(webDir, 'node_modules', '.brand', 'public');
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(base, out, { recursive: true });
  const overlay = path.join(brand.dir, 'public');
  if (fs.existsSync(overlay)) fs.cpSync(overlay, out, { recursive: true });

  const manifestFile = path.join(out, 'manifest.webmanifest');
  if (fs.existsSync(manifestFile) && !fs.existsSync(path.join(overlay, 'manifest.webmanifest'))) {
    const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Record<string, unknown>;
    m.name = brand.name;
    m.short_name = brand.name;
    if (brand.description) m.description = brand.description;
    if (brand.themeColor) m.theme_color = brand.themeColor;
    if (brand.backgroundColor) m.background_color = brand.backgroundColor;
    fs.writeFileSync(manifestFile, JSON.stringify(m, null, 2) + '\n');
  }
  return out;
}

/** index.html with the brand's title and theme colour. */
export function brandHtml(html: string, brand: Brand): string {
  if (!brand.dir) return html;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  let out = html.replace(/<title>[^<]*<\/title>/, `<title>${esc(brand.name)}</title>`);
  if (brand.themeColor) out = out.replace(/(<meta name="theme-color" content=")[^"]*(")/, `$1${brand.themeColor}$2`);
  return out;
}

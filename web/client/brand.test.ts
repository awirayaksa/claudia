import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { brandHtml, brandId, brandThemeCss, DEFAULT_BRAND, loadBrand } from '../scripts/brand';
import { rebrandCatalog, rebrandText } from './brand';

describe('rebrandText', () => {
  it('renames the product', () => {
    expect(rebrandText('Message Claudia…', 'Acme AI')).toBe('Message Acme AI…');
    expect(rebrandText('Back to Claudia', 'Acme AI')).toBe('Back to Acme AI');
    expect(rebrandText('راسل Claudia…', 'Acme AI')).toBe('راسل Acme AI…');
    expect(rebrandText("Claudia's server", 'Acme AI')).toBe("Acme AI's server");
  });

  it('leaves technical names and the desktop app alone', () => {
    expect(rebrandText('the X-Claudia-Signature header', 'Acme')).toBe('the X-Claudia-Signature header');
    expect(rebrandText('ClaudiaWeb/1.0', 'Acme')).toBe('ClaudiaWeb/1.0');
    expect(rebrandText('including Claudia desktop as a provider', 'Acme')).toBe('including Claudia desktop as a provider');
    expect(rebrandText('ومحادثات Claudia لسطح المكتب', 'Acme')).toBe('ومحادثات Claudia لسطح المكتب');
  });

  it('walks nested catalogs', () => {
    const catalog = { app: { name: 'Claudia' }, chat: { placeholder: 'Message Claudia…' }, n: 1 };
    rebrandCatalog(catalog, 'Acme');
    expect(catalog).toEqual({ app: { name: 'Acme' }, chat: { placeholder: 'Message Acme…' }, n: 1 });
  });
});

describe('loadBrand', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const brandsWith = (json: unknown, files: Record<string, string> = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brands-'));
    dirs.push(root);
    fs.mkdirSync(path.join(root, 'acme', 'public', 'icons'), { recursive: true });
    fs.writeFileSync(path.join(root, 'acme', 'brand.json'), JSON.stringify(json));
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(root, 'acme', f), text);
    return root;
  };

  it('is Claudia without a brand', () => {
    expect(loadBrand('')).toBe(DEFAULT_BRAND);
    expect(loadBrand('claudia')).toBe(DEFAULT_BRAND);
  });

  it('reads brand.json', () => {
    const root = brandsWith(
      { name: 'Acme AI', themeColor: '#123456', accent: { light: '#111111', dark: '#eeeeee' } },
      { 'theme.css': ':root { --color-surface: red; }' }
    );
    const brand = loadBrand('acme', root);
    expect(brand).toMatchObject({ id: 'acme', name: 'Acme AI', themeColor: '#123456', accent: { light: '#111111', dark: '#eeeeee' } });
    const css = brandThemeCss(brand);
    expect(css).toContain('--color-accent: #111111;');
    expect(css).toContain('--color-accent: #eeeeee;');
    expect(css).toContain('--color-surface: red;');
    expect(brandHtml('<title>Claudia</title><meta name="theme-color" content="#D97757" />', brand)).toBe(
      '<title>Acme AI</title><meta name="theme-color" content="#123456" />'
    );
  });

  it('refuses a broken brand', () => {
    expect(() => loadBrand('missing', brandsWith({ name: 'x' }))).toThrow(/not found/);
    expect(() => loadBrand('acme', brandsWith({}))).toThrow(/"name"/);
    expect(() => loadBrand('acme', brandsWith({ name: 'x', themeColor: 'red' }))).toThrow(/themeColor/);
    expect(() => loadBrand('acme', brandsWith({ name: 'x', accent: { light: '#fff' } }))).toThrow(/accent/);
    expect(() => loadBrand('acme', brandsWith({ name: 'x', logo: '/icons/nope.png' }))).toThrow(/logo/);
    expect(() => loadBrand('../etc')).toThrow(/lowercase/);
  });

  it('takes BRAND first and ignores brands/active in tests', () => {
    expect(brandId({ BRAND: ' acme ' })).toBe('acme');
    expect(brandId({ VITEST: 'true' })).toBe('');
  });
});

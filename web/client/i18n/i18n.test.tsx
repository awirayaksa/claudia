// @vitest-environment jsdom
/**
 * The shared desktop components follow the web app's language: their t()
 * goes through i18next's "shared" namespace, falls back to English, and
 * re-renders on a language change. The English catalogue matches the sources.
 */
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Citations } from '@/components/chat/Citations';
import i18n, { LANGUAGES, pickLanguage, resources } from './index';
// @ts-expect-error plain ES module script
import { CATALOG, render as renderCatalog } from '../../scripts/shared-strings.mjs';

afterEach(async () => {
  await act(() => i18n.changeLanguage('en'));
});

describe('shared component strings', () => {
  it('are English by default and follow a language change', async () => {
    i18n.addResourceBundle('xx', 'shared', { common: { cancel: 'Abbrechen', confirm: 'Bestätigen' }, citations: { sources: 'Quellen' } });
    render(<ConfirmDialog isOpen onClose={() => {}} onConfirm={() => {}} title="Delete?" message="Really?" />);
    render(
      <Citations
        citations={[{ index: 1, source: { kind: 'url', url: 'https://example.com/a', title: 'Example' } }]}
        active={null}
        onActiveChange={() => {}}
      />
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByText('Sources')).toBeInTheDocument();

    await act(() => i18n.changeLanguage('xx'));
    expect(screen.getByRole('button', { name: 'Abbrechen' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bestätigen' })).toBeInTheDocument();
    expect(screen.getByText('Quellen')).toBeInTheDocument();
    // Not translated: English
    expect(screen.queryByText('Open')).toBeNull();
  });

  it('fill in their placeholders', async () => {
    const { t } = await import('@/i18n');
    i18n.addResourceBundle('xx', 'shared', { mcp: { start: '{{name}} starten' } });
    await act(() => i18n.changeLanguage('xx'));
    expect(t('mcp.start', 'Start {{name}}', { name: 'Files' })).toBe('Files starten');
    await act(() => i18n.changeLanguage('en'));
    expect(t('mcp.start', 'Start {{name}}', { name: 'Files' })).toBe('Start Files');
  });

  it('have an up-to-date English catalogue for translators', () => {
    expect(fs.readFileSync(CATALOG, 'utf8').replace(/\r\n/g, '\n')).toBe(renderCatalog());
  });
});

describe('language choice', () => {
  it("uses the browser's first language we have, else English", () => {
    expect(LANGUAGES).toContain('en');
    expect(pickLanguage(['xx-YY', 'en-GB'])).toBe('en');
    expect(pickLanguage(['zz'])).toBe('en');
    expect(pickLanguage([])).toBe('en');
    expect(pickLanguage(['ar-EG', 'en'])).toBe('ar');
  });
});

/** { "a.b": text } with plural forms ("x_one", "x_few"…) under their base key "x". */
function texts(catalog: Record<string, unknown> = {}, prefix = ''): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [k, v] of Object.entries(catalog)) {
    if (typeof v === 'string') {
      const key = prefix + k.replace(/_(zero|one|two|few|many|other)$/, '');
      out.set(key, [...(out.get(key) ?? []), v]);
    } else {
      for (const [kk, vv] of texts(v as Record<string, unknown>, `${prefix}${k}.`)) out.set(kk, vv);
    }
  }
  return out;
}
const placeholders = (s: string) => s.match(/\{\{[^}]+\}\}/g) ?? [];

describe('translations', () => {
  const others = LANGUAGES.filter((l) => l !== 'en');

  it.each(others)('%s only has texts English has, with its placeholders', (lng) => {
    for (const ns of ['common', 'shared'] as const) {
      const english = texts(resources.en[ns]);
      for (const [key, values] of texts(resources[lng][ns])) {
        expect(english.has(key), `${lng} ${ns}: "${key}" is not in English`).toBe(true);
        const allowed = new Set(english.get(key)!.flatMap(placeholders));
        for (const p of values.flatMap(placeholders)) expect(allowed, `${lng} ${ns}: ${key} has ${p}`).toContain(p);
      }
    }
  });

  it('Arabic turns the page right-to-left and uses its plural forms', async () => {
    await act(() => i18n.changeLanguage('ar'));
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar');
    expect(i18n.t('nav.tagCount', { count: 2 })).toBe('محادثتان');
    expect(i18n.t('nav.tagCount', { count: 3 })).toBe('3 محادثات');
    expect(i18n.t('nav.tagCount', { count: 11 })).toBe('11 محادثة');
    const { t } = await import('@/i18n');
    expect(t('common.cancel', 'Cancel')).toBe('إلغاء');

    await act(() => i18n.changeLanguage('en'));
    expect(document.documentElement.dir).toBe('ltr');
  });
});

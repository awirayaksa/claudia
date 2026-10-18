/**
 * Every string the web app shows goes through react-i18next:
 * - `common`: the web client's own strings (locales/<lang>.json);
 * - `shared`: the components shared with the desktop app (locales/<lang>.shared.json,
 *   generated in English by `node scripts/shared-strings.mjs`), plugged into their
 *   `t()` with setTranslator.
 * A language is offered once its <lang>.json exists; the browser's preferred
 * languages pick it, English otherwise. Missing strings fall back to English.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { setTranslator } from '@/i18n';

export const defaultNS = 'common';

type Catalog = Record<string, unknown>;
const files = import.meta.glob<Catalog>('./locales/*.json', { eager: true, import: 'default' });

/** { en: { common, shared }, … } from the files present. */
export const resources: Record<string, { common?: Catalog; shared?: Catalog }> = {};
for (const [file, catalog] of Object.entries(files)) {
  const m = /\/([A-Za-z-]+?)(\.shared)?\.json$/.exec(file);
  if (!m) continue;
  (resources[m[1]] ??= {})[m[2] ? 'shared' : 'common'] = catalog;
}
export const LANGUAGES = Object.keys(resources).filter((lng) => resources[lng].common);

/** The first of the browser's languages we have ("pt-BR" also matches "pt"). */
export function pickLanguage(preferred: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages): string {
  for (const lang of preferred) {
    if (LANGUAGES.includes(lang)) return lang;
    const base = lang.split('-')[0];
    if (LANGUAGES.includes(base)) return base;
  }
  return 'en';
}

void i18n.use(initReactI18next).init({
  resources,
  lng: pickLanguage(),
  fallbackLng: 'en',
  ns: ['common', 'shared'],
  defaultNS,
  interpolation: { escapeValue: false }, // React escapes
  returnNull: false,
});

// Shared components: their English text is the default, so a missing translation shows English
const shared = (key: string, english: string, vars?: Record<string, string | number>) =>
  i18n.t(key, { ns: 'shared', defaultValue: english, ...vars });
setTranslator(shared);
i18n.on('languageChanged', () => {
  document.documentElement.lang = i18n.language;
  setTranslator(shared);
});

export default i18n;

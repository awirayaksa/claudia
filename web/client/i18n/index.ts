/**
 * Every string the web app shows goes through react-i18next:
 * - `common`: the web client's own strings (locales/<lang>.json);
 * - `shared`: the components shared with the desktop app (locales/<lang>.shared.json,
 *   generated in English by `node scripts/shared-strings.mjs`), plugged into their
 *   `t()` with setTranslator.
 * A language is offered once its <lang>.json exists. The user's choice (the
 * language menu, saved in their settings and in this browser) picks it, else the
 * browser's preferred languages, else English. Missing strings fall back to English.
 * Right-to-left languages (Arabic) set dir="rtl" on the page.
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

/** A language's name in itself ("English", "العربية"). */
export function languageName(lng: string): string {
  try {
    return new Intl.DisplayNames([lng], { type: 'language' }).of(lng) ?? lng;
  } catch {
    return lng;
  }
}

// This browser's copy of the user's choice, so the sign-in screen and the first paint use it
const STORAGE_KEY = 'claudia.language';

/** The language the user chose, or null to follow the browser. */
export function languageChoice(): string | null {
  try {
    const lng = localStorage.getItem(STORAGE_KEY);
    return lng && LANGUAGES.includes(lng) ? lng : null;
  } catch {
    return null;
  }
}

const choiceListeners = new Set<() => void>();

/** Call `listener` whenever the choice changes (it can change without the language changing). */
export function subscribeLanguageChoice(listener: () => void): () => void {
  choiceListeners.add(listener);
  return () => choiceListeners.delete(listener);
}

/** Switch to `lng` (null: follow the browser) and remember it in this browser. */
export function setLanguageChoice(lng: string | null): void {
  const choice = lng && LANGUAGES.includes(lng) ? lng : null;
  try {
    if (choice) localStorage.setItem(STORAGE_KEY, choice);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked: the choice still applies until the page is reloaded
  }
  void i18n.changeLanguage(choice ?? pickLanguage());
  for (const l of choiceListeners) l();
}

void i18n.use(initReactI18next).init({
  resources,
  lng: languageChoice() ?? pickLanguage(),
  fallbackLng: 'en',
  ns: ['common', 'shared'],
  defaultNS,
  interpolation: { escapeValue: false }, // React escapes
  returnNull: false,
});

// Shared components: their English text is the default, so a missing translation shows English
const shared = (key: string, english: string, vars?: Record<string, string | number>) =>
  i18n.t(key, { ns: 'shared', defaultValue: english, ...vars });
function applyLanguage() {
  document.documentElement.lang = i18n.language;
  // Arabic and other right-to-left languages mirror the layout (the classes are logical: ms-, ps-, start-, text-start…)
  document.documentElement.dir = i18n.dir();
  setTranslator(shared);
}
// init has already picked the language (the resources are bundled), so apply it now too
applyLanguage();
i18n.on('languageChanged', applyLanguage);

export default i18n;

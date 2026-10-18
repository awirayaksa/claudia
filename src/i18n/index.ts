/**
 * Translations for the components shared by the desktop and web apps.
 *
 * Every user-visible string goes through `t(key, english, vars)`: the
 * English text stays next to the code that shows it, and the key names it
 * for translators. Without a translator (the desktop app today) `t` returns
 * the English text. The web app plugs in i18next with `setTranslator`, so the
 * same components follow the user's language; `useT` re-renders them when it
 * changes. Placeholders are written {{name}}.
 */
import { useSyncExternalStore } from 'react';

export type TranslationVars = Record<string, string | number>;
export type Translator = (key: string, english: string, vars?: TranslationVars) => string;

export function interpolate(text: string, vars?: TranslationVars): string {
  if (!vars) return text;
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

const english: Translator = (_key, text, vars) => interpolate(text, vars);

let translator: Translator = english;
let version = 0;
const listeners = new Set<() => void>();

/** Use `fn` for every shared string from now on (null: back to English). */
export function setTranslator(fn: Translator | null): void {
  translator = fn ?? english;
  version++;
  for (const l of listeners) l();
}

/** The text for `key` in the current language; `english` when there is no translation. */
export function t(key: string, englishText: string, vars?: TranslationVars): string {
  return translator(key, englishText, vars);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `t`, re-rendering the component when the language changes. */
export function useT(): typeof t {
  useSyncExternalStore(subscribe, () => version, () => version);
  return t;
}

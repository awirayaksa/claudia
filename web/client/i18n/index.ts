/**
 * Every string the web app adds goes through react-i18next. English ships
 * first; the shared desktop components are translated later (Phase 6).
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';

export const defaultNS = 'common';
export const resources = { en: { common: en } } as const;

void i18n.use(initReactI18next).init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  defaultNS,
  interpolation: { escapeValue: false }, // React escapes
  returnNull: false,
});

export default i18n;

import { useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useMySettingsQuery, useUpdateMySettingsMutation } from '../api/rtk-api';
import { Menu } from '../components/Menu';
import { GlobeIcon } from '../components/icons';
import { LANGUAGES, languageChoice, languageName, setLanguageChoice, subscribeLanguageChoice } from '../i18n';

/** The globe button in the sidebar: follow the browser, or one of the languages (saved in the user's settings). */
export function LanguageMenu() {
  const { t } = useTranslation();
  const choice = useSyncExternalStore(subscribeLanguageChoice, languageChoice);
  const [save] = useUpdateMySettingsMutation();
  const choose = (lng: string | null) => {
    setLanguageChoice(lng);
    void save({ language: lng });
  };
  return (
    <Menu
      label={t('nav.language')}
      trigger={<GlobeIcon />}
      placement="above"
      items={[
        { label: t('nav.languageAuto'), checked: choice === null, onSelect: () => choose(null) },
        ...LANGUAGES.map((lng) => ({ label: languageName(lng), checked: choice === lng, onSelect: () => choose(lng) })),
      ]}
    />
  );
}

/** Follow the language saved in the user's settings (chosen on another device, or before this browser remembered it). */
export function useLanguageSync() {
  const { data } = useMySettingsQuery();
  const saved = data?.settings.language;
  useEffect(() => {
    // Never chosen: keep this browser's choice
    if (saved === undefined) return;
    if (saved !== languageChoice()) setLanguageChoice(saved);
  }, [saved]);
}

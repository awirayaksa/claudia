/**
 * Settings are edited as a draft: changes show right away (the theme, the
 * accent color) but are only stored on Save. Leaving with unsaved changes
 * asks to save or discard them; discarding puts the saved values back.
 *
 * Appearance and preferences are tracked here; a tab whose settings live
 * elsewhere (memory, tool servers) keeps its own changes and registers them
 * with useSettingsSection().
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from 'react-redux';
import { useAppDispatch, useAppSelector, type RootState } from '../../store';
import { setAppearance, setPreferences, type SettingsState } from '../../store/slices/settingsSlice';
import { getPlatform } from '../../platform';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { useT } from '../../i18n';

type Preferences = SettingsState['preferences'];
type Appearance = SettingsState['appearance'];

/** What the settings pages edit. The app icon is stored as soon as it's picked, so it isn't part of the draft. */
const PREFERENCE_KEYS = [
  'temperature',
  'reasoningEffort',
  'showReasoning',
  'showStatistics',
  'visualExplanations',
  'pasteLongTextAsFile',
  'systemPrompt',
  'systemPromptFileName',
  'updateCheckUrl',
] as const satisfies ReadonlyArray<keyof Preferences>;

interface Snapshot {
  theme: Appearance['theme'];
  accentColor?: string;
  appTitle?: string;
  preferences: Partial<Preferences>;
}

function snapshot(settings: SettingsState): Snapshot {
  const preferences: Partial<Preferences> = {};
  for (const k of PREFERENCE_KEYS) (preferences as Record<string, unknown>)[k] = settings.preferences[k];
  return {
    theme: settings.appearance.theme,
    accentColor: settings.appearance.customization?.accentColor,
    appTitle: settings.appearance.customization?.appTitle,
    preferences,
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

interface Extra {
  /** Changes the caller tracks itself (the desktop's API settings). */
  dirty?: boolean;
  save?: () => Promise<boolean>;
  discard?: () => void;
}

/** A tab's own unsaved settings. */
interface Section {
  save: () => Promise<void>;
  discard: () => void;
}

interface SettingsDraftValue {
  dirty: boolean;
  saving: boolean;
  /** Why the last save failed. */
  error: string | null;
  /** Asking to save or discard. */
  prompting: boolean;
  save: () => Promise<boolean>;
  discard: () => void;
  /** Runs `proceed` now, or once the user has saved or discarded their changes; `cancel` if they stay. */
  guard: (proceed: () => void, cancel?: () => void, extra?: Extra) => void;
  register: (id: string, section: Section | null) => void;
  setSectionDirty: (id: string, dirty: boolean) => void;
}

const SettingsDraftContext = createContext<SettingsDraftValue | null>(null);

/** The draft of the settings page around this component, if any. */
export function useSettingsDraft() {
  return useContext(SettingsDraftContext);
}

/** A tab's own settings in the page's draft: Save stores them, Discard (or leaving without saving) drops them. */
export function useSettingsSection(id: string, { dirty, save, discard }: Section & { dirty: boolean }) {
  const draft = useSettingsDraft();
  const register = draft?.register;
  const setSectionDirty = draft?.setSectionDirty;
  const latest = useRef({ save, discard });
  latest.current = { save, discard };
  useEffect(() => {
    register?.(id, { save: () => latest.current.save(), discard: () => latest.current.discard() });
    return () => register?.(id, null);
  }, [id, register]);
  useEffect(() => setSectionDirty?.(id, dirty), [id, dirty, setSectionDirty]);
}

export function SettingsDraftProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const store = useStore<RootState>();
  const dispatch = useAppDispatch();
  const [saved, setSaved] = useState(() => snapshot(store.getState().settings));
  const current = useAppSelector((state) => snapshot(state.settings), same);
  const sections = useRef(new Map<string, Section>());
  const [dirtySections, setDirtySections] = useState<ReadonlySet<string>>(new Set());
  const dirty = !same(saved, current) || dirtySections.size > 0;

  const register = useCallback((id: string, section: Section | null) => {
    if (section) sections.current.set(id, section);
    else {
      sections.current.delete(id);
      setDirtySections((ids) => (ids.has(id) ? new Set([...ids].filter((x) => x !== id)) : ids));
    }
  }, []);
  const setSectionDirty = useCallback((id: string, on: boolean) => {
    setDirtySections((ids) => (ids.has(id) === on ? ids : on ? new Set([...ids, id]) : new Set([...ids].filter((x) => x !== id))));
  }, []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ proceed: () => void; cancel?: () => void; extra?: Extra } | null>(null);

  const save = useCallback(async () => {
    const now = snapshot(store.getState().settings);
    const changedSections = [...dirtySections].map((id) => sections.current.get(id)).filter((x): x is Section => !!x);
    if (same(saved, now) && changedSections.length === 0) return true;
    const platform = getPlatform();
    // Only what changed, so values the user never touched keep following the defaults
    const preferences: Partial<Preferences> = {};
    for (const k of PREFERENCE_KEYS) {
      if (!same(saved.preferences[k], now.preferences[k])) (preferences as Record<string, unknown>)[k] = now.preferences[k];
    }
    const appearance: Partial<Appearance> = {};
    if (saved.theme !== now.theme) appearance.theme = now.theme;
    if (saved.accentColor !== now.accentColor || saved.appTitle !== now.appTitle) {
      // The customization is stored as a whole
      appearance.customization = store.getState().settings.appearance.customization;
    }
    setSaving(true);
    setError(null);
    try {
      if (!same(saved, now)) {
        await platform.config.set({
          ...(Object.keys(appearance).length > 0 ? { appearance } : {}),
          ...(Object.keys(preferences).length > 0 ? { preferences } : {}),
        });
        setSaved(now);
        if ('updateCheckUrl' in preferences) await platform.updater?.restartCheck();
      }
      for (const section of changedSections) await section.save();
      return true;
    } catch (err) {
      console.error('Failed to save settings:', err);
      setError(t('unsaved.saveFailed', "Your changes couldn't be saved. Try again."));
      return false;
    } finally {
      setSaving(false);
    }
  }, [dirtySections, saved, store, t]);

  const discard = useCallback(() => {
    const customization = store.getState().settings.appearance.customization;
    dispatch(
      setAppearance({
        theme: saved.theme,
        customization: { ...customization, accentColor: saved.accentColor, appTitle: saved.appTitle },
      })
    );
    dispatch(setPreferences(saved.preferences));
    for (const id of dirtySections) sections.current.get(id)?.discard();
    setError(null);
  }, [dirtySections, dispatch, saved, store]);

  // Stored settings loaded (the page opened before they arrived, or another profile): they're the saved state
  const loads = useAppSelector((state) => state.settings.loads);
  useEffect(() => setSaved(snapshot(store.getState().settings)), [loads, store]);

  const guard = useCallback<SettingsDraftValue['guard']>(
    (proceed, cancel, extra) => {
      if (!dirty && !extra?.dirty) proceed();
      else setPending({ proceed, cancel, extra });
    },
    [dirty]
  );

  // Closing or reloading the tab
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const stay = () => {
    pending?.cancel?.();
    setPending(null);
  };
  const saveAndGo = async () => {
    if (!pending) return;
    const ok = (pending.extra?.dirty && pending.extra.save ? await pending.extra.save() : true) && (await save());
    if (!ok) return;
    setPending(null);
    pending.proceed();
  };
  const discardAndGo = () => {
    if (!pending) return;
    pending.extra?.discard?.();
    discard();
    setPending(null);
    pending.proceed();
  };

  return (
    <SettingsDraftContext.Provider value={{ dirty, saving, error, prompting: pending !== null, save, discard, guard, register, setSectionDirty }}>
      {children}
      <Modal
        isOpen={pending !== null}
        onClose={stay}
        title={t('unsaved.title', 'Unsaved changes')}
        size="sm"
        footer={
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={stay} disabled={saving}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button variant="secondary" onClick={discardAndGo} disabled={saving} data-testid="unsaved-discard">
              {t('unsaved.discard', 'Discard')}
            </Button>
            <Button variant="primary" onClick={() => void saveAndGo()} disabled={saving} data-testid="unsaved-save">
              {t('unsaved.save', 'Save')}
            </Button>
          </div>
        }
      >
        <p className="text-text-primary">{t('unsaved.message', 'You changed some settings without saving them. Save the changes, or discard them?')}</p>
        {error && <p className="mt-2 text-sm text-error">{error}</p>}
      </Modal>
    </SettingsDraftContext.Provider>
  );
}

/** Save button for the bottom of a settings page: enabled once something changed. */
export function SettingsSaveBar() {
  const t = useT();
  const draft = useSettingsDraft();
  const [savedNotice, setSavedNotice] = useState(false);
  if (!draft) return null;
  const { dirty, saving, error, save } = draft;
  return (
    <div className="sticky bottom-0 flex items-center justify-end gap-3 border-t border-border bg-surface px-5 py-3" data-testid="settings-save-bar">
      <span className={`text-sm ${error ? 'text-error' : 'text-text-secondary'}`} aria-live="polite">
        {error ?? (dirty ? t('unsaved.title', 'Unsaved changes') : savedNotice ? t('unsaved.saved', 'Saved') : '')}
      </span>
      <Button
        size="sm"
        onClick={() => void save().then((ok) => setSavedNotice(ok))}
        disabled={!dirty || saving}
        data-testid="settings-save"
      >
        {t('unsaved.save', 'Save')}
      </Button>
    </div>
  );
}

// @vitest-environment jsdom
/**
 * Settings are a draft until saved: what Save stores, and what leaving
 * with unsaved changes does.
 */
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { createAppStore } from '../../store';
import { setAppearance, setPreferences, settingsLoaded } from '../../store/slices/settingsSlice';
import { setPlatform, type ClaudiaPlatform } from '../../platform';
import { SettingsDraftProvider, SettingsSaveBar, useSettingsDraft } from './SettingsDraft';

const config = { set: vi.fn(async (_c: unknown) => {}), get: vi.fn() };

beforeAll(() => {
  window.matchMedia ??= ((query: string) =>
    ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
});

beforeEach(() => {
  config.set.mockClear();
  setPlatform({ config } as unknown as ClaudiaPlatform);
});
afterEach(cleanup);

let draft: ReturnType<typeof useSettingsDraft>;
function Probe() {
  draft = useSettingsDraft();
  return null;
}

function renderDraft() {
  const store = createAppStore({});
  const view = render(
    <Provider store={store}>
      <SettingsDraftProvider>
        <Probe />
        <SettingsSaveBar />
      </SettingsDraftProvider>
    </Provider>
  );
  return { store, ...view };
}

describe('settings draft', () => {
  it('enables Save after a change and stores only what changed', async () => {
    const { store } = renderDraft();
    const save = screen.getByTestId('settings-save');
    expect(save).toBeDisabled();

    act(() => {
      store.dispatch(setPreferences({ temperature: 0.2 }));
      store.dispatch(setAppearance({ theme: 'dark' }));
    });
    expect(save).toBeEnabled();
    expect(config.set).not.toHaveBeenCalled();

    fireEvent.click(save);
    await waitFor(() => expect(save).toBeDisabled());
    expect(config.set).toHaveBeenCalledWith({ appearance: { theme: 'dark' }, preferences: { temperature: 0.2 } });
    expect(screen.getByTestId('settings-save-bar')).toHaveTextContent('Saved');
  });

  it('asks before leaving with changes: Discard puts the saved values back, Cancel stays', async () => {
    const { store } = renderDraft();
    const before = store.getState().settings;
    act(() => {
      store.dispatch(setAppearance({ theme: 'dark', customization: { accentColor: '#3d7bc9' } }));
      store.dispatch(setPreferences({ systemPrompt: 'Be brief.' }));
    });

    const proceed = vi.fn();
    const cancel = vi.fn();
    act(() => draft!.guard(proceed, cancel));
    expect(screen.getByTestId('unsaved-discard')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Cancel'));
    expect(cancel).toHaveBeenCalled();
    expect(proceed).not.toHaveBeenCalled();
    expect(store.getState().settings.appearance.theme).toBe('dark');

    act(() => draft!.guard(proceed, cancel));
    fireEvent.click(screen.getByTestId('unsaved-discard'));
    expect(proceed).toHaveBeenCalledOnce();
    expect(store.getState().settings.appearance.theme).toBe(before.appearance.theme);
    expect(store.getState().settings.appearance.customization?.accentColor).toBe(before.appearance.customization?.accentColor);
    expect(store.getState().settings.preferences.systemPrompt).toBe(before.preferences.systemPrompt);
    expect(config.set).not.toHaveBeenCalled();
  });

  it('saves from the dialog, then goes on', async () => {
    const { store } = renderDraft();
    act(() => {
      store.dispatch(setPreferences({ visualExplanations: false }));
    });
    const proceed = vi.fn();
    act(() => draft!.guard(proceed));
    fireEvent.click(screen.getByTestId('unsaved-save'));
    await waitFor(() => expect(proceed).toHaveBeenCalledOnce());
    expect(config.set).toHaveBeenCalledWith({ preferences: { visualExplanations: false } });
    expect(draft!.dirty).toBe(false);
  });

  it('goes on at once without changes', () => {
    renderDraft();
    const proceed = vi.fn();
    act(() => draft!.guard(proceed));
    expect(proceed).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('unsaved-discard')).toBeNull();
  });

  it('takes settings loaded after the page opened as the saved ones', () => {
    const { store } = renderDraft();
    act(() => {
      store.dispatch(setPreferences({ temperature: 1.1 }));
      store.dispatch(settingsLoaded());
    });
    expect(draft!.dirty).toBe(false);
    expect(screen.getByTestId('settings-save')).toBeDisabled();
  });
});

// @vitest-environment jsdom
/**
 * Desktop smoke test: the whole app renders on the Electron platform adapter
 * (with a fake preload bridge), loads settings, skills and plugins through it,
 * and opens Settings.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { Provider } from 'react-redux';
import { createElectronStub } from './test/electron-stub';

beforeAll(() => {
  // jsdom gaps the UI relies on
  window.matchMedia ??= ((query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList);
  window.HTMLElement.prototype.scrollIntoView ??= function () {};
  window.HTMLElement.prototype.scrollTo ??= function () {};
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe('desktop app', () => {
  it('starts on the Electron platform and loads its data through it', async () => {
    const electron = createElectronStub();
    electron.config.get = vi.fn(async () => ({
      api: {
        provider: 'custom',
        custom: { baseUrl: 'http://localhost:1', apiKey: 'k', selectedModel: 'test-model' },
        availableModels: ['test-model'],
      },
      appearance: { theme: 'light', customization: { appTitle: 'Smoke Test' } },
    }));
    (window as any).electron = electron;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Suggested prompts try the (unreachable) model and fall back to defaults
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { store } = await import('./store/desktop');
    const { setPlatform } = await import('./platform');
    const { createElectronPlatform } = await import('./platform/electron');
    setPlatform(createElectronPlatform({ getApiConfig: () => store.getState().settings.api, uiAction: vi.fn() }));
    const { default: App } = await import('./App');

    await act(async () => {
      render(
        <Provider store={store}>
          <App />
        </Provider>
      );
    });

    await waitFor(() => expect(store.getState().settings.api.selectedModel).toBe('test-model'));
    expect(electron.skills.list).toHaveBeenCalled();
    expect(electron.plugins.discover).toHaveBeenCalled();
    expect(electron.conversation.list).toHaveBeenCalled();
    // The custom title reached the native window through the platform
    await waitFor(() => expect(electron.window.setTitle).toHaveBeenCalledWith('Smoke Test'));

    // Open Settings from the native menu event, through platform-independent UI
    const openSettings = (electron.onMenuEvent as any).mock.calls.find(
      ([channel]: [string]) => channel === 'menu:open-settings'
    )?.[1];
    expect(openSettings).toBeTypeOf('function');
    await act(async () => openSettings());
    expect(store.getState().ui.settingsOpen).toBe(true);
    expect(await screen.findAllByText(/Settings/i)).not.toHaveLength(0);
    // Renders the whole app; slow when the suite runs in parallel
  }, 20_000);
});

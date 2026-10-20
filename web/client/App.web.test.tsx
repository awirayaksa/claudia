// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { setPlatform, getPlatform } from '@/platform';
import { createWebPlatform, WEB_UI_SANDBOX_PERMISSIONS } from './platform/web.platform';
import { createWebStore } from './store';
import './i18n';
import { App } from './App.web';

beforeAll(() => {
  window.matchMedia ??= ((query: string) =>
    ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) as unknown as MediaQueryList);
  window.HTMLElement.prototype.scrollIntoView ??= function () {};
});

/** Answer API calls from a small route table (a function answers from the request). */
function stubApi(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '');
    const path = url.split('?')[0];
    const route = routes[path];
    const body = typeof route === 'function' ? route(init) : route;
    if (body === undefined) return new Response(JSON.stringify({ error: { code: 'not_found', message: path } }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const auth = { passwordLogin: true, signup: true, ldap: false, sso: [] };

function renderApp() {
  setPlatform(createWebPlatform());
  return render(
    <Provider store={createWebStore()}>
      <App />
    </Provider>
  );
}

describe('web client', () => {
  it('shows sign-in when there is no session', async () => {
    stubApi({ '/api/auth/session': { user: null, auth } });
    renderApp();
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument();
  });

  it('shows the waiting screen to a pending user', async () => {
    stubApi({
      '/api/auth/session': {
        user: { id: 'u', email: 'p@example.com', name: 'P', role: 'pending', hasPassword: true },
        auth,
      },
    });
    renderApp();
    expect(await screen.findByText('Waiting for approval')).toBeInTheDocument();
    expect(screen.getByText(/p@example.com/)).toBeInTheDocument();
  });

  it('opens the chat screen for an approved user, with the shared input', async () => {
    stubApi({
      '/api/auth/session': { user: { id: 'u', email: 'a@example.com', name: 'Ada', role: 'admin', hasPassword: true }, auth },
      '/api/me/settings': { settings: {} },
      '/api/models': { models: [], defaultModel: null },
      '/api/chats': { chats: [] },
      '/api/folders': { folders: [] },
    });
    renderApp();
    expect(await screen.findByText('How can I help?')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/Add a connection in Admin/)).toBeInTheDocument());
    expect(screen.getAllByText('Ada').length).toBeGreaterThan(0);
    expect(screen.getByPlaceholderText('Message Claudia…')).toBeInTheDocument();
  });

  it("follows the language saved in the user's settings, and the sidebar menu changes it", async () => {
    cleanup(); // the earlier screens are still mounted
    let settings: Record<string, unknown> = { language: 'ar' };
    const fetchMock = stubApi({
      '/api/auth/session': { user: { id: 'u', email: 'a@example.com', name: 'Ada', role: 'admin', hasPassword: true }, auth },
      '/api/me/settings': (init?: RequestInit) => {
        if (init?.method === 'PATCH') settings = { ...settings, ...JSON.parse(String(init.body)) };
        return { settings };
      },
      '/api/models': { models: [], defaultModel: null },
      '/api/chats': { chats: [] },
      '/api/folders': { folders: [] },
    });
    renderApp();
    expect(await screen.findByText('كيف يمكنني المساعدة؟')).toBeInTheDocument();
    expect(document.documentElement.dir).toBe('rtl');

    fireEvent.click(screen.getByRole('button', { name: 'اللغة' }));
    expect(screen.getByRole('menuitemradio', { name: 'العربية' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'English' }));
    expect(await screen.findByText('How can I help?')).toBeInTheDocument();
    expect(document.documentElement.dir).toBe('ltr');
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/me/settings', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ language: 'en' }) }))
    );
    expect(localStorage.getItem('claudia.language')).toBe('en');

    // Automatic: back to the browser's language, nothing remembered
    fireEvent.click(screen.getByRole('button', { name: 'Language' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Automatic (browser)' }));
    await waitFor(() => expect(settings.language).toBeNull());
    expect(localStorage.getItem('claudia.language')).toBeNull();
    expect(screen.getByText('How can I help?')).toBeInTheDocument();
  });

  it('saves appearance and preferences with the Save button, and asks before leaving with changes', async () => {
    cleanup();
    let settings: Record<string, any> = { appearance: { theme: 'light' } };
    const patches: unknown[] = [];
    stubApi({
      '/api/auth/session': { user: { id: 'u', email: 'a@example.com', name: 'Ada', role: 'admin', hasPassword: true }, auth },
      '/api/me/settings': (init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          const patch = JSON.parse(String(init.body));
          patches.push(patch);
          settings = { ...settings, appearance: { ...settings.appearance, ...patch.appearance } };
        }
        return { settings };
      },
      '/api/models': { models: [], defaultModel: null },
      '/api/chats': { chats: [] },
      '/api/folders': { folders: [] },
    });
    window.history.pushState({}, '', '/settings');
    renderApp();
    const save = await screen.findByTestId('settings-save');
    // The user's settings arrive after the page opened: nothing to save yet
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('light'));
    expect(save).toBeDisabled();

    // A change shows at once but isn't stored
    fireEvent.click(screen.getByRole('button', { name: /Dark/ }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(save).toBeEnabled();
    expect(patches).toEqual([]);

    // Leaving: Cancel stays, Discard goes and puts the saved theme back
    const leave = () => fireEvent.click(screen.getAllByRole('link').find((a) => a.getAttribute('href') === '/')!);
    leave();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(window.location.pathname).toBe('/settings');
    leave();
    fireEvent.click(await screen.findByTestId('unsaved-discard'));
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(patches).toEqual([]);

    // Saved with the button: only what changed
    window.history.pushState({}, '', '/settings');
    cleanup();
    renderApp();
    fireEvent.click(await screen.findByRole('button', { name: /Dark/ }));
    fireEvent.click(screen.getByTestId('settings-save'));
    await waitFor(() => expect(patches).toEqual([{ appearance: { theme: 'dark' } }]));
    expect(screen.getByTestId('settings-save')).toBeDisabled();
    window.history.pushState({}, '', '/');
  });

  it('keeps the memory switch until Save, and drops it when leaving the tab without saving', async () => {
    cleanup();
    let settings: Record<string, any> = {};
    const patches: unknown[] = [];
    stubApi({
      '/api/auth/session': { user: { id: 'u', email: 'a@example.com', name: 'Ada', role: 'admin', hasPassword: true }, auth },
      '/api/me/settings': (init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          const patch = JSON.parse(String(init.body));
          patches.push(patch);
          settings = { ...settings, ...patch };
        }
        return { settings };
      },
      '/api/me/memories': { memories: [] },
      '/api/models': { models: [], defaultModel: null },
      '/api/chats': { chats: [] },
      '/api/folders': { folders: [] },
    });
    window.history.pushState({}, '', '/settings');
    renderApp();
    fireEvent.click(await screen.findByRole('tab', { name: 'Memory' }));
    const toggle = await screen.findByTestId('memory-enabled');
    await waitFor(() => expect(toggle).toBeChecked());

    // Switched off, then away to another tab: Discard drops it
    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(screen.getByTestId('settings-save')).toBeEnabled();
    fireEvent.click(screen.getByRole('tab', { name: 'Tools' }));
    fireEvent.click(await screen.findByTestId('unsaved-discard'));
    fireEvent.click(await screen.findByRole('tab', { name: 'Memory' }));
    expect(await screen.findByTestId('memory-enabled')).toBeChecked();
    expect(patches).toEqual([]);

    // Saved with the button
    fireEvent.click(screen.getByTestId('memory-enabled'));
    fireEvent.click(screen.getByTestId('settings-save'));
    await waitFor(() => expect(patches).toEqual([{ memory: { enabled: false } }]));
    await waitFor(() => expect(screen.getByTestId('settings-save')).toBeDisabled());
    expect(screen.getByTestId('memory-enabled')).not.toBeChecked();
    window.history.pushState({}, '', '/');
  });

  it('never gives MCP-UI iframes same-origin access', () => {
    setPlatform(createWebPlatform({ sandboxOrigin: 'https://sandbox.example.com/' }));
    const { uiSandbox, capabilities } = getPlatform();
    expect(uiSandbox.sandboxPermissions).toBe(WEB_UI_SANDBOX_PERMISSIONS);
    expect(uiSandbox.sandboxPermissions).not.toContain('allow-same-origin');
    expect(uiSandbox.proxyUrl).toBe('https://sandbox.example.com/mcp-ui-proxy.html');
    expect(capabilities).toMatchObject({ kind: 'web', localFilesystem: false, stdioMcp: false, auth: true });
  });
});

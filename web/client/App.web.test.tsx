// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

/** Answer API calls from a small route table. */
function stubApi(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '');
    const path = url.split('?')[0];
    const body = routes[path];
    if (body === undefined) return new Response(JSON.stringify({ error: { code: 'not_found', message: path } }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const auth = { passwordLogin: true, signup: true, ldap: false };

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

  it('never gives MCP-UI iframes same-origin access', () => {
    setPlatform(createWebPlatform({ sandboxOrigin: 'https://sandbox.example.com/' }));
    const { uiSandbox, capabilities } = getPlatform();
    expect(uiSandbox.sandboxPermissions).toBe(WEB_UI_SANDBOX_PERMISSIONS);
    expect(uiSandbox.sandboxPermissions).not.toContain('allow-same-origin');
    expect(uiSandbox.proxyUrl).toBe('https://sandbox.example.com/mcp-ui-proxy.html');
    expect(capabilities).toMatchObject({ kind: 'web', localFilesystem: false, stdioMcp: false, auth: true });
  });
});

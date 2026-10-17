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
});

describe('web client', () => {
  it('renders the shared desktop chat components on the web platform', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ status: 'ready', database: 'pglite', migrations: { applied: 1, pending: 0 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    setPlatform(createWebPlatform());
    render(
      <Provider store={createWebStore()}>
        <App />
      </Provider>
    );

    // MarkdownRenderer from ../src: heading, table, highlighted code
    expect(await screen.findByRole('heading', { name: 'Shared rendering' })).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText(/Hello from \.\.\/src/)).toBeInTheDocument();
    // ChatMessage from ../src
    expect(screen.getByText('What does Claudia Web reuse from the desktop app?')).toBeInTheDocument();
    // Server readiness through the shared contract
    await waitFor(() => expect(screen.getByTestId('server-status')).toHaveTextContent('ready (pglite, 1 migrations)'));
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

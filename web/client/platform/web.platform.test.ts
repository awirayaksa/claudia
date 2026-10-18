// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createWebPlatform, WEB_UI_SANDBOX_PERMISSIONS } from './web.platform';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('web platform', () => {
  it('renders MCP-UI through the sandbox origin, never same-origin', () => {
    const p = createWebPlatform({ sandboxOrigin: 'https://sandbox.example.net/' });
    expect(p.uiSandbox.proxyUrl).toBe('https://sandbox.example.net/mcp-ui-proxy.html');
    expect(WEB_UI_SANDBOX_PERMISSIONS).not.toContain('allow-same-origin');
    expect(createWebPlatform().uiSandbox.proxyUrl).toBeUndefined();
  });

  it('asks before a destructive UI action and refreshes the chat afterwards', async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (!body.confirmed) {
        return json({ error: { code: 'confirmation_required', message: '"Wipe data" may change or delete data.' } }, 409);
      }
      return json({ result: { tool_call_id: 'c1', role: 'tool', name: 'wipe', content: 'wiped', serverId: 's1' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const confirm = vi.fn(async () => true);
    const onToolResultChanged = vi.fn();
    const p = createWebPlatform({ confirm, onToolResultChanged });

    const result = await p.tools.uiAction({ uri: 'ui://x', toolName: 'wipe', originalToolCallId: 'c1' });
    expect(result).toMatchObject({ content: 'wiped' });
    expect(confirm).toHaveBeenCalledWith('"Wipe data" may change or delete data.');
    expect(bodies).toEqual([
      { uri: 'ui://x', toolName: 'wipe', originalToolCallId: 'c1', params: {}, confirmed: false },
      { uri: 'ui://x', toolName: 'wipe', originalToolCallId: 'c1', params: {}, confirmed: true },
    ]);
    expect(onToolResultChanged).toHaveBeenCalledOnce();
  });

  it('does not run a destructive action the user declines', async () => {
    const fetchMock = vi.fn(async () =>
      json({ error: { code: 'confirmation_required', message: 'Confirm?' } }, 409)
    );
    vi.stubGlobal('fetch', fetchMock);
    const p = createWebPlatform({ confirm: async () => false });
    await expect(p.tools.uiAction({ uri: 'ui://x', toolName: 'wipe', originalToolCallId: 'c1' })).rejects.toThrow('Cancelled.');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('switches tool servers on the server and reports the new state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ server: { id: 'b1', enabled: true, status: 'ready', error: null, tools: [{ name: 'read_file', description: '', inputSchema: {} }] } })
      )
    );
    const onMcpChanged = vi.fn();
    const p = createWebPlatform({ onMcpChanged });
    const statuses: unknown[] = [];
    p.events.on('mcp.statusChanged', (e) => statuses.push(e));
    expect(await p.mcp.startServer('b1')).toEqual({ success: true });
    expect(statuses).toEqual([{ serverId: 'b1', status: 'ready' }]);
    expect(onMcpChanged).toHaveBeenCalledOnce();
  });
});

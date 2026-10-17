/**
 * Web platform: the shared UI talks to the Claudia Web server over HTTP.
 * Endpoints arrive phase by phase; until one exists the call reports
 * "not available" in the usual `{ success: false, error }` shape.
 */
import type {
  ClaudiaPlatform,
  PlatformEvent,
  PlatformEventMap,
  PlatformMCP,
  PlatformPlugins,
  PlatformResult,
  PlatformSkills,
} from '@/platform';
import { apiFetch } from '../api/http';

const notAvailable = (what: string) => async (): Promise<PlatformResult> => ({
  success: false,
  error: `${what} is not available in Claudia Web yet.`,
});

/**
 * MCP-UI resources render with scripts but never with same-origin access to
 * the app. (The desktop value includes allow-same-origin; see web/PLAN.md.)
 */
export const WEB_UI_SANDBOX_PERMISSIONS = 'allow-scripts allow-forms allow-popups';

type Listener = (data: unknown) => void;

/** In-page event bus; the WebSocket gateway publishes into it (Phase 1). */
export class PlatformEventBus {
  private listeners = new Map<PlatformEvent, Set<Listener>>();

  on<E extends PlatformEvent>(event: E, cb: (data: PlatformEventMap[E]) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(cb as Listener);
    this.listeners.set(event, set);
    return () => set.delete(cb as Listener);
  }

  emit<E extends PlatformEvent>(event: E, data: PlatformEventMap[E]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(data);
  }
}

export interface WebPlatformOptions {
  /** Origin that serves the sandbox pages (CLAUDIA_SANDBOX_ORIGIN). */
  sandboxOrigin?: string;
  events?: PlatformEventBus;
}

export function createWebPlatform(opts: WebPlatformOptions = {}): ClaudiaPlatform {
  const events = opts.events ?? new PlatformEventBus();

  const mcp: PlatformMCP = {
    startServer: notAvailable('MCP'),
    stopServer: notAvailable('MCP'),
    restartServer: notAvailable('MCP'),
    restartWithBuiltinConfig: notAvailable('MCP'),
    getServerStatus: notAvailable('MCP'),
    getLogs: notAvailable('MCP'),
    clearLogs: notAvailable('MCP'),
    listConfigs: async () => ({ success: true, servers: {} }),
    getConfig: notAvailable('MCP'),
    saveConfig: notAvailable('MCP'),
    deleteConfig: notAvailable('MCP'),
    listTools: notAvailable('MCP'),
    callTool: notAvailable('MCP'),
    listResources: notAvailable('MCP'),
    readResource: notAvailable('MCP'),
    listPrompts: notAvailable('MCP'),
    getPrompt: notAvailable('MCP'),
  };

  const plugins: PlatformPlugins = {
    discover: async () => ({ success: true, plugins: [] }),
    load: notAvailable('Plugins'),
    unload: notAvailable('Plugins'),
    reload: notAvailable('Plugins'),
    enable: notAvailable('Plugins'),
    disable: notAvailable('Plugins'),
    list: async () => ({ success: true, configs: {} }),
    getConfig: notAvailable('Plugins'),
    updateConfig: notAvailable('Plugins'),
    getSettings: notAvailable('Plugins'),
    setSettings: notAvailable('Plugins'),
    getStatus: notAvailable('Plugins'),
    getActiveExtensions: async () => ({ success: true, extensions: [] }),
    getActiveReplacement: async () => ({ success: true, replacement: null }),
  };

  const skills: PlatformSkills = {
    list: async () => ({ success: true, skills: [] }),
    get: notAvailable('Skills'),
    create: notAvailable('Skills'),
    update: notAvailable('Skills'),
    delete: notAvailable('Skills'),
  };

  return {
    capabilities: {
      kind: 'web',
      windowControls: false,
      nativeMenu: false,
      autoUpdate: false,
      appIcon: false,
      localFilesystem: false,
      stdioMcp: false,
      diskPlugins: false,
      auth: true,
      profiles: false,
    },
    config: {
      // Per-user appearance and preferences, stored on the server
      get: async () => {
        try {
          return (await apiFetch<{ settings: Record<string, unknown> }>('/api/me/settings')).settings;
        } catch {
          return {};
        }
      },
      set: async (config: { appearance?: unknown; preferences?: unknown }) => {
        const patch: Record<string, unknown> = {};
        if (config.appearance) patch.appearance = config.appearance;
        if (config.preferences) patch.preferences = config.preferences;
        if (Object.keys(patch).length > 0) {
          await apiFetch('/api/me/settings', { method: 'PATCH', json: patch });
        }
      },
    },
    mcp,
    plugins,
    skills,
    tools: {
      uiAction: async () => {
        throw new Error('MCP-UI actions are not available in Claudia Web yet.');
      },
    },
    llm: {
      complete: async (req) => {
        const res = await apiFetch<{ text: string }>('/api/llm/complete', {
          method: 'POST',
          json: { model: req.model, messages: req.messages, temperature: req.temperature, maxTokens: req.maxTokens },
          signal: req.signal,
        });
        req.onChunk?.(res.text);
        return res.text;
      },
    },
    files: {
      upload: async () => {
        throw new Error('Uploads are not available in Claudia Web yet.');
      },
    },
    events: { on: (event, cb) => events.on(event, cb) },
    uiSandbox: {
      sandboxPermissions: WEB_UI_SANDBOX_PERMISSIONS,
      proxyUrl: opts.sandboxOrigin ? `${opts.sandboxOrigin.replace(/\/+$/, '')}/mcp-ui-proxy.html` : undefined,
    },
  };
}

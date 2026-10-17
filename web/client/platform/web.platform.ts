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
  UIActionRequest,
} from '@/platform';
import type { Attachment, ToolResult } from '@/types/message.types';
import type { SkillOperationResult } from '@/types/skill.types';
import type { FileView } from '@shared/files';
import type { McpServerView, UIActionResponse } from '@shared/mcp';
import { apiFetch, apiFetchRaw, csrfToken, refreshSession, toApiError } from '../api/http';

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
  /** A tool server was switched on or off. */
  onMcpChanged?: () => void;
  /** An MCP-UI action replaced a stored tool result. */
  onToolResultChanged?: () => void;
  /** Ask before a destructive tool runs (default: window.confirm). */
  confirm?: (message: string) => Promise<boolean>;
}

/**
 * Upload one file (multipart, with progress) and wait for its text to be
 * extracted. Files the server can't read are refused with its reason.
 */
export function uploadFile(file: File, onProgress?: (percent: number) => void): Promise<Attachment> {
  const attempt = () =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/files');
      xhr.withCredentials = true;
      const token = csrfToken();
      if (token) xhr.setRequestHeader('X-Claudia-CSRF', token);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
      xhr.onerror = () => reject(new Error('Upload failed: network error.'));
      const form = new FormData();
      form.append('file', file, file.name);
      xhr.send(form);
    });

  return (async () => {
    let res = await attempt();
    // Expired access token: refresh once and retry, like apiFetch
    if (res.status === 401 && (await refreshSession())) res = await attempt();
    let parsed: { file?: FileView; error?: { message?: string } } = {};
    try {
      parsed = JSON.parse(res.body);
    } catch {
      /* not JSON */
    }
    if (res.status !== 201 || !parsed.file) throw new Error(parsed.error?.message ?? `Upload failed (HTTP ${res.status}).`);
    const f = parsed.file;
    if (f.status !== 'ready') throw new Error(`${f.name}: ${f.error ?? 'the file could not be read.'}`);
    return {
      id: f.id,
      type: f.mime.startsWith('image/') ? 'image' : 'file',
      name: f.name,
      size: f.size,
      mimeType: f.mime,
      ...(f.textTruncated ? { textTruncated: true } : {}),
    };
  })();
}

export function createWebPlatform(opts: WebPlatformOptions = {}): ClaudiaPlatform {
  const events = opts.events ?? new PlatformEventBus();

  /**
   * Tool servers run on the server. "Start"/"stop" here switch a server on or
   * off for this user; useMcpSync mirrors the server's list into the mcp slice.
   */
  const setServer = async (serverId: string, enabled: boolean): Promise<PlatformResult> => {
    try {
      const { server } = await apiFetch<{ server: McpServerView }>(
        `/api/mcp/servers/${encodeURIComponent(serverId)}/${enabled ? 'enable' : 'disable'}`,
        { method: 'POST' }
      );
      events.emit('mcp.statusChanged', {
        serverId,
        status: server.enabled ? server.status : 'stopped',
        ...(server.error ? { error: server.error } : {}),
      });
      events.emit('mcp.toolsUpdated', { serverId, tools: server.enabled ? server.tools : [] });
      opts.onMcpChanged?.();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const mcp: PlatformMCP = {
    startServer: (id) => setServer(id, true),
    stopServer: (id) => setServer(id, false),
    restartServer: async (id) => {
      const off = await setServer(id, false);
      return off.success ? setServer(id, true) : off;
    },
    restartWithBuiltinConfig: notAvailable('Built-in server settings'),
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

  // The server answers in the desktop's `{ success, skill(s) }` shape
  const skillCall = async (path: string, init: { method?: string; json?: unknown } = {}): Promise<SkillOperationResult> => {
    try {
      const result = await apiFetch<SkillOperationResult>(`/api/skills${path}`, init);
      if (init.method && init.method !== 'GET') {
        const list = await apiFetch<SkillOperationResult>('/api/skills');
        if (list.skills) events.emit('skill.changed', list.skills);
      }
      return result;
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
  const skills: PlatformSkills = {
    list: () => skillCall(''),
    get: (id) => skillCall(`/${encodeURIComponent(id)}`),
    create: (payload) => skillCall('', { method: 'POST', json: payload }),
    update: (payload) => skillCall(`/${encodeURIComponent(payload.id)}`, { method: 'PUT', json: payload }),
    delete: (id) => skillCall(`/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  };

  /** Run a tool for an MCP-UI resource; destructive tools ask first. */
  const uiAction = async (req: UIActionRequest): Promise<ToolResult> => {
    const send = (confirmed: boolean) =>
      apiFetchRaw('/api/tools/ui-action', { method: 'POST', json: { ...req, params: req.params ?? {}, confirmed } });
    let res = await send(false);
    if (res.status === 409) {
      const err = await toApiError(res);
      if (err.code !== 'confirmation_required') throw err;
      const ok = await (opts.confirm ?? ((m: string) => Promise.resolve(window.confirm(m))))(err.message);
      if (!ok) throw new Error('Cancelled.');
      res = await send(true);
    }
    if (!res.ok) throw await toApiError(res);
    const { result } = (await res.json()) as UIActionResponse;
    opts.onToolResultChanged?.();
    return result;
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
    tools: { uiAction },
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
      // Images go to the server too: the model reads every attachment from there
      handlesImages: true,
      upload: uploadFile,
    },
    events: { on: (event, cb) => events.on(event, cb) },
    uiSandbox: {
      sandboxPermissions: WEB_UI_SANDBOX_PERMISSIONS,
      proxyUrl: opts.sandboxOrigin ? `${opts.sandboxOrigin.replace(/\/+$/, '')}/mcp-ui-proxy.html` : undefined,
    },
  };
}

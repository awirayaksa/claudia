/**
 * Desktop platform: a thin pass-through over the preload bridge
 * (`window.electron`). This is the only shared-code file that touches it.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Attachment, ToolResult } from '../types/message.types';
import type { ClaudiaPlatform, LLMCompleteRequest, PlatformEvent, PlatformEventMap, UIActionRequest } from './types';
import { providerFromConfig, type APISettings } from '../services/api/provider.service';
import { OpenWebUIService } from '../services/api/openWebUI.service';

export interface ElectronPlatformDeps {
  /** Current API settings (the desktop store's `settings.api`). */
  getApiConfig: () => APISettings;
  /** Run an MCP-UI tool action (the desktop chat slice's `executeUIAction`). */
  uiAction: (req: UIActionRequest) => Promise<ToolResult>;
}

/**
 * Today's MCP-UI iframe permissions, unchanged. See "Known issues" in
 * web/PLAN.md: allow-same-origin with allow-scripts lets inline content reach
 * the parent page. The web platform must not reuse this value.
 */
const DESKTOP_UI_SANDBOX = 'allow-scripts allow-forms allow-same-origin allow-popups';

const MENU_CHANNELS: Record<string, string> = {
  'menu.openSettings': 'menu:open-settings',
  'menu.toggleSidebar': 'menu:toggle-sidebar',
  'menu.newConversation': 'menu:new-conversation',
  'menu.about': 'menu:about',
};

function subscribe<E extends PlatformEvent>(event: E, cb: (data: PlatformEventMap[E]) => void): () => void {
  const e = window.electron;
  const any = cb as (data: any) => void;
  switch (event) {
    case 'mcp.statusChanged':
      return e.mcp.onServerStatusChanged(any);
    case 'mcp.toolsUpdated':
      return e.mcp.onServerToolsUpdated(any);
    case 'mcp.resourcesUpdated':
      return e.mcp.onServerResourcesUpdated(any);
    case 'mcp.promptsUpdated':
      return e.mcp.onServerPromptsUpdated(any);
    case 'mcp.error':
      return e.mcp.onServerError(any);
    case 'plugin.statusChanged':
      return e.plugins.onStatusChanged(any);
    case 'plugin.error':
      return e.plugins.onError(any);
    case 'plugin.discovered':
      return e.plugins.onDiscovered(any);
    case 'plugin.changed':
      return e.plugins.onChanged(any);
    case 'skill.changed':
      return e.skills.onChanged(any);
    default: {
      const channel = MENU_CHANNELS[event];
      if (!channel) throw new Error(`Unknown platform event: ${event}`);
      return e.onMenuEvent(channel, () => any(undefined)) ?? (() => {});
    }
  }
}

/** Open WebUI credentials from the provider config or the legacy top-level fields. */
function openWebUICredentials(api: APISettings): { baseUrl: string; apiKey: string } | null {
  if (api.provider !== 'openwebui') return null;
  const baseUrl = api.openwebui?.baseUrl || api.baseUrl;
  const apiKey = api.openwebui?.apiKey || api.apiKey;
  return baseUrl && apiKey ? { baseUrl, apiKey } : null;
}

/**
 * Turn a picked file into an attachment the model can read.
 * - Open WebUI: upload it; its id is sent with the request and Open WebUI does retrieval.
 * - Every other provider: the main process extracts the text, which is inlined.
 */
async function uploadFile(api: APISettings, file: File, onProgress?: (percent: number) => void): Promise<Attachment> {
  const base: Attachment = {
    id: uuidv4(),
    type: file.type.startsWith('image/') ? 'image' : 'file',
    name: file.name,
    size: file.size,
    mimeType: file.type,
  };

  const owui = openWebUICredentials(api);
  if (owui) {
    const uploadedId = await new OpenWebUIService(owui.baseUrl, owui.apiKey).uploadFile(file, onProgress);
    return {
      ...base,
      url: `${owui.baseUrl.replace(/\/+$/, '')}/api/v1/files/${uploadedId}`,
      remoteFileId: uploadedId,
    };
  }

  onProgress?.(0);
  const result = await window.electron.file.extractText({
    name: file.name,
    mimeType: file.type,
    data: new Uint8Array(await file.arrayBuffer()),
  });
  if (!result.success) {
    throw new Error(result.error || `Could not read ${file.name}`);
  }
  onProgress?.(100);
  return { ...base, extractedText: result.text ?? '', textTruncated: result.truncated || undefined };
}

async function complete(api: APISettings, req: LLMCompleteRequest): Promise<string> {
  const provider = providerFromConfig(api);
  const request = {
    model: req.model,
    messages: req.messages,
    temperature: req.temperature,
    max_tokens: req.maxTokens,
  };

  if (!req.onChunk) {
    const response = await provider.chatCompletion({ ...request, stream: false });
    const content = response.choices[0]?.message?.content;
    return typeof content === 'string' ? content : '';
  }

  const onChunk = req.onChunk;
  let text = '';
  await new Promise<void>((resolve, reject) => {
    provider.streamChatCompletion(
      request,
      {
        onChunk: (chunk) => {
          text += chunk;
          onChunk(chunk);
        },
        onComplete: () => resolve(),
        onError: (error) => reject(error),
      },
      req.signal
    );
  });
  return text;
}

export function createElectronPlatform(deps: ElectronPlatformDeps): ClaudiaPlatform {
  const e = window.electron;
  return {
    capabilities: {
      kind: 'electron',
      windowControls: true,
      nativeMenu: true,
      autoUpdate: true,
      appIcon: true,
      localFilesystem: true,
      stdioMcp: true,
      diskPlugins: true,
      auth: false,
      profiles: true,
    },
    config: e.config,
    mcp: e.mcp,
    plugins: e.plugins,
    skills: e.skills,
    profiles: e.profile,
    window: e.window,
    updater: e.updater,
    icon: e.icon,
    systemPrompt: e.systemPrompt,
    tools: { uiAction: deps.uiAction },
    llm: { complete: (req) => complete(deps.getApiConfig(), req) },
    files: { upload: (file, onProgress) => uploadFile(deps.getApiConfig(), file, onProgress) },
    events: { on: subscribe },
    uiSandbox: { sandboxPermissions: DESKTOP_UI_SANDBOX },
  };
}

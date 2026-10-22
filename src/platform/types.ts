/**
 * Platform adapter contract.
 *
 * Code shared by the desktop app and Claudia Web talks to its host only
 * through `getPlatform()`. Desktop wraps `window.electron`; the web app
 * implements the same contract over HTTP.
 *
 * Methods keep the preload's `{ success, data, error }`-style return shapes
 * so callers stay unchanged.
 */
import type { Attachment, ToolResult } from '../types/message.types';
import type { ChatMessage } from '../types/api.types';
import type {
  MCPServerErrorEvent,
  MCPServerPromptsUpdatedEvent,
  MCPServerResourcesUpdatedEvent,
  MCPServerStatusChangedEvent,
  MCPServerToolsUpdatedEvent,
} from '../types/mcp.types';
import type { Skill, SkillOperationResult, SkillWritePayload } from '../types/skill.types';
import type { PluginStatus } from '../types/plugin.types';

/** What the host can do. Shared UI hides features the host lacks. */
export interface PlatformCapabilities {
  kind: 'electron' | 'web';
  /** Custom title bar buttons (minimize / maximize / close). */
  windowControls: boolean;
  /** Native application menu. */
  nativeMenu: boolean;
  autoUpdate: boolean;
  /** Changing the app / tray icon. */
  appIcon: boolean;
  /** Direct access to the user's disk (@file mentions, working directory). */
  localFilesystem: boolean;
  /** stdio MCP servers can be configured from the UI. */
  stdioMcp: boolean;
  /** Plugins installed from a local folder. */
  diskPlugins: boolean;
  /** Users sign in. */
  auth: boolean;
  /** Settings profiles. */
  profiles: boolean;
}

/** Result shape most host calls already use. */
export interface PlatformResult {
  success: boolean;
  error?: string;
  [key: string]: any;
}

export interface PlatformConfig {
  get(): Promise<any>;
  set(config: any): Promise<void>;
}

export interface PlatformMCP {
  startServer(serverId: string): Promise<PlatformResult>;
  stopServer(serverId: string): Promise<PlatformResult>;
  restartServer(serverId: string): Promise<PlatformResult>;
  restartWithBuiltinConfig(serverId: string, builtinConfig: Record<string, unknown>): Promise<PlatformResult>;
  getServerStatus(serverId: string): Promise<PlatformResult>;
  getLogs(serverId: string): Promise<PlatformResult>;
  clearLogs(serverId: string): Promise<PlatformResult>;
  listConfigs(): Promise<PlatformResult>;
  getConfig(serverId: string): Promise<PlatformResult>;
  saveConfig(config: any): Promise<PlatformResult>;
  deleteConfig(serverId: string): Promise<PlatformResult>;
  listTools(serverId: string): Promise<PlatformResult>;
  callTool(serverId: string, toolName: string, args: any, traceId?: string): Promise<PlatformResult>;
  listResources(serverId: string): Promise<PlatformResult>;
  readResource(serverId: string, uri: string): Promise<PlatformResult>;
  listPrompts(serverId: string): Promise<PlatformResult>;
  getPrompt(serverId: string, promptName: string, args?: Record<string, string>): Promise<PlatformResult>;
  /** Desktop only: import servers from Claude Desktop's config file. */
  importClaudeDesktop?(): Promise<PlatformResult>;
}

export interface PlatformPlugins {
  discover(): Promise<PlatformResult>;
  load(pluginId: string): Promise<PlatformResult>;
  unload(pluginId: string): Promise<PlatformResult>;
  reload(pluginId: string): Promise<PlatformResult>;
  enable(pluginId: string): Promise<PlatformResult>;
  disable(pluginId: string): Promise<PlatformResult>;
  list(): Promise<PlatformResult>;
  getConfig(pluginId: string): Promise<PlatformResult>;
  updateConfig(pluginId: string, updates: any): Promise<PlatformResult>;
  getSettings(pluginId: string): Promise<PlatformResult>;
  setSettings(pluginId: string, settings: any): Promise<PlatformResult>;
  getStatus(pluginId: string): Promise<PlatformResult>;
  getActiveExtensions(): Promise<PlatformResult>;
  getActiveReplacement(): Promise<PlatformResult>;
  /** Desktop only: the folder plugins are discovered from. */
  getLocalPluginsDir?(): Promise<PlatformResult>;
}

export interface PlatformSkills {
  list(): Promise<SkillOperationResult>;
  get(id: string): Promise<SkillOperationResult>;
  create(payload: SkillWritePayload): Promise<SkillOperationResult>;
  update(payload: SkillWritePayload): Promise<SkillOperationResult>;
  delete(id: string): Promise<SkillOperationResult>;
  /** Desktop only: the folder skills are stored in. */
  getDir?(): Promise<SkillOperationResult>;
  openDir?(): Promise<SkillOperationResult>;
}

/** An action raised by an MCP-UI resource that asks to run a tool. */
export interface UIActionRequest {
  uri: string;
  toolName: string;
  params?: Record<string, unknown>;
  /** The tool call whose result rendered the UI resource. */
  originalToolCallId: string;
}

export interface PlatformTools {
  uiAction(req: UIActionRequest): Promise<ToolResult>;
}

/** A one-off model call outside the chat (titles, suggestions, Explain/Ask). */
export interface LLMCompleteRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** When set, the reply is streamed and each piece is passed here. */
  onChunk?: (chunk: string) => void;
}

export interface PlatformLLM {
  /** Resolves with the full reply text. */
  complete(req: LLMCompleteRequest): Promise<string>;
}

export interface PlatformFiles {
  /** Turn a picked file into an attachment the model can read. */
  upload(file: File, onProgress?: (percent: number) => void): Promise<Attachment>;
  /**
   * Images go through `upload` as well (web: the server keeps every
   * attachment). Otherwise they're inlined as base64 by the composer.
   */
  handlesImages?: boolean;
  /** Native file picker, where the host has one. */
  pick?(): Promise<File[]>;
  /** Desktop: open a file a built-in tool wrote, in its default app. */
  openLocal?(path: string): Promise<void>;
  /** Desktop: show that file in the system file manager. */
  revealLocal?(path: string): Promise<void>;
}

/** Host events shared code can subscribe to. */
export interface PlatformEventMap {
  'mcp.statusChanged': MCPServerStatusChangedEvent;
  'mcp.toolsUpdated': MCPServerToolsUpdatedEvent;
  'mcp.resourcesUpdated': MCPServerResourcesUpdatedEvent;
  'mcp.promptsUpdated': MCPServerPromptsUpdatedEvent;
  'mcp.error': MCPServerErrorEvent;
  'plugin.statusChanged': { pluginId?: string; status?: PluginStatus; error?: string };
  'plugin.error': { pluginId?: string; error?: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  'plugin.discovered': any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  'plugin.changed': any;
  'skill.changed': Skill[];
  'menu.openSettings': void;
  'menu.toggleSidebar': void;
  'menu.newConversation': void;
  'menu.about': void;
}

export type PlatformEvent = keyof PlatformEventMap;

export interface PlatformEvents {
  /** Subscribe; returns the unsubscribe function. */
  on<E extends PlatformEvent>(event: E, cb: (data: PlatformEventMap[E]) => void): () => void;
}

/** iframe settings for MCP-UI resources. */
export interface PlatformUISandbox {
  sandboxPermissions: string;
  /** mcp-ui proxy page on a separate origin (web). */
  proxyUrl?: string;
}

export interface PlatformProfiles {
  list(): Promise<{ profiles: any[]; currentProfileId: string }>;
  switch(id: string): Promise<any>;
  create(payload: { name: string; cloneCurrent: boolean }): Promise<any>;
  rename(id: string, name: string): Promise<void>;
  duplicate(id: string, newName: string): Promise<any>;
  delete(id: string): Promise<void>;
}

export interface PlatformWindow {
  setTitle(title: string): Promise<void>;
  setBackgroundColor(color: string): Promise<void>;
  minimize(): Promise<void>;
  maximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  showMenu(x: number, y: number): Promise<void>;
}

export interface PlatformUpdater {
  check(): Promise<any>;
  getStatus(): Promise<any>;
  relaunch(): Promise<void>;
  restartCheck(): Promise<void>;
}

export interface PlatformIcon {
  select(): Promise<string | null>;
  upload(sourcePath: string): Promise<string>;
  apply(iconPath: string): Promise<{ success: boolean; requiresRestart: boolean }>;
  reset(): Promise<void>;
  getPreview(iconPath: string): Promise<string | null>;
}

export interface PlatformSystemPrompt {
  selectFile(): Promise<{ content: string; fileName: string } | null>;
}

export interface ClaudiaPlatform {
  capabilities: PlatformCapabilities;
  config: PlatformConfig;
  mcp: PlatformMCP;
  plugins: PlatformPlugins;
  skills: PlatformSkills;
  tools: PlatformTools;
  llm: PlatformLLM;
  files: PlatformFiles;
  events: PlatformEvents;
  uiSandbox: PlatformUISandbox;
  profiles?: PlatformProfiles;
  window?: PlatformWindow;
  updater?: PlatformUpdater;
  icon?: PlatformIcon;
  systemPrompt?: PlatformSystemPrompt;
}

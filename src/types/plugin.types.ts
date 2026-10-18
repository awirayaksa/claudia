import { ComponentType, ReactNode } from 'react';
import type { Plugin as UnifiedPlugin } from 'unified';
import type { Message } from './message.types';
import type { ClaudiaPlatform } from '../platform/types';

// ============================================================================
// Plugin Manifest
// ============================================================================

/**
 * Plugin manifest schema - defines plugin metadata and configuration.
 * Can be specified in plugin.json (local plugins) or package.json claudia field (npm).
 */
export interface PluginManifest {
  /** Unique plugin identifier (npm package name or local folder name) */
  id: string;

  /** Display name */
  name: string;

  /** SemVer version */
  version: string;

  /** Plugin description */
  description?: string;

  /** Plugin author */
  author?: string;

  /** Plugin homepage URL */
  homepage?: string;

  /** Plugin license */
  license?: string;

  /** Plugin type determines loading and rendering behavior */
  type: 'renderer-extension' | 'renderer-replacement';

  /** Entry point relative to plugin root (e.g., "dist/index.js") */
  main: string;

  /** Renderer-specific configuration */
  renderer?: {
    /** For extension plugins: priority determines order (lower = earlier). Default: 100 */
    priority?: number;
    /** For replacement plugins: whether to allow fallback to default if canRender returns false */
    allowFallback?: boolean;
  };

  /** Plugin capabilities/permissions declaration */
  capabilities?: PluginCapabilities;

  /** Dependencies on other plugins */
  dependencies?: Record<string, string>;

  /** Plugin-specific settings schema (JSON Schema format) */
  settingsSchema?: Record<string, unknown>;
}

/**
 * Plugin capabilities declaration - what the plugin requests access to.
 */
export interface PluginCapabilities {
  /** Access Redux store */
  accessStore?: boolean;
  /** Access host APIs through the platform adapter (`context.platform`) */
  accessElectron?: boolean;
  /** Access service layer */
  accessServices?: boolean;
  /** Make network requests */
  accessNetwork?: boolean;
}

// ============================================================================
// Plugin Lifecycle
// ============================================================================

/**
 * Plugin lifecycle hooks - called at various stages of plugin lifecycle.
 */
export interface PluginLifecycle {
  /** Called when plugin is first loaded */
  init?(context: PluginContext): Promise<void> | void;

  /** Called when plugin is activated (enabled) */
  activate?(context: PluginContext): Promise<void> | void;

  /** Called when plugin is deactivated (disabled) */
  deactivate?(context: PluginContext): Promise<void> | void;

  /** Called when plugin is being unloaded */
  dispose?(context: PluginContext): Promise<void> | void;
}

// ============================================================================
// Plugin Context
// ============================================================================

/**
 * Context provided to plugins - contains APIs and utilities plugins can use.
 */
export interface PluginContext {
  /** Plugin identifier */
  pluginId: string;

  /** Plugin manifest */
  manifest: PluginManifest;

  /** Per-plugin isolated storage */
  storage: PluginStorage;

  /** Redux store access (if accessStore capability is granted) */
  store?: PluginStoreAccess;

  /** Host API access (if the accessElectron capability is granted) */
  platform?: ClaudiaPlatform;

  /** Logger for plugin debugging */
  logger: PluginLogger;

  /** Plugin settings (from user configuration) */
  settings: Record<string, unknown>;

  /** Event bus for inter-plugin communication */
  events: PluginEventBus;
}

/**
 * Per-plugin isolated storage API.
 */
export interface PluginStorage {
  /** Get a value from storage */
  get<T>(key: string, defaultValue?: T): Promise<T | undefined>;

  /** Set a value in storage */
  set<T>(key: string, value: T): Promise<void>;

  /** Delete a key from storage */
  delete(key: string): Promise<void>;

  /** Clear all plugin storage */
  clear(): Promise<void>;
}

/**
 * Redux store access for plugins.
 */
export interface PluginStoreAccess {
  /** Get current state */
  getState: () => unknown;

  /** Dispatch an action */
  dispatch: (action: unknown) => void;

  /** Subscribe to state changes */
  subscribe: (listener: () => void) => () => void;
}

/**
 * Logger API for plugins.
 */
export interface PluginLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Event bus for inter-plugin communication.
 */
export interface PluginEventBus {
  /** Emit an event */
  emit(event: string, data?: unknown): void;

  /** Subscribe to an event */
  on(event: string, handler: (data: unknown) => void): () => void;

  /** Unsubscribe from an event */
  off(event: string, handler: (data: unknown) => void): void;
}

// ============================================================================
// Renderer Plugin Types
// ============================================================================

/**
 * Render context passed to rendering functions.
 */
export interface RenderContext {
  /** Current theme setting */
  theme: 'light' | 'dark' | 'system';

  /** Whether dark mode is currently active */
  isDark: boolean;

  /** The message being rendered (if available) */
  message?: Message;

  /** Current conversation ID */
  conversationId?: string;

  /** Plugin-specific settings */
  pluginSettings: Record<string, unknown>;
}

/**
 * Props passed to renderer components.
 */
export interface RendererProps {
  /** The content to render */
  content: string;

  /** Whether this is a user message */
  isUser: boolean;

  /** The full message object (if available) */
  message?: Message;

  /** Render context with theme and settings */
  context: RenderContext;
}

/**
 * Base renderer plugin interface.
 */
export interface RendererPlugin extends PluginLifecycle {
  /** Plugin manifest */
  manifest: PluginManifest;
}

/**
 * Markdown extension plugin - adds custom components/syntax to markdown rendering.
 */
export interface MarkdownExtensionPlugin extends RendererPlugin {
  manifest: PluginManifest & { type: 'renderer-extension' };

  /** Custom remark plugins to add to the processing pipeline */
  remarkPlugins?: UnifiedPlugin[];

  /** Custom rehype plugins to add to the processing pipeline */
  rehypePlugins?: UnifiedPlugin[];

  /** Custom component overrides/additions for react-markdown */
  components?: Record<string, ComponentType<unknown>>;

  /** Pre-process markdown content before rendering */
  preProcess?(content: string, context: RenderContext): string;

  /** Post-process rendered React output */
  postProcess?(element: ReactNode, context: RenderContext): ReactNode;
}

/**
 * Renderer replacement plugin - completely replaces the default markdown renderer.
 */
export interface RendererReplacementPlugin extends RendererPlugin {
  manifest: PluginManifest & { type: 'renderer-replacement' };

  /** The replacement renderer component */
  Renderer: ComponentType<RendererProps>;

  /** Check if this plugin can/should handle the given message */
  canRender?(message: Message, context: RenderContext): boolean;
}

// ============================================================================
// Plugin State Types (for Redux)
// ============================================================================

/**
 * Plugin status in the lifecycle.
 */
export type PluginStatus =
  | 'discovered'   // Found but not loaded
  | 'loading'      // Currently loading
  | 'loaded'       // Loaded but not active
  | 'active'       // Enabled and running
  | 'inactive'     // Disabled
  | 'error';       // Failed to load/run

/**
 * Plugin configuration (persisted).
 */
export interface PluginConfig {
  /** Plugin ID */
  id: string;

  /** Display name */
  name: string;

  /** Version */
  version: string;

  /** Plugin source */
  source: 'local' | 'npm';

  /** Plugin type */
  type: 'renderer-extension' | 'renderer-replacement';

  /** Whether plugin is enabled */
  enabled: boolean;

  /** Priority for extension plugins */
  priority: number;

  /** Path to plugin (local path or node_modules path) */
  path: string;

  /** Declared capabilities */
  capabilities: PluginCapabilities;

  /** Plugin-specific settings */
  settings: Record<string, unknown>;

  /** When the plugin was installed */
  installedAt: string;
}

/**
 * Plugin runtime state (ephemeral).
 */
export interface PluginRuntimeState {
  /** Current status */
  status: PluginStatus;

  /** Error message if status is 'error' */
  error?: string;

  /** When the plugin was last activated */
  lastActivated?: string;

  /** When the plugin was last deactivated */
  lastDeactivated?: string;
}

/**
 * Discovered plugin from scanning.
 */
export interface DiscoveredPlugin {
  /** Plugin ID */
  id: string;

  /** Source type */
  source: 'local' | 'npm';

  /** Path to plugin */
  path: string;

  /** Parsed manifest */
  manifest: PluginManifest;

  /** Whether manifest is valid */
  isValid: boolean;

  /** Validation errors if not valid */
  validationErrors?: string[];
}

/**
 * Plugin conflict information.
 */
export interface PluginConflict {
  /** Type of conflict */
  type: 'component-override' | 'multiple-replacements' | 'dependency-missing';

  /** Plugins involved in conflict */
  plugins: string[];

  /** Description of the conflict */
  description: string;

  /** Suggested resolution */
  resolution?: string;
}

// ============================================================================
// Loaded Plugin Instance
// ============================================================================

/**
 * A loaded plugin instance with its context.
 */
export interface LoadedPlugin {
  /** Plugin ID */
  id: string;

  /** Plugin manifest */
  manifest: PluginManifest;

  /** The plugin instance (extension or replacement) */
  instance: MarkdownExtensionPlugin | RendererReplacementPlugin;

  /** Plugin context */
  context: PluginContext;

  /** Current status */
  status: PluginStatus;

  /** Error if any */
  error?: string;
}

// ============================================================================
// IPC Response Types
// ============================================================================

export interface PluginDiscoverResponse {
  success: boolean;
  plugins?: DiscoveredPlugin[];
  error?: string;
}

export interface PluginLoadResponse {
  success: boolean;
  error?: string;
}

export interface PluginEnableResponse {
  success: boolean;
  error?: string;
}

export interface PluginDisableResponse {
  success: boolean;
  error?: string;
}

export interface PluginListResponse {
  success: boolean;
  configs?: Record<string, PluginConfig>;
  error?: string;
}

export interface PluginGetConfigResponse {
  success: boolean;
  config?: PluginConfig;
  error?: string;
}

export interface PluginSettingsResponse {
  success: boolean;
  settings?: Record<string, unknown>;
  error?: string;
}

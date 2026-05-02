import Store from 'electron-store';
import { safeStorage } from 'electron';
import { randomUUID } from 'crypto';
import { MCPServerConfig } from '../../src/types/mcp.types';
import { PluginConfig } from '../../src/types/plugin.types';
import { getAllBuiltinServerDefinitions } from './builtin-mcp/registry';
import { getActiveProfileId } from './profile.service';

interface StoreSchema {
  version?: string; // App version for migration tracking
  config: {
    api: {
      provider: 'openwebui' | 'openrouter' | 'custom' | 'opencode-go';
      openwebui?: {
        baseUrl: string;
        apiKey: string;
        selectedModel: string;
      };
      openrouter?: {
        apiKey: string;
        selectedModel: string;
        siteUrl?: string;
        siteName?: string;
      };
      custom?: {
        baseUrl: string;
        apiKey: string;
        selectedModel: string;
      };
      opencodeGo?: {
        baseUrl: string;
        apiKey: string;
        selectedModel: string;
        apiCompatibility: 'openai' | 'anthropic';
      };
      availableModels: string[];
      // Legacy fields for backward compatibility
      baseUrl?: string;
      apiKey?: string;
      selectedModel?: string;
    };
    appearance: {
      theme: 'light' | 'dark' | 'system';
      fontSize: 'small' | 'medium' | 'large';
      sidebarWidth: number;
      customization?: {
        accentColor?: string;
        appTitle?: string;
        iconPath?: string;
      };
    };
    preferences: {
      saveHistory: boolean;
      streamingEnabled: boolean;
      maxTokens: number;
      temperature: number;
      logLevel: 'debug' | 'info' | 'warn' | 'error';
      enableFileLogging: boolean;
      showReasoning: boolean;
      showStatistics: boolean;
      systemPrompt: string;
      systemPromptFileName: string;
      updateCheckUrl: string;
    };
  };
  windowState: {
    width: number;
    height: number;
    x?: number;
    y?: number;
  };
  mcp: {
    servers: Record<string, MCPServerConfig>;
    lastImportDate?: string;
  };
  plugins: {
    configs: Record<string, PluginConfig>;
    settings: Record<string, Record<string, unknown>>;
    data: Record<string, Record<string, unknown>>;
  };
  // Provider-specific encrypted API keys (legacy fallback)
  encryptedApiKeys?: {
    openwebui?: string;
    openrouter?: string;
    custom?: string;
    'opencode-go'?: string;
  };
  // Profile system (v0.9+)
  profiles?: Record<string, {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    config: StoreSchema['config'];
  }>;
  currentProfileId?: string;
  // Encrypted blobs are bound to the OS user via safeStorage; not portable across machines
  encryptedApiKeysByProfile?: Record<string, Record<string, string>>;
}

export const store = new Store<StoreSchema>({
  name: 'config',
  defaults: {
    config: {
      api: {
        provider: 'openwebui',
        availableModels: [],
      },
      appearance: {
        theme: 'system',
        fontSize: 'medium',
        sidebarWidth: 280,
      },
      preferences: {
        saveHistory: true,
        streamingEnabled: true,
        maxTokens: 2048,
        temperature: 0.7,
        logLevel: 'info',
        enableFileLogging: true,
        showReasoning: false,
        showStatistics: false,
        systemPrompt: '',
        systemPromptFileName: '',
        updateCheckUrl: '',
      },
    },
    windowState: {
      width: 1200,
      height: 800,
    },
    mcp: {
      servers: {},
    },
    plugins: {
      configs: {},
      settings: {},
      data: {},
    },
    profiles: {},
    encryptedApiKeysByProfile: {},
  },
});

// Helper functions for secure API key storage
export function saveApiKey(provider: 'openwebui' | 'openrouter' | 'custom' | 'opencode-go', apiKey: string, profileId?: string): void {
  console.log(`[Store] saveApiKey called for ${provider}, key length:`, apiKey?.length || 0);
  try {
    if (safeStorage.isEncryptionAvailable()) {
      console.log(`[Store] Encrypting ${provider} API key using safeStorage`);
      const encrypted = safeStorage.encryptString(apiKey);
      const base64Key = encrypted.toString('base64');

      if (profileId) {
        const encryptedKeysByProfile = store.get('encryptedApiKeysByProfile', {}) as Record<string, Record<string, string>>;
        if (!encryptedKeysByProfile[profileId]) {
          encryptedKeysByProfile[profileId] = {};
        }
        encryptedKeysByProfile[profileId][provider] = base64Key;
        store.set('encryptedApiKeysByProfile', encryptedKeysByProfile);
        console.log(`[Store] Encrypted ${provider} API key saved for profile ${profileId}, length:`, base64Key.length);

        // Verify it was saved
        const verification = store.get('encryptedApiKeysByProfile') as Record<string, Record<string, string>>;
        console.log(`[Store] Verification: ${provider} key exists for profile ${profileId}:`, !!verification[profileId]?.[provider]);
      } else {
        // Legacy fallback
        const encryptedKeys = store.get('encryptedApiKeys', {}) as Record<string, string>;
        encryptedKeys[provider] = base64Key;
        store.set('encryptedApiKeys', encryptedKeys);
        console.log(`[Store] Encrypted ${provider} API key saved (legacy), length:`, base64Key.length);

        // Verify it was saved
        const verification = store.get('encryptedApiKeys') as Record<string, string>;
        console.log(`[Store] Verification: ${provider} key exists (legacy):`, !!verification[provider]);
      }
    } else {
      console.warn('[Store] Encryption not available, storing API key in plain text');
      if (profileId) {
        store.set(`plainApiKey_${profileId}_${provider}`, apiKey);
      } else {
        store.set(`plainApiKey_${provider}`, apiKey);
      }
      console.log(`[Store] Plain ${provider} API key saved`);
    }
  } catch (error) {
    console.error(`[Store] Failed to save ${provider} API key:`, error);
    if (profileId) {
      store.set(`plainApiKey_${profileId}_${provider}`, apiKey);
    } else {
      store.set(`plainApiKey_${provider}`, apiKey);
    }
    console.log(`[Store] Fallback: Plain ${provider} API key saved`);
  }
}

export function getApiKey(provider: 'openwebui' | 'openrouter' | 'custom' | 'opencode-go', profileId?: string): string {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      if (profileId) {
        const encryptedKeysByProfile = store.get('encryptedApiKeysByProfile', {}) as Record<string, Record<string, string>>;
        const encrypted = encryptedKeysByProfile[profileId]?.[provider];
        console.log(`[Store] Looking for encrypted ${provider} key for profile ${profileId}, found:`, !!encrypted);
        if (encrypted) {
          const buffer = Buffer.from(encrypted, 'base64');
          const decrypted = safeStorage.decryptString(buffer);
          console.log(`[Store] Successfully decrypted ${provider} API key for profile ${profileId}, length:`, decrypted?.length || 0);
          return decrypted;
        }
      }
      // Legacy fallback
      const encryptedKeys = store.get('encryptedApiKeys', {}) as Record<string, string>;
      const encrypted = encryptedKeys[provider];
      console.log(`[Store] Looking for encrypted ${provider} key (legacy), found:`, !!encrypted);
      if (encrypted) {
        const buffer = Buffer.from(encrypted, 'base64');
        const decrypted = safeStorage.decryptString(buffer);
        console.log(`[Store] Successfully decrypted ${provider} API key (legacy), length:`, decrypted?.length || 0);
        return decrypted;
      }
    }
    // Fallback to plain storage
    const plainKey = profileId
      ? store.get(`plainApiKey_${profileId}_${provider}`, '') as string
      : store.get(`plainApiKey_${provider}`, '') as string;
    if (plainKey) {
      console.log(`[Store] Retrieved plain text ${provider} API key, length:`, plainKey.length);
    }
    return plainKey;
  } catch (error) {
    console.error(`[Store] Failed to get ${provider} API key:`, error);
    return '';
  }
}

function normalizeConfigUrls(config: any) {
  const normalized = JSON.parse(JSON.stringify(config));
  if (normalized.api?.openwebui?.baseUrl) {
    normalized.api.openwebui = {
      ...normalized.api.openwebui,
      baseUrl: normalized.api.openwebui.baseUrl
        .replace(/\/+$/, '')
        .replace(/\/api$/i, ''),
    };
  }
  if (normalized.api?.custom?.baseUrl) {
    normalized.api.custom = {
      ...normalized.api.custom,
      baseUrl: normalized.api.custom.baseUrl
        .replace(/\/+$/, '')
        .replace(/\/api$/i, ''),
    };
  }
  if (normalized.api?.opencodeGo?.baseUrl) {
    normalized.api.opencodeGo = {
      ...normalized.api.opencodeGo,
      baseUrl: normalized.api.opencodeGo.baseUrl
        .replace(/\/+$/, '')
        .replace(/\/v1$/i, ''),
    };
  }
  return normalized;
}

export function getConfig() {
  const activeProfileId = getActiveProfileId();
  const profiles = store.get('profiles', {}) as Record<string, any>;
  const profile = profiles[activeProfileId];

  if (!profile) {
    console.error('[Store] getConfig: active profile not found, falling back to legacy config');
    // Startup robustness: fallback to first profile if available
    const profileIds = Object.keys(profiles);
    if (profileIds.length > 0) {
      const fallbackId = profileIds[0];
      store.set('currentProfileId', fallbackId);
      console.log('[Store] getConfig: recovered by setting currentProfileId to', fallbackId);
      return getConfig(); // Retry with recovered profile
    }
    // Absolute fallback to legacy top-level config
    const config = store.get('config');
    return normalizeConfigUrls(config);
  }

  console.log('[Store] getConfig: Loading configuration for profile', activeProfileId);
  const config = { ...profile.config };
  console.log('[Store] getConfig: Provider:', config.api?.provider);

  // Decrypt provider-specific API keys from profile bucket
  const decryptedConfig = { ...config };

  if (config.api?.openwebui) {
    const openwebuiKey = getApiKey('openwebui', activeProfileId);
    console.log('[Store] getConfig: OpenWebUI key retrieved, length:', openwebuiKey?.length || 0);
    decryptedConfig.api = {
      ...decryptedConfig.api,
      openwebui: {
        ...config.api.openwebui,
        apiKey: openwebuiKey,
      },
    };
  }

  if (config.api?.openrouter) {
    const openrouterKey = getApiKey('openrouter', activeProfileId);
    console.log('[Store] getConfig: OpenRouter key retrieved, length:', openrouterKey?.length || 0);
    decryptedConfig.api = {
      ...decryptedConfig.api,
      openrouter: {
        ...config.api.openrouter,
        apiKey: openrouterKey,
      },
    };
  }

  if (config.api?.custom) {
    const customKey = getApiKey('custom', activeProfileId);
    console.log('[Store] getConfig: Custom key retrieved, length:', customKey?.length || 0);
    decryptedConfig.api = {
      ...decryptedConfig.api,
      custom: {
        ...config.api.custom,
        apiKey: customKey,
      },
    };
  }

  if (config.api?.opencodeGo) {
    const opencodeGoKey = getApiKey('opencode-go', activeProfileId);
    console.log('[Store] getConfig: Opencode Go key retrieved, length:', opencodeGoKey?.length || 0);
    decryptedConfig.api = {
      ...decryptedConfig.api,
      opencodeGo: {
        ...config.api.opencodeGo,
        apiKey: opencodeGoKey,
      },
    };
  }

  return normalizeConfigUrls(decryptedConfig);
}

export function setConfig(config: Partial<StoreSchema['config']>) {
  const activeProfileId = getActiveProfileId();
  const profiles = store.get('profiles', {}) as Record<string, any>;
  const profile = profiles[activeProfileId];

  if (!profile) {
    console.error('[Store] setConfig: no active profile, writing to legacy config');
    // Fallback to legacy top-level config
    const currentConfig = store.get('config');

    console.log('[Store] setConfig called with:', JSON.stringify(config, null, 2));
    console.log('[Store] Current config.api:', JSON.stringify(currentConfig.api, null, 2));

    // Handle provider-specific API keys separately for encryption
    if (config.api) {
      if (config.api.openwebui?.apiKey) {
        console.log('[Store] Saving encrypted OpenWebUI API key, length:', config.api.openwebui.apiKey.length);
        saveApiKey('openwebui', config.api.openwebui.apiKey);
        const { apiKey, ...openwebuiRest } = config.api.openwebui;
        config.api.openwebui = openwebuiRest as any;
      }
      if (config.api.openrouter?.apiKey) {
        console.log('[Store] Saving encrypted OpenRouter API key, length:', config.api.openrouter.apiKey.length);
        saveApiKey('openrouter', config.api.openrouter.apiKey);
        const { apiKey, ...openrouterRest } = config.api.openrouter;
        config.api.openrouter = openrouterRest as any;
      }
      if (config.api.custom?.apiKey) {
        console.log('[Store] Saving encrypted Custom API key, length:', config.api.custom.apiKey.length);
        saveApiKey('custom', config.api.custom.apiKey);
        const { apiKey, ...customRest } = config.api.custom;
        config.api.custom = customRest as any;
      }
      if (config.api.opencodeGo?.apiKey) {
        console.log('[Store] Saving encrypted Opencode Go API key, length:', config.api.opencodeGo.apiKey.length);
        saveApiKey('opencode-go', config.api.opencodeGo.apiKey);
        const { apiKey, ...opencodeGoRest } = config.api.opencodeGo;
        config.api.opencodeGo = opencodeGoRest as any;
      }
    }

    // Deep merge to preserve existing fields
    const mergedConfig = {
      ...currentConfig,
      ...config,
      api: config.api ? {
        ...currentConfig.api,
        ...config.api,
        openwebui: config.api.openwebui ? { ...currentConfig.api.openwebui, ...config.api.openwebui } : currentConfig.api.openwebui,
        openrouter: config.api.openrouter ? { ...currentConfig.api.openrouter, ...config.api.openrouter } : currentConfig.api.openrouter,
        custom: config.api.custom ? { ...currentConfig.api.custom, ...config.api.custom } : currentConfig.api.custom,
        opencodeGo: config.api.opencodeGo ? { ...currentConfig.api.opencodeGo, ...config.api.opencodeGo } : currentConfig.api.opencodeGo,
      } : currentConfig.api,
      appearance: config.appearance ? { ...currentConfig.appearance, ...config.appearance } : currentConfig.appearance,
      preferences: config.preferences ? { ...currentConfig.preferences, ...config.preferences } : currentConfig.preferences,
    };

    console.log('[Store] Merged config.api:', JSON.stringify(mergedConfig.api, null, 2));
    store.set('config', mergedConfig);
    return;
  }

  console.log('[Store] setConfig called for profile', activeProfileId, 'with:', JSON.stringify(config, null, 2));
  const currentConfig = profile.config;
  console.log('[Store] Current config.api:', JSON.stringify(currentConfig.api, null, 2));

  // Handle provider-specific API keys separately for encryption
  if (config.api) {
    if (config.api.openwebui?.apiKey) {
      console.log('[Store] Saving encrypted OpenWebUI API key, length:', config.api.openwebui.apiKey.length);
      saveApiKey('openwebui', config.api.openwebui.apiKey, activeProfileId);
      const { apiKey, ...openwebuiRest } = config.api.openwebui;
      config.api.openwebui = openwebuiRest as any;
    }
    if (config.api.openrouter?.apiKey) {
      console.log('[Store] Saving encrypted OpenRouter API key, length:', config.api.openrouter.apiKey.length);
      saveApiKey('openrouter', config.api.openrouter.apiKey, activeProfileId);
      const { apiKey, ...openrouterRest } = config.api.openrouter;
      config.api.openrouter = openrouterRest as any;
    }
    if (config.api.custom?.apiKey) {
      console.log('[Store] Saving encrypted Custom API key, length:', config.api.custom.apiKey.length);
      saveApiKey('custom', config.api.custom.apiKey, activeProfileId);
      const { apiKey, ...customRest } = config.api.custom;
      config.api.custom = customRest as any;
    }
    if (config.api.opencodeGo?.apiKey) {
      console.log('[Store] Saving encrypted Opencode Go API key, length:', config.api.opencodeGo.apiKey.length);
      saveApiKey('opencode-go', config.api.opencodeGo.apiKey, activeProfileId);
      const { apiKey, ...opencodeGoRest } = config.api.opencodeGo;
      config.api.opencodeGo = opencodeGoRest as any;
    }
  }

  // Deep merge to preserve existing fields
  const mergedConfig = {
    ...currentConfig,
    ...config,
    api: config.api ? {
      ...currentConfig.api,
      ...config.api,
      openwebui: config.api.openwebui ? { ...currentConfig.api.openwebui, ...config.api.openwebui } : currentConfig.api.openwebui,
      openrouter: config.api.openrouter ? { ...currentConfig.api.openrouter, ...config.api.openrouter } : currentConfig.api.openrouter,
      custom: config.api.custom ? { ...currentConfig.api.custom, ...config.api.custom } : currentConfig.api.custom,
      opencodeGo: config.api.opencodeGo ? { ...currentConfig.api.opencodeGo, ...config.api.opencodeGo } : currentConfig.api.opencodeGo,
    } : currentConfig.api,
    appearance: config.appearance ? { ...currentConfig.appearance, ...config.appearance } : currentConfig.appearance,
    preferences: config.preferences ? { ...currentConfig.preferences, ...config.preferences } : currentConfig.preferences,
  };

  console.log('[Store] Merged config.api:', JSON.stringify(mergedConfig.api, null, 2));

  profiles[activeProfileId] = {
    ...profile,
    config: mergedConfig,
    updatedAt: new Date().toISOString(),
  };
  store.set('profiles', profiles);
}

/**
 * Migrate settings to ensure all required fields exist with proper defaults
 */
function migrateSettings() {
  const config = store.get('config');
  let needsSave = false;

  // Ensure preferences exist with all required fields
  if (!config.preferences) {
    console.log('[Store Migration] Adding missing preferences object');
    config.preferences = {
      saveHistory: true,
      streamingEnabled: true,
      maxTokens: 2048,
      temperature: 0.7,
      logLevel: 'info',
      enableFileLogging: true,
      showReasoning: false,
      showStatistics: false,
    };
    needsSave = true;
  } else {
    // Check for missing fields in preferences
    if (config.preferences.showReasoning === undefined) {
      console.log('[Store Migration] Adding showReasoning field');
      config.preferences.showReasoning = false;
      needsSave = true;
    }
    if (config.preferences.showStatistics === undefined) {
      console.log('[Store Migration] Adding showStatistics field');
      config.preferences.showStatistics = false;
      needsSave = true;
    }
    if (config.preferences.systemPrompt === undefined) {
      console.log('[Store Migration] Adding systemPrompt field');
      config.preferences.systemPrompt = '';
      needsSave = true;
    }
    if (config.preferences.systemPromptFileName === undefined) {
      console.log('[Store Migration] Adding systemPromptFileName field');
      config.preferences.systemPromptFileName = '';
      needsSave = true;
    }
    if (config.preferences.updateCheckUrl === undefined) {
      console.log('[Store Migration] Adding updateCheckUrl field');
      config.preferences.updateCheckUrl = '';
      needsSave = true;
    }
  }

  if (needsSave) {
    console.log('[Store Migration] Saving migrated config');
    store.set('config', config);
  }
}

/**
 * Migrate legacy config / encryptedApiKeys into the profile system.
 * Idempotent: gates on currentProfileId being unset.
 */
function migrateToProfiles() {
  const currentProfileId = store.get('currentProfileId');
  if (currentProfileId) {
    console.log('[Store Migration] Profiles already migrated, currentProfileId:', currentProfileId);
    return;
  }

  console.log('[Store Migration] Migrating to profiles...');
  const existingConfig = store.get('config');
  const existingEncryptedKeys = store.get('encryptedApiKeys', {}) as Record<string, string>;

  const id = `default-${randomUUID()}`;
  const now = new Date().toISOString();

  const profiles = store.get('profiles', {}) as Record<string, any>;
  profiles[id] = {
    id,
    name: 'Default',
    createdAt: now,
    updatedAt: now,
    config: existingConfig,
  };
  store.set('profiles', profiles);

  const encryptedApiKeysByProfile = store.get('encryptedApiKeysByProfile', {}) as Record<string, Record<string, string>>;
  encryptedApiKeysByProfile[id] = { ...existingEncryptedKeys };
  store.set('encryptedApiKeysByProfile', encryptedApiKeysByProfile);

  store.set('currentProfileId', id);
  console.log('[Store Migration] Created default profile:', id);
}

/**
 * Seed built-in MCP servers if they don't already exist.
 * Called during app startup to ensure built-in servers are always available.
 */
export function seedBuiltinServers(): void {
  const servers = store.get('mcp.servers', {}) as Record<string, MCPServerConfig>;
  const definitions = getAllBuiltinServerDefinitions();
  let needsSave = false;

  // Migrate: remove legacy office server
  if (servers['builtin-office-001']) {
    delete servers['builtin-office-001'];
    needsSave = true;
  }

  for (const def of definitions) {
    if (!servers[def.id]) {
      console.log(`[Store] Seeding built-in MCP server: ${def.name} (${def.id})`);
      servers[def.id] = {
        id: def.id,
        name: def.name,
        transport: 'builtin',
        enabled: false,
        builtin: true,
        builtinId: def.id,
        metadata: {
          description: def.description,
        },
      };
      needsSave = true;
    }
  }

  if (needsSave) {
    store.set('mcp.servers', servers);
    console.log('[Store] Built-in servers seeded');
  }
}

/**
 * Check app version and perform migration/cache clearing if needed
 * @param currentVersion - Current app version from package.json
 * @param session - Electron session for cache clearing
 */
export async function checkVersionAndMigrate(
  currentVersion: string,
  session: Electron.Session
): Promise<void> {
  // Always run profile migration first (idempotent)
  migrateToProfiles();

  const storedVersion = store.get('version');

  console.log(`[Store] Current version: ${currentVersion}, Stored version: ${storedVersion || 'none'}`);

  // If version changed or missing, perform migration and cache clearing
  if (!storedVersion || storedVersion !== currentVersion) {
    console.log('[Store] Version mismatch detected, performing migration and cache clearing');

    // Migrate settings to ensure all fields exist
    migrateSettings();

    // Clear session cache to prevent old code from being loaded
    try {
      console.log('[Store] Clearing session cache...');
      await session.clearCache();
      console.log('[Store] Cache cleared successfully');
    } catch (error) {
      console.error('[Store] Failed to clear cache:', error);
    }

    // Update stored version
    store.set('version', currentVersion);
    console.log('[Store] Version updated to:', currentVersion);
  } else {
    console.log('[Store] Version unchanged, skipping migration');
  }
}

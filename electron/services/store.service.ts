import Store from 'electron-store';
import { safeStorage } from 'electron';
import { MCPServerConfig } from '../../src/types/mcp.types';
import { PluginConfig } from '../../src/types/plugin.types';

interface StoreSchema {
  config: {
    api: {
      provider: 'openwebui' | 'openrouter';
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
    };
    preferences: {
      saveHistory: boolean;
      streamingEnabled: boolean;
      maxTokens: number;
      temperature: number;
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
  // Provider-specific encrypted API keys
  encryptedApiKeys?: {
    openwebui?: string;
    openrouter?: string;
  };
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
  },
});

// Helper functions for secure API key storage
export function saveApiKey(provider: 'openwebui' | 'openrouter', apiKey: string): void {
  console.log(`[Store] saveApiKey called for ${provider}, key length:`, apiKey?.length || 0);
  try {
    if (safeStorage.isEncryptionAvailable()) {
      console.log(`[Store] Encrypting ${provider} API key using safeStorage`);
      const encrypted = safeStorage.encryptString(apiKey);
      const base64Key = encrypted.toString('base64');

      // Get existing encrypted keys or create new object
      const encryptedKeys = store.get('encryptedApiKeys', {}) as Record<string, string>;
      encryptedKeys[provider] = base64Key;

      // Save to encrypted keys object
      store.set('encryptedApiKeys', encryptedKeys);
      console.log(`[Store] Encrypted ${provider} API key saved, length:`, base64Key.length);

      // Verify it was saved
      const verification = store.get('encryptedApiKeys') as Record<string, string>;
      console.log(`[Store] Verification: ${provider} key exists:`, !!verification[provider]);
    } else {
      console.warn('[Store] Encryption not available, storing API key in plain text');
      // Fallback to plain storage
      store.set(`plainApiKey_${provider}`, apiKey);
      console.log(`[Store] Plain ${provider} API key saved`);
    }
  } catch (error) {
    console.error(`[Store] Failed to save ${provider} API key:`, error);
    // Fallback to plain storage on error
    store.set(`plainApiKey_${provider}`, apiKey);
    console.log(`[Store] Fallback: Plain ${provider} API key saved`);
  }
}

export function getApiKey(provider: 'openwebui' | 'openrouter'): string {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const encryptedKeys = store.get('encryptedApiKeys', {}) as Record<string, string>;
      const encrypted = encryptedKeys[provider];
      console.log(`[Store] Looking for encrypted ${provider} key, found:`, !!encrypted);
      if (encrypted) {
        const buffer = Buffer.from(encrypted, 'base64');
        const decrypted = safeStorage.decryptString(buffer);
        console.log(`[Store] Successfully decrypted ${provider} API key, length:`, decrypted?.length || 0);
        return decrypted;
      }
    }
    // Fallback to plain storage
    const plainKey = store.get(`plainApiKey_${provider}`, '') as string;
    if (plainKey) {
      console.log(`[Store] Retrieved plain text ${provider} API key, length:`, plainKey.length);
    }
    return plainKey;
  } catch (error) {
    console.error(`[Store] Failed to get ${provider} API key:`, error);
    return '';
  }
}

export function getConfig() {
  const config = store.get('config');

  console.log('[Store] getConfig: Loading configuration');
  console.log('[Store] getConfig: Provider:', config.api.provider);

  // Decrypt provider-specific API keys
  const decryptedConfig = { ...config };

  if (config.api.openwebui) {
    const openwebuiKey = getApiKey('openwebui');
    console.log('[Store] getConfig: OpenWebUI key retrieved, length:', openwebuiKey?.length || 0);
    decryptedConfig.api = {
      ...decryptedConfig.api,
      openwebui: {
        ...config.api.openwebui,
        apiKey: openwebuiKey,
      },
    };
  }

  if (config.api.openrouter) {
    const openrouterKey = getApiKey('openrouter');
    console.log('[Store] getConfig: OpenRouter key retrieved, length:', openrouterKey?.length || 0);
    decryptedConfig.api = {
      ...decryptedConfig.api,
      openrouter: {
        ...config.api.openrouter,
        apiKey: openrouterKey,
      },
    };
  }

  return decryptedConfig;
}

export function setConfig(config: Partial<StoreSchema['config']>) {
  const currentConfig = store.get('config');

  console.log('[Store] setConfig called with:', JSON.stringify(config, null, 2));
  console.log('[Store] Current config.api:', JSON.stringify(currentConfig.api, null, 2));

  // Handle provider-specific API keys separately for encryption
  if (config.api) {
    // Handle OpenWebUI API key
    if (config.api.openwebui?.apiKey) {
      console.log('[Store] Saving encrypted OpenWebUI API key, length:', config.api.openwebui.apiKey.length);
      saveApiKey('openwebui', config.api.openwebui.apiKey);
      // Remove apiKey from config object before saving
      const { apiKey, ...openwebuiRest } = config.api.openwebui;
      config.api.openwebui = openwebuiRest as any;
    }

    // Handle OpenRouter API key
    if (config.api.openrouter?.apiKey) {
      console.log('[Store] Saving encrypted OpenRouter API key, length:', config.api.openrouter.apiKey.length);
      saveApiKey('openrouter', config.api.openrouter.apiKey);
      // Remove apiKey from config object before saving
      const { apiKey, ...openrouterRest } = config.api.openrouter;
      config.api.openrouter = openrouterRest as any;
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
    } : currentConfig.api,
    appearance: config.appearance ? { ...currentConfig.appearance, ...config.appearance } : currentConfig.appearance,
    preferences: config.preferences ? { ...currentConfig.preferences, ...config.preferences } : currentConfig.preferences,
  };

  console.log('[Store] Merged config.api:', JSON.stringify(mergedConfig.api, null, 2));
  store.set('config', mergedConfig);
}

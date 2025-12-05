import Store from 'electron-store';
import { safeStorage } from 'electron';
import { MCPServerConfig } from '../../src/types/mcp.types';

interface StoreSchema {
  config: {
    api: {
      baseUrl: string;
      apiKey: string;
      selectedModel: string;
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
}

export const store = new Store<StoreSchema>({
  name: 'config',
  defaults: {
    config: {
      api: {
        baseUrl: '',
        apiKey: '',
        selectedModel: '',
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
  },
});

// Helper functions for secure API key storage
export function saveApiKey(apiKey: string): void {
  console.log('[Store] saveApiKey called, key length:', apiKey?.length || 0);
  try {
    if (safeStorage.isEncryptionAvailable()) {
      console.log('[Store] Encrypting API key using safeStorage');
      const encrypted = safeStorage.encryptString(apiKey);
      const base64Key = encrypted.toString('base64');

      // Save to a separate top-level key to avoid conflicts
      store.set('encryptedApiKey', base64Key);
      console.log('[Store] Encrypted API key saved to "encryptedApiKey", length:', base64Key.length);

      // Also verify it was saved
      const verification = store.get('encryptedApiKey');
      console.log('[Store] Verification: key exists after save:', !!verification);

      // Clear the plain key if it exists
      store.delete('config.api.apiKey' as any);
    } else {
      console.warn('[Store] Encryption not available, storing API key in plain text');
      // Fallback to plain storage if encryption is not available
      store.set('plainApiKey', apiKey);
      console.log('[Store] Plain API key saved to "plainApiKey"');
    }
  } catch (error) {
    console.error('[Store] Failed to save API key:', error);
    // Fallback to plain storage on error
    store.set('plainApiKey', apiKey);
    console.log('[Store] Fallback: Plain API key saved to "plainApiKey"');
  }
}

export function getApiKey(): string {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = store.get('encryptedApiKey') as string;
      console.log('[Store] Looking for encrypted key, found:', !!encrypted);
      if (encrypted) {
        const buffer = Buffer.from(encrypted, 'base64');
        const decrypted = safeStorage.decryptString(buffer);
        console.log('[Store] Successfully decrypted API key, length:', decrypted?.length || 0);
        return decrypted;
      }
    }
    // Fallback to plain storage
    const plainKey = store.get('plainApiKey', '') as string;
    if (plainKey) {
      console.log('[Store] Retrieved plain text API key, length:', plainKey.length);
    }
    return plainKey;
  } catch (error) {
    console.error('[Store] Failed to get API key:', error);
    return '';
  }
}

export function getConfig() {
  const config = store.get('config');
  const apiKey = getApiKey();

  console.log('[Store] getConfig: Loading configuration');
  console.log('[Store] getConfig: API key retrieved, length:', apiKey?.length || 0);

  // Replace the stored API key with the decrypted one
  return {
    ...config,
    api: {
      ...config.api,
      apiKey,
    },
  };
}

export function setConfig(config: Partial<StoreSchema['config']>) {
  const currentConfig = store.get('config');

  console.log('[Store] setConfig called with:', JSON.stringify(config, null, 2));
  console.log('[Store] Current config.api:', JSON.stringify(currentConfig.api, null, 2));

  // Handle API key separately for encryption
  if (config.api?.apiKey) {
    console.log('[Store] Saving encrypted API key, length:', config.api.apiKey.length);
    saveApiKey(config.api.apiKey);
    // Remove apiKey from config object before saving
    const { apiKey, ...apiRest } = config.api;
    config.api = apiRest as any;
  }

  // Deep merge to preserve existing fields
  const mergedConfig = {
    ...currentConfig,
    ...config,
    api: config.api ? { ...currentConfig.api, ...config.api } : currentConfig.api,
    appearance: config.appearance ? { ...currentConfig.appearance, ...config.appearance } : currentConfig.appearance,
    preferences: config.preferences ? { ...currentConfig.preferences, ...config.preferences } : currentConfig.preferences,
  };

  console.log('[Store] Merged config.api:', JSON.stringify(mergedConfig.api, null, 2));
  store.set('config', mergedConfig);
}

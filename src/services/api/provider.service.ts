import { IAPIProvider } from './provider.interface';
import { ProviderFactory } from './provider.factory';
import type { APIConfig } from '../../types/api.types';

/** The API settings shape stored in `settings.api` (provider config plus legacy fields). */
export type APISettings = Partial<APIConfig> & {
  baseUrl?: string;
  apiKey?: string;
  selectedModel?: string;
};

let configSource: (() => APISettings) | null = null;

/**
 * Register where `getAPIProvider()` reads the current API settings from.
 * The desktop store registers itself at startup; this module never imports
 * the store, which keeps it free of import cycles.
 */
export function setProviderConfigSource(source: (() => APISettings) | null): void {
  configSource = source;
}

/**
 * Build the provider for the given API settings.
 * @throws Error if the active provider is not configured
 */
export function providerFromConfig(apiConfig: APISettings): IAPIProvider {
  // Check if using new provider-based config
  if ('provider' in apiConfig && apiConfig.provider) {
    const { provider } = apiConfig;

    switch (provider) {
      case 'openwebui': {
        const config = apiConfig.openwebui;
        if (!config?.baseUrl || !config?.apiKey) {
          throw new Error(
            'Open WebUI not configured. Please enter your API URL and key in Settings.'
          );
        }
        return ProviderFactory.getProvider('openwebui', config);
      }

      case 'openrouter': {
        const config = apiConfig.openrouter;
        if (!config?.apiKey) {
          throw new Error(
            'OpenRouter not configured. Please enter your API key in Settings.'
          );
        }
        return ProviderFactory.getProvider('openrouter', config);
      }

      case 'custom': {
        const config = apiConfig.custom;
        if (!config?.baseUrl || !config?.apiKey || !config?.selectedModel) {
          throw new Error(
            'Custom provider not configured. Please enter your API URL, API key, and model name in Settings.'
          );
        }
        return ProviderFactory.getProvider('custom', config);
      }

      case 'opencode-go': {
        const config = apiConfig.opencodeGo;
        if (!config?.apiKey || !config?.selectedModel) {
          throw new Error(
            'Opencode Go not fully configured. Please set your API key and model name in Settings.'
          );
        }
        return ProviderFactory.getProvider('opencode-go', config);
      }

      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }

  // Fallback to legacy config format for backward compatibility
  if (apiConfig.baseUrl && apiConfig.apiKey) {
    return ProviderFactory.getProvider('openwebui', {
      baseUrl: apiConfig.baseUrl,
      apiKey: apiConfig.apiKey,
      selectedModel: apiConfig.selectedModel || '',
    });
  }

  // No configuration found
  throw new Error(
    'No API provider configured. Please configure your API settings in the Settings panel.'
  );
}

/**
 * Get the currently configured API provider
 * This is the main entry point for all API operations in the application
 * @returns The configured API provider instance
 * @throws Error if no provider is configured
 */
export function getAPIProvider(): IAPIProvider {
  if (!configSource) {
    throw new Error('API settings are not available yet.');
  }
  return providerFromConfig(configSource());
}

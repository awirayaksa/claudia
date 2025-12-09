import { store } from '../../store';
import { IAPIProvider } from './provider.interface';
import { ProviderFactory } from './provider.factory';

/**
 * Get the currently configured API provider
 * This is the main entry point for all API operations in the application
 * @returns The configured API provider instance
 * @throws Error if no provider is configured
 */
export function getAPIProvider(): IAPIProvider {
  const state = store.getState();
  const apiConfig = state.settings.api;

  // Check if using new provider-based config
  if ('provider' in apiConfig && apiConfig.provider) {
    const { provider } = apiConfig as any;

    switch (provider) {
      case 'openwebui': {
        const config = (apiConfig as any).openwebui;
        if (!config?.baseUrl || !config?.apiKey) {
          throw new Error(
            'Open WebUI not configured. Please enter your API URL and key in Settings.'
          );
        }
        return ProviderFactory.getProvider('openwebui', config);
      }

      case 'openrouter': {
        const config = (apiConfig as any).openrouter;
        if (!config?.apiKey) {
          throw new Error(
            'OpenRouter not configured. Please enter your API key in Settings.'
          );
        }
        return ProviderFactory.getProvider('openrouter', config);
      }

      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }

  // Fallback to legacy config format for backward compatibility
  const legacyConfig = apiConfig as any;
  if (legacyConfig.baseUrl && legacyConfig.apiKey) {
    return ProviderFactory.getProvider('openwebui', {
      baseUrl: legacyConfig.baseUrl,
      apiKey: legacyConfig.apiKey,
      selectedModel: legacyConfig.selectedModel || '',
    });
  }

  // No configuration found
  throw new Error(
    'No API provider configured. Please configure your API settings in the Settings panel.'
  );
}

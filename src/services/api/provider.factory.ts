import { ProviderType, OpenWebUIConfig, OpenRouterConfig } from '../../types/api.types';
import { IAPIProvider } from './provider.interface';
import { OpenWebUIProvider, OpenRouterProvider } from './providers';

/**
 * Provider Factory
 * Singleton factory for creating and managing API provider instances
 */
export class ProviderFactory {
  private static providerInstances: Map<ProviderType, IAPIProvider> = new Map();

  /**
   * Get a provider instance, creating or updating it as needed
   * @param providerType - The type of provider to get
   * @param config - The configuration for the provider
   * @returns The provider instance
   */
  static getProvider(
    providerType: ProviderType,
    config: OpenWebUIConfig | OpenRouterConfig
  ): IAPIProvider {
    let provider = this.providerInstances.get(providerType);

    if (!provider) {
      // Create new provider instance
      provider = this.createProvider(providerType, config);
      this.providerInstances.set(providerType, provider);
    } else {
      // Update existing provider with new config
      provider.updateConfig(config);
    }

    return provider;
  }

  /**
   * Create a new provider instance based on type
   * @param providerType - The type of provider to create
   * @param config - The configuration for the provider
   * @returns The new provider instance
   */
  private static createProvider(
    providerType: ProviderType,
    config: OpenWebUIConfig | OpenRouterConfig
  ): IAPIProvider {
    switch (providerType) {
      case 'openwebui':
        return new OpenWebUIProvider(config as OpenWebUIConfig);

      case 'openrouter':
        return new OpenRouterProvider(config as OpenRouterConfig);

      default:
        throw new Error(`Unknown provider type: ${providerType}`);
    }
  }

  /**
   * Clear all cached provider instances
   * Useful for testing or when completely resetting the application
   */
  static clearProviders(): void {
    this.providerInstances.clear();
  }

  /**
   * Check if a provider instance exists in cache
   * @param providerType - The type of provider to check
   * @returns true if the provider exists in cache
   */
  static hasProvider(providerType: ProviderType): boolean {
    return this.providerInstances.has(providerType);
  }
}

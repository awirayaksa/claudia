/**
 * Builds the shared provider classes (../src/services/api/providers) for a
 * stored connection. The server constructs its own instances per connection;
 * it never uses the desktop's ProviderFactory singletons.
 */
import type { IAPIProvider } from '../../../src/services/api/provider.interface';
import { CustomProvider } from '../../../src/services/api/providers/custom.provider';
import { OpenRouterProvider } from '../../../src/services/api/providers/openrouter.provider';
import { OpenWebUIProvider } from '../../../src/services/api/providers/openwebui.provider';
import { OpencodeGoProvider } from '../../../src/services/api/providers/opencode-go.provider';
import type { ConnectionQuirks, ConnectionType } from '../db/schema';

export interface ProviderSpec {
  type: ConnectionType;
  baseUrl: string;
  apiKey: string;
  quirks: ConnectionQuirks;
}

export const DEFAULT_BASE_URLS: Record<ConnectionType, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  openwebui: '',
  'opencode-go': 'https://opencode.ai/zen/go',
};

export function createProvider(spec: ProviderSpec): IAPIProvider {
  const baseUrl = spec.baseUrl || DEFAULT_BASE_URLS[spec.type];
  switch (spec.type) {
    case 'openai':
      return new CustomProvider({ baseUrl, apiKey: spec.apiKey, selectedModel: '' });
    case 'openrouter':
      return new OpenRouterProvider({
        apiKey: spec.apiKey,
        selectedModel: '',
        siteUrl: spec.quirks.siteUrl,
        siteName: spec.quirks.siteName,
      });
    case 'openwebui':
      return new OpenWebUIProvider({ baseUrl, apiKey: spec.apiKey, selectedModel: '' });
    case 'opencode-go':
      return new OpencodeGoProvider({
        baseUrl,
        apiKey: spec.apiKey,
        selectedModel: '',
        apiCompatibility: spec.quirks.apiCompatibility ?? 'openai',
      });
  }
}

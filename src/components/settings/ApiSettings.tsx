import { useState, useEffect, useRef } from 'react';
import { useSettingsContext } from './SettingsPanel';
import { useAppSelector, useAppDispatch } from '../../store';
import { setApiConfig, setAvailableModels, setPreferences } from '../../store/slices/settingsSlice';
import { ProviderFactory } from '../../services/api/provider.factory';
import { ProviderType, OpenWebUIConfig, OpenRouterConfig, CustomProviderConfig, OpencodeGoConfig } from '../../types/api.types';
import { OpenWebUIConfigForm } from './OpenWebUIConfigForm';
import { OpenRouterConfigForm } from './OpenRouterConfigForm';
import { CustomConfigForm } from './CustomConfigForm';
import { OpencodeGoConfigForm } from './OpencodeGoConfigForm';

export function ApiSettings() {
  const dispatch = useAppDispatch();
  const { api, preferences } = useAppSelector((state) => state.settings);
  const { setIsDirty, registerSave } = useSettingsContext();

  // Local state for form inputs
  const [provider, setProvider] = useState<ProviderType>(api.provider || 'openwebui');
  const [openwebuiConfig, setOpenwebuiConfig] = useState<Partial<OpenWebUIConfig>>(
    api.openwebui || { baseUrl: '', apiKey: '', selectedModel: '' }
  );
  const [openrouterConfig, setOpenrouterConfig] = useState<Partial<OpenRouterConfig>>(
    api.openrouter || { apiKey: '', selectedModel: '', siteUrl: '', siteName: '' }
  );
  const [customConfig, setCustomConfig] = useState<Partial<CustomProviderConfig>>(
    api.custom || { baseUrl: '', apiKey: '', selectedModel: '' }
  );
  const [opencodeGoConfig, setOpencodeGoConfig] = useState<Partial<OpencodeGoConfig>>(
    api.opencodeGo || { baseUrl: 'https://opencode.ai/zen/go', apiKey: '', selectedModel: '', apiCompatibility: 'openai' }
  );
  const [streamingEnabled, setStreamingEnabled] = useState(preferences.streamingEnabled);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  // Sync local state with Redux store only on initial mount
  // Don't sync on every Redux change to avoid overwriting unsaved form changes
  useEffect(() => {
    console.log('[ApiSettings] Initial sync - api.openwebui.baseUrl:', api.openwebui?.baseUrl);
    setProvider(api.provider || 'openwebui');
    if (api.openwebui) {
      setOpenwebuiConfig(api.openwebui);
    }
    if (api.openrouter) {
      setOpenrouterConfig(api.openrouter);
    }
    if (api.custom) {
      setCustomConfig(api.custom);
    }
    if (api.opencodeGo) {
      setOpencodeGoConfig(api.opencodeGo);
    }
    setStreamingEnabled(preferences.streamingEnabled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run on mount

  // Sync streaming preference separately when it changes
  useEffect(() => {
    setStreamingEnabled(preferences.streamingEnabled);
  }, [preferences.streamingEnabled]);

  const handleProviderChange = (newProvider: ProviderType) => {
    setProvider(newProvider);
    setTestResult(null);
    setIsDirty(true);
  };

  const validateConfig = (): string => {
    if (provider === 'openwebui') {
      if (!openwebuiConfig?.baseUrl?.trim()) return 'API URL is required';
      try { new URL(openwebuiConfig.baseUrl); } catch { return 'Please enter a valid URL'; }
      if (!openwebuiConfig?.apiKey?.trim()) return 'API Key is required';
    } else if (provider === 'openrouter') {
      if (!openrouterConfig?.apiKey?.trim()) return 'API Key is required';
    } else if (provider === 'custom') {
      if (!customConfig?.baseUrl?.trim()) return 'API URL is required';
      try { new URL(customConfig.baseUrl); } catch { return 'Please enter a valid URL'; }
      if (!customConfig?.apiKey?.trim()) return 'API Key is required';
      if (!customConfig?.selectedModel?.trim()) return 'Model name is required';
    } else if (provider === 'opencode-go') {
      if (!opencodeGoConfig?.baseUrl?.trim()) return 'Base URL is required';
      try { new URL(opencodeGoConfig.baseUrl); } catch { return 'Please enter a valid URL'; }
      if (!opencodeGoConfig?.apiKey?.trim()) return 'API Key is required';
      if (!opencodeGoConfig?.selectedModel?.trim()) return 'Model name is required';
    }
    return '';
  };

  const handleTestConnection = async () => {
    const validationError = validateConfig();
    if (validationError) {
      setTestResult({ success: false, message: validationError });
      return;
    }

    setTesting(true);
    setTestResult(null);

    console.log('[ApiSettings] Test connection - baseUrl BEFORE:', openwebuiConfig?.baseUrl);

    try {
      // Create a temporary provider instance with current form values
      const tempProvider = ProviderFactory.getProvider(
        provider,
        provider === 'openwebui'
          ? openwebuiConfig as OpenWebUIConfig
          : provider === 'openrouter'
            ? openrouterConfig as OpenRouterConfig
            : provider === 'opencode-go'
              ? opencodeGoConfig as OpencodeGoConfig
              : customConfig as CustomProviderConfig
      );

      console.log('[ApiSettings] Test connection - baseUrl AFTER getProvider:', openwebuiConfig?.baseUrl);

      const models = await tempProvider.getModels();

      console.log('[ApiSettings] Test connection - baseUrl AFTER getModels:', openwebuiConfig?.baseUrl);

      setTestResult({
        success: true,
        message: `Connected successfully! Found ${models.length} model(s).`,
      });

      // Update available models in store
      dispatch(setAvailableModels(models.map((m) => m.id)));

      // If no model selected, select the first one (only for providers that support model listing)
      if (provider === 'openwebui' && !openwebuiConfig.selectedModel && models.length > 0) {
        console.log('[ApiSettings] Setting selected model, baseUrl before:', openwebuiConfig?.baseUrl);
        setOpenwebuiConfig({ ...openwebuiConfig, selectedModel: models[0].id });
      } else if (provider === 'openrouter' && !openrouterConfig.selectedModel && models.length > 0) {
        setOpenrouterConfig({ ...openrouterConfig, selectedModel: models[0].id });
      } else if (provider === 'opencode-go' && !opencodeGoConfig.selectedModel && models.length > 0) {
        setOpencodeGoConfig({ ...opencodeGoConfig, selectedModel: models[0].id });
      }

      console.log('[ApiSettings] Test connection complete - baseUrl FINAL:', openwebuiConfig?.baseUrl);
    } catch (error) {
      setTestResult({
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed',
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async (): Promise<boolean> => {
    const validationError = validateConfig();
    if (validationError) {
      setTestResult({ success: false, message: validationError });
      return false;
    }

    setTestResult(null);

    try {
      const newApiConfig: any = {
        provider,
        availableModels: api.availableModels,
      };

      // Add provider-specific config and extract selectedModel
      let selectedModel = '';
      if (provider === 'openwebui') {
        // Normalize baseUrl - remove trailing slashes and /api suffix
        const normalizedConfig = { ...openwebuiConfig };
        if (normalizedConfig.baseUrl) {
          normalizedConfig.baseUrl = normalizedConfig.baseUrl
            .replace(/\/+$/, '') // Remove trailing slashes
            .replace(/\/api$/i, ''); // Remove /api suffix to prevent duplication
        }
        newApiConfig.openwebui = normalizedConfig;
        selectedModel = normalizedConfig.selectedModel || '';
      } else if (provider === 'openrouter') {
        newApiConfig.openrouter = openrouterConfig;
        selectedModel = openrouterConfig.selectedModel || '';
      } else if (provider === 'custom') {
        // Normalize baseUrl - remove trailing slashes and /api suffix
        const normalizedConfig = { ...customConfig };
        if (normalizedConfig.baseUrl) {
          normalizedConfig.baseUrl = normalizedConfig.baseUrl
            .replace(/\/+$/, '') // Remove trailing slashes
            .replace(/\/api$/i, ''); // Remove /api suffix to prevent duplication
        }
        newApiConfig.custom = normalizedConfig;
        selectedModel = normalizedConfig.selectedModel || '';
      } else if (provider === 'opencode-go') {
        const normalizedConfig = { ...opencodeGoConfig };
        if (normalizedConfig.baseUrl) {
          normalizedConfig.baseUrl = normalizedConfig.baseUrl
            .replace(/\/+$/, '') // Remove trailing slashes
            .replace(/\/v1$/i, ''); // Remove /v1 suffix to prevent duplication
        }
        newApiConfig.opencodeGo = normalizedConfig;
        selectedModel = normalizedConfig.selectedModel || '';
      }

      // Set selectedModel at the top level for backward compatibility
      newApiConfig.selectedModel = selectedModel;

      // Save to Electron store
      await window.electron.config.set({
        api: newApiConfig,
        preferences: { streamingEnabled },
      });

      // Update Redux store
      dispatch(setApiConfig(newApiConfig));
      dispatch(setPreferences({ streamingEnabled }));

      // Clear cached provider instances so the next chat uses fresh config
      ProviderFactory.clearProviders();

      // Update local form state to match what was saved (with normalized URLs)
      if (provider === 'openwebui' && newApiConfig.openwebui) {
        setOpenwebuiConfig(newApiConfig.openwebui);
      } else if (provider === 'openrouter' && newApiConfig.openrouter) {
        setOpenrouterConfig(newApiConfig.openrouter);
      } else if (provider === 'custom' && newApiConfig.custom) {
        setCustomConfig(newApiConfig.custom);
      } else if (provider === 'opencode-go' && newApiConfig.opencodeGo) {
        setOpencodeGoConfig(newApiConfig.opencodeGo);
      }

      setTestResult({
        success: true,
        message: 'Settings saved successfully!',
      });
      return true;
    } catch (error) {
      setTestResult({
        success: false,
        message: 'Failed to save settings',
      });
      return false;
    }
  };

  const connectionStatus = testResult?.success === true
    ? { dot: '#2f8f4a', text: 'Connected', sub: '· tested just now' }
    : testResult?.success === false
      ? { dot: '#b14a3b', text: 'Error', sub: `· ${testResult.message}` }
      : null;

  // Register save function with settings context
  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;

  useEffect(() => {
    registerSave(async () => handleSaveRef.current());
  }, [registerSave]);

  // Wrapped change handlers that mark dirty
  const handleOpenwebuiConfigChange = (updates: Partial<OpenWebUIConfig>) => {
    setOpenwebuiConfig((prev) => ({ ...prev, ...updates }));
    setTestResult(null);
    setIsDirty(true);
  };

  const handleOpenrouterConfigChange = (updates: Partial<OpenRouterConfig>) => {
    setOpenrouterConfig((prev) => ({ ...prev, ...updates }));
    setTestResult(null);
    setIsDirty(true);
  };

  const handleCustomConfigChange = (updates: Partial<CustomProviderConfig>) => {
    setCustomConfig((prev) => ({ ...prev, ...updates }));
    setTestResult(null);
    setIsDirty(true);
  };

  const handleOpencodeGoConfigChange = (updates: Partial<OpencodeGoConfig>) => {
    setOpencodeGoConfig((prev) => ({ ...prev, ...updates }));
    setTestResult(null);
    setIsDirty(true);
  };

  const handleStreamingChange = (enabled: boolean) => {
    setStreamingEnabled(enabled);
    setIsDirty(true);
  };

  return (
    <div>
      {/* Section header */}
      <div style={{ padding: '22px 28px 18px', borderBottom: '1px solid #ebe7e1' }}>
        <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: -0.2, marginBottom: 4, color: '#1a1a19' }}>
          API Configuration
        </div>
        <div style={{ fontSize: 13, color: '#6f6b66', lineHeight: 1.55 }}>
          Connect to your preferred provider to start chatting.
        </div>
      </div>

      <div style={{ padding: '22px 28px' }}>
        {/* Provider + connection status card */}
        <div style={{ border: '1px solid #ebe7e1', borderRadius: 10, padding: 18, background: '#fff', marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: '#2e2b27' }}>Provider</div>
            {connectionStatus && (
              <div style={{ fontSize: 11.5, display: 'flex', alignItems: 'center', gap: 5, color: connectionStatus.dot }}>
                <span>●</span>
                <span>{connectionStatus.text}</span>
                <span style={{ color: '#6f6b66' }}>{connectionStatus.sub}</span>
              </div>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <select
                value={provider}
                onChange={(e) => handleProviderChange(e.target.value as ProviderType)}
                style={{
                  width: '100%',
                  border: '1px solid #ebe7e1',
                  borderRadius: 7,
                  padding: '7px 10px',
                  fontSize: 13,
                  background: '#fff',
                  color: '#2e2b27',
                  outline: 'none',
                }}
              >
                <option value="openwebui">Open WebUI</option>
                <option value="openrouter">OpenRouter</option>
                <option value="custom">Custom (OpenAI-compatible)</option>
                <option value="opencode-go">Opencode Go</option>
              </select>
            </div>
            <div>
              {provider === 'custom' ? (
                <input
                  type="text"
                  value={customConfig.selectedModel || ''}
                  onChange={(e) => {
                    handleCustomConfigChange({ selectedModel: e.target.value });
                  }}
                  placeholder="Enter model name..."
                  style={{
                    width: '100%',
                    border: '1px solid #ebe7e1',
                    borderRadius: 7,
                    padding: '7px 10px',
                    fontSize: 13,
                    background: '#fff',
                    color: '#2e2b27',
                    outline: 'none',
                  }}
                />
              ) : (
                <select
                  value={
                    provider === 'openwebui'
                      ? openwebuiConfig.selectedModel || ''
                      : provider === 'openrouter'
                        ? openrouterConfig.selectedModel || ''
                        : opencodeGoConfig.selectedModel || ''
                  }
                  onChange={(e) => {
                    if (provider === 'openwebui') {
                      handleOpenwebuiConfigChange({ selectedModel: e.target.value });
                    } else if (provider === 'openrouter') {
                      handleOpenrouterConfigChange({ selectedModel: e.target.value });
                    } else {
                      handleOpencodeGoConfigChange({ selectedModel: e.target.value });
                    }
                  }}
                  style={{
                    width: '100%',
                    border: '1px solid #ebe7e1',
                    borderRadius: 7,
                    padding: '7px 10px',
                    fontSize: 13,
                    background: '#fff',
                    color: '#2e2b27',
                    outline: 'none',
                  }}
                >
                  {api.availableModels.length === 0 ? (
                    <option value="">No models — test connection</option>
                  ) : (
                    api.availableModels.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))
                  )}
                </select>
              )}
            </div>
          </div>
        </div>

        {/* Credentials form */}
        {provider === 'openwebui' && (
          <OpenWebUIConfigForm
            config={openwebuiConfig as OpenWebUIConfig}
            availableModels={api.availableModels}
            streamingEnabled={streamingEnabled}
            onConfigChange={handleOpenwebuiConfigChange}
            onStreamingChange={handleStreamingChange}
            onTestConnection={handleTestConnection}
            testResult={testResult}
            testing={testing}
          />
        )}

        {provider === 'openrouter' && (
          <OpenRouterConfigForm
            config={openrouterConfig as OpenRouterConfig}
            availableModels={api.availableModels}
            streamingEnabled={streamingEnabled}
            onConfigChange={handleOpenrouterConfigChange}
            onStreamingChange={handleStreamingChange}
            onTestConnection={handleTestConnection}
            testResult={testResult}
            testing={testing}
          />
        )}

        {provider === 'custom' && (
          <CustomConfigForm
            config={customConfig as CustomProviderConfig}
            streamingEnabled={streamingEnabled}
            onConfigChange={handleCustomConfigChange}
            onStreamingChange={handleStreamingChange}
            onTestConnection={handleTestConnection}
            testResult={testResult}
            testing={testing}
          />
        )}

        {provider === 'opencode-go' && (
          <OpencodeGoConfigForm
            config={opencodeGoConfig as OpencodeGoConfig}
            streamingEnabled={streamingEnabled}
            onConfigChange={handleOpencodeGoConfigChange}
            onStreamingChange={handleStreamingChange}
            onTestConnection={handleTestConnection}
            testResult={testResult}
            testing={testing}
          />
        )}
      </div>
    </div>
  );
}

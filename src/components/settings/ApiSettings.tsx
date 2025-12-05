import React, { useState, useEffect } from 'react';
import { Input } from '../common/Input';
import { Button } from '../common/Button';
import { ModelSelector } from './ModelSelector';
import { useAppSelector, useAppDispatch } from '../../store';
import { setApiConfig, setAvailableModels, setPreferences } from '../../store/slices/settingsSlice';
import { getOpenWebUIService } from '../../services/api/openWebUI.service';

export function ApiSettings() {
  const dispatch = useAppDispatch();
  const { api, preferences } = useAppSelector((state) => state.settings);

  const [baseUrl, setBaseUrl] = useState(api.baseUrl);
  const [apiKey, setApiKey] = useState(api.apiKey);
  const [selectedModel, setSelectedModel] = useState(api.selectedModel);
  const [streamingEnabled, setStreamingEnabled] = useState(preferences.streamingEnabled);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  const [errors, setErrors] = useState<{
    baseUrl?: string;
    apiKey?: string;
  }>({});

  // Sync local state with Redux store when it changes
  useEffect(() => {
    setBaseUrl(api.baseUrl);
    setApiKey(api.apiKey);
    setSelectedModel(api.selectedModel);
    setStreamingEnabled(preferences.streamingEnabled);
  }, [api.baseUrl, api.apiKey, api.selectedModel, preferences.streamingEnabled]);


  const validateForm = (): boolean => {
    const newErrors: typeof errors = {};

    if (!baseUrl.trim()) {
      newErrors.baseUrl = 'API URL is required';
    } else {
      try {
        new URL(baseUrl);
      } catch {
        newErrors.baseUrl = 'Please enter a valid URL';
      }
    }

    if (!apiKey.trim()) {
      newErrors.apiKey = 'API Key is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleTestConnection = async () => {
    if (!validateForm()) return;

    setTesting(true);
    setTestResult(null);

    try {
      const service = getOpenWebUIService(baseUrl, apiKey);
      const models = await service.getModels();

      setTestResult({
        success: true,
        message: `Connected successfully! Found ${models.length} model(s).`,
      });

      // Update available models in store
      dispatch(setAvailableModels(models.map((m) => m.id)));

      // If no model selected, select the first one
      if (!selectedModel && models.length > 0) {
        setSelectedModel(models[0].id);
      }
    } catch (error) {
      setTestResult({
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed',
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!validateForm()) return;

    setSaving(true);

    try {
      const config = {
        baseUrl,
        apiKey,
        selectedModel,
      };

      // Save to Electron store
      await window.electron.config.set({
        api: config,
        preferences: { streamingEnabled },
      });

      // Update Redux store
      dispatch(setApiConfig(config));
      dispatch(setPreferences({ streamingEnabled }));

      setTestResult({
        success: true,
        message: 'Settings saved successfully!',
      });
    } catch (error) {
      setTestResult({
        success: false,
        message: 'Failed to save settings',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="mb-4 text-lg font-semibold text-text-primary">
          Open WebUI Configuration
        </h3>
        <p className="mb-6 text-sm text-text-secondary">
          Connect to your Open WebUI instance to start chatting.
        </p>
      </div>

      <Input
        label="API URL"
        placeholder="http://localhost:8080"
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        error={errors.baseUrl}
        helperText="The URL of your Open WebUI instance"
      />

      <Input
        label="API Key"
        type="password"
        placeholder="sk-..."
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        error={errors.apiKey}
        helperText="Get your API key from Settings > Account in Open WebUI"
      />

      <div className="flex gap-2">
        <Button
          onClick={handleTestConnection}
          disabled={testing}
          variant="secondary"
        >
          {testing ? 'Testing...' : 'Test Connection'}
        </Button>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save Settings'}
        </Button>
      </div>

      {testResult && (
        <div
          className={`rounded border p-3 ${testResult.success
            ? 'border-success bg-success bg-opacity-10 text-success'
            : 'border-error bg-error bg-opacity-10 text-error'
            }`}
        >
          <p className="text-sm" style={{ color: 'white' }}>{testResult.message}</p>
        </div>
      )}

      {api.availableModels.length > 0 && (
        <>
          <div className="mt-6">
            <ModelSelector
              value={selectedModel}
              onChange={setSelectedModel}
              models={api.availableModels}
            />
          </div>

          {/* Streaming toggle */}
          <div className="mt-6">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={streamingEnabled}
                onChange={(e) => setStreamingEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-border text-accent focus:ring-2 focus:ring-accent focus:ring-offset-2"
              />
              <div>
                <span className="text-sm font-medium text-text-primary">
                  Enable Streaming
                </span>
                <p className="text-xs text-text-secondary">
                  Show responses in real-time as they're generated (recommended)
                </p>
              </div>
            </label>
          </div>
        </>
      )}
    </div>
  );
}

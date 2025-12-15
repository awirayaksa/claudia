import { useState } from 'react';
import { Input } from '../common/Input';
import { Button } from '../common/Button';
import { ModelSelector } from './ModelSelector';
import { OpenWebUIConfig } from '../../types/api.types';

interface OpenWebUIConfigFormProps {
  config: OpenWebUIConfig | undefined;
  availableModels: string[];
  streamingEnabled: boolean;
  onConfigChange: (config: Partial<OpenWebUIConfig>) => void;
  onStreamingChange: (enabled: boolean) => void;
  onTestConnection: () => Promise<void>;
  onSave: () => Promise<void>;
  testResult: { success: boolean; message: string } | null;
  testing: boolean;
  saving: boolean;
}

export function OpenWebUIConfigForm({
  config,
  availableModels,
  streamingEnabled,
  onConfigChange,
  onStreamingChange,
  onTestConnection,
  onSave,
  testResult,
  testing,
  saving,
}: OpenWebUIConfigFormProps) {
  const [errors, setErrors] = useState<{
    baseUrl?: string;
    apiKey?: string;
  }>({});

  const validateForm = (): boolean => {
    const newErrors: typeof errors = {};

    if (!config?.baseUrl?.trim()) {
      newErrors.baseUrl = 'API URL is required';
    } else {
      try {
        new URL(config.baseUrl);
      } catch {
        newErrors.baseUrl = 'Please enter a valid URL';
      }
    }

    if (!config?.apiKey?.trim()) {
      newErrors.apiKey = 'API Key is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleTestConnection = async () => {
    if (!validateForm()) return;
    await onTestConnection();
  };

  const handleSave = async () => {
    if (!validateForm()) return;
    await onSave();
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
        value={config?.baseUrl || ''}
        onChange={(e) => onConfigChange({ baseUrl: e.target.value })}
        error={errors.baseUrl}
        helperText="The URL of your Open WebUI instance"
      />

      <Input
        label="API Key"
        type="password"
        placeholder="sk-..."
        value={config?.apiKey || ''}
        onChange={(e) => onConfigChange({ apiKey: e.target.value })}
        error={errors.apiKey}
        helperText="Get your API key from Settings > Account in Open WebUI"
        showPasswordToggle
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

      {availableModels.length > 0 && (
        <>
          <div className="mt-6">
            <ModelSelector
              value={config?.selectedModel || ''}
              onChange={(value) => onConfigChange({ selectedModel: value })}
              models={availableModels}
            />
          </div>

          {/* Streaming toggle */}
          <div className="mt-6">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={streamingEnabled}
                onChange={(e) => onStreamingChange(e.target.checked)}
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

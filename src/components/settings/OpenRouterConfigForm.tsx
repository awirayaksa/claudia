import { useState } from 'react';
import { Input } from '../common/Input';
import { Button } from '../common/Button';
import { ModelSelector } from './ModelSelector';
import { OpenRouterConfig } from '../../types/api.types';

interface OpenRouterConfigFormProps {
  config: OpenRouterConfig | undefined;
  availableModels: string[];
  streamingEnabled: boolean;
  onConfigChange: (config: Partial<OpenRouterConfig>) => void;
  onStreamingChange: (enabled: boolean) => void;
  onTestConnection: () => Promise<void>;
  onSave: () => Promise<void>;
  testResult: { success: boolean; message: string } | null;
  testing: boolean;
  saving: boolean;
}

export function OpenRouterConfigForm({
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
}: OpenRouterConfigFormProps) {
  const [errors, setErrors] = useState<{
    apiKey?: string;
  }>({});

  const validateForm = (): boolean => {
    const newErrors: typeof errors = {};

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
          OpenRouter Configuration
        </h3>
        <p className="mb-6 text-sm text-text-secondary">
          Connect to OpenRouter to access a wide range of AI models.
        </p>
      </div>

      <Input
        label="API Key"
        type="password"
        placeholder="sk-or-v1-..."
        value={config?.apiKey || ''}
        onChange={(e) => onConfigChange({ apiKey: e.target.value })}
        error={errors.apiKey}
        helperText="Your OpenRouter API key"
        showPasswordToggle
      />

      <Input
        label="Site URL (Optional)"
        placeholder="https://myapp.com"
        value={config?.siteUrl || ''}
        onChange={(e) => onConfigChange({ siteUrl: e.target.value })}
        helperText="Your app URL for OpenRouter dashboard tracking"
      />

      <Input
        label="Site Name (Optional)"
        placeholder="My App"
        value={config?.siteName || ''}
        onChange={(e) => onConfigChange({ siteName: e.target.value })}
        helperText="Your app name for OpenRouter dashboard display"
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

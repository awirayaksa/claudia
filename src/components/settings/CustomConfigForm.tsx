import { useState } from 'react';
import { Input } from '../common/Input';
import { Button } from '../common/Button';
import { CustomProviderConfig } from '../../types/api.types';

interface CustomConfigFormProps {
  config: CustomProviderConfig | undefined;
  streamingEnabled: boolean;
  onConfigChange: (config: Partial<CustomProviderConfig>) => void;
  onStreamingChange: (enabled: boolean) => void;
  onTestConnection: () => Promise<void>;
  testResult: { success: boolean; message: string } | null;
  testing: boolean;
}

export function CustomConfigForm({
  config,
  streamingEnabled,
  onConfigChange,
  onStreamingChange,
  onTestConnection,
  testResult,
  testing,
}: CustomConfigFormProps) {
  const [errors, setErrors] = useState<{
    baseUrl?: string;
    apiKey?: string;
    selectedModel?: string;
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

    if (!config?.selectedModel?.trim()) {
      newErrors.selectedModel = 'Model name is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleTestConnection = async () => {
    if (!validateForm()) return;
    await onTestConnection();
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="mb-4 text-lg font-semibold text-text-primary">
          Custom Provider Configuration
        </h3>
        <p className="mb-6 text-sm text-text-secondary">
          Connect to any OpenAI-compatible API endpoint.
        </p>
      </div>

      <Input
        label="API URL"
        placeholder="https://api.example.com/v1"
        value={config?.baseUrl || ''}
        onChange={(e) => onConfigChange({ baseUrl: e.target.value })}
        error={errors.baseUrl}
        helperText="The base URL of your OpenAI-compatible API endpoint"
      />

      <Input
        label="API Key"
        type="password"
        placeholder="sk-..."
        value={config?.apiKey || ''}
        onChange={(e) => onConfigChange({ apiKey: e.target.value })}
        error={errors.apiKey}
        helperText="Your API key for authentication"
        showPasswordToggle
      />

      <Input
        label="Model Name"
        placeholder="gpt-4o"
        value={config?.selectedModel || ''}
        onChange={(e) => onConfigChange({ selectedModel: e.target.value })}
        error={errors.selectedModel}
        helperText="The exact model identifier to use (e.g., gpt-4o, claude-3-opus-20240229)"
      />

      <div className="flex gap-2">
        <Button
          onClick={handleTestConnection}
          disabled={testing}
          variant="secondary"
        >
          {testing ? 'Testing...' : 'Test Connection'}
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
    </div>
  );
}

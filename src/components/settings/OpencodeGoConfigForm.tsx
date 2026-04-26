import { useState } from 'react';
import { Input } from '../common/Input';
import { Button } from '../common/Button';
import { OpencodeGoConfig } from '../../types/api.types';

interface OpencodeGoConfigFormProps {
  config: OpencodeGoConfig | undefined;
  streamingEnabled: boolean;
  onConfigChange: (config: Partial<OpencodeGoConfig>) => void;
  onStreamingChange: (enabled: boolean) => void;
  onTestConnection: () => Promise<void>;
  onSave: () => Promise<void>;
  testResult: { success: boolean; message: string } | null;
  testing: boolean;
  saving: boolean;
}

export function OpencodeGoConfigForm({
  config,
  streamingEnabled,
  onConfigChange,
  onStreamingChange,
  onTestConnection,
  onSave,
  testResult,
  testing,
  saving,
}: OpencodeGoConfigFormProps) {
  const [errors, setErrors] = useState<{
    baseUrl?: string;
    apiKey?: string;
    selectedModel?: string;
  }>({});

  const validateForm = (): boolean => {
    const newErrors: typeof errors = {};

    if (!config?.baseUrl?.trim()) {
      newErrors.baseUrl = 'Base URL is required';
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

  const handleSave = async () => {
    if (!validateForm()) return;
    await onSave();
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="mb-4 text-lg font-semibold text-text-primary">
          Opencode Go Configuration
        </h3>
        <p className="mb-6 text-sm text-text-secondary">
          Connect to the Opencode Go managed service or a local Opencode server.
        </p>
      </div>

      <Input
        label="Base URL"
        placeholder="https://opencode.ai/zen/go"
        value={config?.baseUrl ?? 'https://opencode.ai/zen/go'}
        onChange={(e) => onConfigChange({ baseUrl: e.target.value })}
        error={errors.baseUrl}
        helperText="Managed service: https://opencode.ai/zen/go · Local: http://127.0.0.1:4096"
      />

      <Input
        label="API Key"
        type="password"
        placeholder="Your Opencode Go API key"
        value={config?.apiKey || ''}
        onChange={(e) => onConfigChange({ apiKey: e.target.value })}
        error={errors.apiKey}
        helperText="Get your API key from opencode.ai/zen"
        showPasswordToggle
      />

      <div>
        <label
          style={{
            display: 'block',
            fontSize: 12.5,
            fontWeight: 500,
            marginBottom: 6,
            color: '#2e2b27',
          }}
        >
          API Compatibility
        </label>
        <select
          value={config?.apiCompatibility ?? 'openai'}
          onChange={(e) =>
            onConfigChange({ apiCompatibility: e.target.value as 'openai' | 'anthropic' })
          }
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
          <option value="openai">OpenAI-compatible (/v1/chat/completions)</option>
          <option value="anthropic">Anthropic-compatible (/v1/messages)</option>
        </select>
        <p style={{ fontSize: 11.5, color: '#6f6b66', marginTop: 4 }}>
          Choose the API format your Opencode server uses
        </p>
      </div>

      <Input
        label="Model Name"
        placeholder="kimi-k2.6"
        value={config?.selectedModel || ''}
        onChange={(e) => onConfigChange({ selectedModel: e.target.value })}
        error={errors.selectedModel}
        helperText="Models are auto-populated when you click Test Connection. You can also enter a model ID manually (e.g., kimi-k2.6, deepseek-v4-pro)."
      />

      <div className="flex gap-2">
        <Button onClick={handleTestConnection} disabled={testing} variant="secondary">
          {testing ? 'Testing...' : 'Test Connection'}
        </Button>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save Settings'}
        </Button>
      </div>

      {testResult && (
        <div
          className={`rounded border p-3 ${
            testResult.success
              ? 'border-success bg-success bg-opacity-10 text-success'
              : 'border-error bg-error bg-opacity-10 text-error'
          }`}
        >
          <p className="text-sm" style={{ color: 'white' }}>
            {testResult.message}
          </p>
        </div>
      )}

      <div className="mt-6">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={streamingEnabled}
            onChange={(e) => onStreamingChange(e.target.checked)}
            className="h-4 w-4 rounded border-border text-accent focus:ring-2 focus:ring-accent focus:ring-offset-2"
          />
          <div>
            <span className="text-sm font-medium text-text-primary">Enable Streaming</span>
            <p className="text-xs text-text-secondary">
              Show responses in real-time as they're generated (recommended)
            </p>
          </div>
        </label>
      </div>
    </div>
  );
}

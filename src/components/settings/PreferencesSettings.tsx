import { Input } from '../common/Input';
import { useAppSelector, useAppDispatch } from '../../store';
import { setPreferences } from '../../store/slices/settingsSlice';
import { Logger } from '../../services/logger.service';

export function PreferencesSettings() {
  const dispatch = useAppDispatch();
  const { temperature, logLevel, enableFileLogging } = useAppSelector((state) => state.settings.preferences);

  const handleTemperatureChange = async (value: number) => {
    dispatch(setPreferences({ temperature: value }));
    await window.electron.config.set({ preferences: { temperature: value } });
  };

  const handleLogLevelChange = async (value: 'debug' | 'info' | 'warn' | 'error') => {
    dispatch(setPreferences({ logLevel: value }));
    await window.electron.config.set({ preferences: { logLevel: value } });
    // Update logger configuration
    Logger.updateConfig({ logLevel: value });
  };

  const handleFileLoggingToggle = async (enabled: boolean) => {
    dispatch(setPreferences({ enableFileLogging: enabled }));
    await window.electron.config.set({ preferences: { enableFileLogging: enabled } });
    // Update logger configuration
    Logger.updateConfig({ enableFileLogging: enabled });
  };

  const handleOpenLogsFolder = async () => {
    try {
      await window.electron.logger.openLogsFolder();
    } catch (error) {
      console.error('Failed to open logs folder:', error);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="mb-4 text-lg font-semibold text-text-primary">
          Model Preferences
        </h3>
        <p className="mb-6 text-sm text-text-secondary">
          Configure model parameters for API requests.
        </p>
      </div>

      <Input
        label="Temperature"
        type="number"
        min="0"
        max="2"
        step="0.1"
        value={temperature}
        onChange={(e) => handleTemperatureChange(Number(e.target.value))}
        helperText="Controls randomness. Lower is more focused, higher is more creative (0-2, default: 0.7)"
      />

      <div className="rounded border border-border bg-surface p-4">
        <p className="text-sm text-text-secondary">
          <strong className="text-text-primary">Note:</strong> Token limits are managed by your API provider (OpenRouter).
          If you encounter token limit errors, you may need to upgrade your account or use a different model.
        </p>
      </div>

      {/* Logging Section */}
      <div className="border-t border-border pt-6">
        <h3 className="mb-4 text-lg font-semibold text-text-primary">
          Logging
        </h3>
        <p className="mb-6 text-sm text-text-secondary">
          Configure logging behavior for debugging and troubleshooting.
        </p>
      </div>

      {/* Log Level Dropdown */}
      <div>
        <label className="mb-2 block text-sm font-medium text-text-primary">
          Log Level
        </label>
        <select
          value={logLevel}
          onChange={(e) => handleLogLevelChange(e.target.value as any)}
          className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <option value="debug">Debug (Most Verbose)</option>
          <option value="info">Info</option>
          <option value="warn">Warnings Only</option>
          <option value="error">Errors Only</option>
        </select>
        <p className="mt-1 text-xs text-text-secondary">
          Controls which log messages are displayed and saved. Debug shows all logs, Error shows only errors.
        </p>
      </div>

      {/* Enable File Logging Toggle */}
      <div className="flex items-center justify-between">
        <div>
          <label className="block text-sm font-medium text-text-primary">
            Enable File Logging
          </label>
          <p className="mt-1 text-xs text-text-secondary">
            Save logs to files for debugging purposes. Files are stored with daily rotation.
          </p>
        </div>
        <button
          onClick={() => handleFileLoggingToggle(!enableFileLogging)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            enableFileLogging ? 'bg-accent' : 'bg-gray-300'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              enableFileLogging ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {/* Open Logs Folder Button */}
      <div>
        <button
          onClick={handleOpenLogsFolder}
          className="rounded border border-border bg-surface px-4 py-2 text-sm text-text-primary hover:bg-surface-hover transition-colors"
        >
          Open Logs Folder
        </button>
        <p className="mt-1 text-xs text-text-secondary">
          Open the folder containing log files in your file explorer.
        </p>
      </div>

      <div className="rounded border border-yellow-500 bg-yellow-500 bg-opacity-10 p-4">
        <p className="text-sm text-text-secondary">
          <strong className="text-yellow-600 dark:text-yellow-400">Privacy Note:</strong> Logs may contain sensitive information including API keys, message content, and system paths. Only share log files with trusted parties.
        </p>
      </div>
    </div>
  );
}

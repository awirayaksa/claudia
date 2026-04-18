import { Input } from '../common/Input';
import { useAppSelector, useAppDispatch } from '../../store';
import { setPreferences } from '../../store/slices/settingsSlice';

export function PreferencesSettings() {
  const dispatch = useAppDispatch();
  const { temperature, showReasoning, showStatistics, systemPrompt, systemPromptFileName, updateCheckUrl } = useAppSelector((state) => state.settings.preferences);

  const handleTemperatureChange = async (value: number) => {
    dispatch(setPreferences({ temperature: value }));
    await window.electron.config.set({ preferences: { temperature: value } });
  };

  const handleShowReasoningChange = async (value: boolean) => {
    dispatch(setPreferences({ showReasoning: value }));
    await window.electron.config.set({ preferences: { showReasoning: value } });
  };

  const handleShowStatisticsChange = async (value: boolean) => {
    dispatch(setPreferences({ showStatistics: value }));
    await window.electron.config.set({ preferences: { showStatistics: value } });
  };

  const handleSystemPromptChange = async (value: string) => {
    dispatch(setPreferences({ systemPrompt: value, systemPromptFileName: '' }));
    await window.electron.config.set({ preferences: { systemPrompt: value, systemPromptFileName: '' } });
  };

  const handleSelectFile = async () => {
    const result = await window.electron.systemPrompt.selectFile();
    if (result) {
      dispatch(setPreferences({ systemPrompt: result.content, systemPromptFileName: result.fileName }));
      await window.electron.config.set({ preferences: { systemPrompt: result.content, systemPromptFileName: result.fileName } });
    }
  };

  const handleReset = async () => {
    dispatch(setPreferences({ systemPrompt: '', systemPromptFileName: '' }));
    await window.electron.config.set({ preferences: { systemPrompt: '', systemPromptFileName: '' } });
  };

  const handleUpdateCheckUrlChange = async (value: string) => {
    dispatch(setPreferences({ updateCheckUrl: value }));
    await window.electron.config.set({ preferences: { updateCheckUrl: value } });
    // Restart the periodic check with the new URL
    await window.electron.updater.restartCheck();
  };

  return (
    <div className="space-y-6" style={{ padding: '22px 28px' }}>
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

      <div>
        <h3 className="mb-4 text-lg font-semibold text-text-primary">System Prompt</h3>
        <p className="mb-4 text-sm text-text-secondary">
          Applied to all chat sessions globally. Leave empty for no system prompt.
        </p>
        {systemPromptFileName && (
          <p className="mb-2 text-xs text-text-secondary">
            Loaded from file: <span className="font-medium text-text-primary">{systemPromptFileName}</span>
          </p>
        )}
        <textarea
          value={systemPrompt}
          onChange={(e) => handleSystemPromptChange(e.target.value)}
          placeholder="Enter a system prompt, or select a .txt / .md file below..."
          rows={6}
          className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-text-primary placeholder-text-secondary focus:outline-none focus:ring-2 focus:ring-accent hover:border-accent resize-y"
        />
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={handleSelectFile}
            className="rounded border border-border bg-surface px-3 py-1.5 text-sm text-text-primary hover:border-accent hover:bg-background transition-colors"
          >
            Select .txt or .md file
          </button>
          {systemPrompt && (
            <button
              type="button"
              onClick={handleReset}
              className="rounded border border-border bg-surface px-3 py-1.5 text-sm text-text-secondary hover:border-red-500 hover:text-red-500 transition-colors"
            >
              Reset
            </button>
          )}
        </div>
      </div>

      <div>
        <h3 className="mb-4 text-lg font-semibold text-text-primary">
          Display Preferences
        </h3>
        <p className="mb-6 text-sm text-text-secondary">
          Configure what information to display in chat messages.
        </p>
      </div>

      <div className="space-y-4">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={showReasoning}
            onChange={(e) => handleShowReasoningChange(e.target.checked)}
            className="h-4 w-4 rounded border-border bg-surface text-accent focus:ring-2 focus:ring-accent focus:ring-offset-0"
          />
          <div className="flex-1">
            <div className="text-sm font-medium text-text-primary">Show Reasoning</div>
            <div className="text-xs text-text-secondary">
              Display the model's reasoning process when available (extended thinking models)
            </div>
          </div>
        </label>

        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={showStatistics}
            onChange={(e) => handleShowStatisticsChange(e.target.checked)}
            className="h-4 w-4 rounded border-border bg-surface text-accent focus:ring-2 focus:ring-accent focus:ring-offset-0"
          />
          <div className="flex-1">
            <div className="text-sm font-medium text-text-primary">Show Statistics</div>
            <div className="text-xs text-text-secondary">
              Display token usage, cost, and performance metrics for each response
            </div>
          </div>
        </label>
      </div>

      <div>
        <h3 className="mb-4 text-lg font-semibold text-text-primary">Auto Update</h3>
        <p className="mb-4 text-sm text-text-secondary">
          Automatically check for newer portable versions. The URL must point to a JSON manifest file
          with <code className="rounded bg-surface px-1 py-0.5 text-xs font-mono text-text-primary">{"{ \"version\": \"x.y.z\", \"url\": \"...\" }"}</code>.
        </p>
        <Input
          label="Update Check URL"
          type="url"
          value={updateCheckUrl}
          onChange={(e) => handleUpdateCheckUrlChange(e.target.value)}
          placeholder="https://example.com/releases/latest.json"
          helperText="Leave empty to disable automatic update checks"
        />
      </div>
    </div>
  );
}

import { Input } from '../common/Input';
import { useAppSelector, useAppDispatch } from '../../store';
import { setPreferences } from '../../store/slices/settingsSlice';

export function PreferencesSettings() {
  const dispatch = useAppDispatch();
  const { temperature, showReasoning, showStatistics } = useAppSelector((state) => state.settings.preferences);

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
    </div>
  );
}

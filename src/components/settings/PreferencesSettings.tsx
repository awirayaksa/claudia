import { Input } from '../common/Input';
import { useAppSelector, useAppDispatch } from '../../store';
import { setPreferences } from '../../store/slices/settingsSlice';

export function PreferencesSettings() {
  const dispatch = useAppDispatch();
  const { temperature } = useAppSelector((state) => state.settings.preferences);

  const handleTemperatureChange = async (value: number) => {
    dispatch(setPreferences({ temperature: value }));
    await window.electron.config.set({ preferences: { temperature: value } });
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
    </div>
  );
}

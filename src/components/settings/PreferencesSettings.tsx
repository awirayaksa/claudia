import { Input } from '../common/Input';
import { useAppSelector, useAppDispatch } from '../../store';
import { setPreferences } from '../../store/slices/settingsSlice';
import { EFFORT_LEVELS, ReasoningEffort } from '../../utils/effort-utils';
import { effortLabel } from '../chat/EffortSelector';
import { getPlatform } from '../../platform';
import { useT } from '../../i18n';

export function PreferencesSettings() {
  const t = useT();
  const dispatch = useAppDispatch();
  const { temperature, showReasoning, showStatistics, visualExplanations, pasteLongTextAsFile, systemPrompt, systemPromptFileName, updateCheckUrl, reasoningEffort } = useAppSelector((state) => state.settings.preferences);

  const platform = getPlatform();

  // Changes are a draft until the settings page saves them (SettingsDraft)
  const handleTemperatureChange = (value: number) => dispatch(setPreferences({ temperature: value }));
  const handleReasoningEffortChange = (value: ReasoningEffort | null) => dispatch(setPreferences({ reasoningEffort: value }));
  const handleShowReasoningChange = (value: boolean) => dispatch(setPreferences({ showReasoning: value }));
  const handleShowStatisticsChange = (value: boolean) => dispatch(setPreferences({ showStatistics: value }));
  const handleVisualExplanationsChange = (value: boolean) => dispatch(setPreferences({ visualExplanations: value }));
  const handlePasteLongChange = (value: boolean) => dispatch(setPreferences({ pasteLongTextAsFile: value }));
  const handleSystemPromptChange = (value: string) => dispatch(setPreferences({ systemPrompt: value, systemPromptFileName: '' }));

  const handleSelectFile = async () => {
    if (!platform.systemPrompt) return;
    const result = await platform.systemPrompt.selectFile();
    if (result) dispatch(setPreferences({ systemPrompt: result.content, systemPromptFileName: result.fileName }));
  };

  const handleReset = () => dispatch(setPreferences({ systemPrompt: '', systemPromptFileName: '' }));
  const handleUpdateCheckUrlChange = (value: string) => dispatch(setPreferences({ updateCheckUrl: value }));

  return (
    <div className="space-y-6" style={{ padding: '22px 28px' }}>
      <div>
        <h3 className="mb-4 text-lg font-semibold text-text-primary">
          {t('preferences.modelTitle', 'Model Preferences')}
        </h3>
        <p className="mb-6 text-sm text-text-secondary">
          {t('preferences.modelHelp', 'Configure model parameters for API requests.')}
        </p>
      </div>

      <Input
        label={t('preferences.temperature', 'Temperature')}
        type="number"
        min="0"
        max="2"
        step="0.1"
        value={temperature}
        onChange={(e) => handleTemperatureChange(Number(e.target.value))}
        helperText={t('preferences.temperatureHelp', 'Controls randomness. Lower is more focused, higher is more creative (0-2, default: 0.7)')}
      />

      <div>
        <label className="mb-1.5 block text-sm font-medium text-text-primary">
          {t('preferences.effort', 'Reasoning effort')}
        </label>
        <select
          value={reasoningEffort ?? ''}
          onChange={(e) => handleReasoningEffortChange((e.target.value || null) as ReasoningEffort | null)}
          className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="">{t('preferences.effortAuto', 'Auto (provider default)')}</option>
          {EFFORT_LEVELS.map((level) => (
            <option key={level} value={level}>
              {effortLabel(level)}
            </option>
          ))}
        </select>
        <p className="mt-1.5 text-xs text-text-secondary">
          {t(
            'preferences.effortHelp',
            "Default thinking budget for reasoning models. Models that don't offer the tier you pick fall back to their closest one (Qwen3.8, for example, only takes Low, Medium and X-High). Override it per session with the effort button next to the chat input, or per message by typing"
          )}{' '}
          <code className="text-text-primary">--effort high</code> {t('preferences.effortHelpEnd', 'in the prompt.')}
        </p>
      </div>

      <div className="rounded border border-border bg-surface p-4">
        <p className="text-sm text-text-secondary">
          <strong className="text-text-primary">{t('preferences.note', 'Note:')}</strong>{' '}
          {t(
            'preferences.tokenNote',
            'Token limits are managed by your API provider (OpenRouter). If you encounter token limit errors, you may need to upgrade your account or use a different model.'
          )}
        </p>
      </div>

      <div>
        <h3 className="mb-4 text-lg font-semibold text-text-primary">{t('preferences.systemPrompt', 'System Prompt')}</h3>
        <p className="mb-4 text-sm text-text-secondary">
          {t('preferences.systemPromptHelp', 'Applied to all chat sessions globally. Leave empty for no system prompt.')}
        </p>
        {systemPromptFileName && (
          <p className="mb-2 text-xs text-text-secondary">
            {t('preferences.loadedFrom', 'Loaded from file:')} <span className="font-medium text-text-primary">{systemPromptFileName}</span>
          </p>
        )}
        <textarea
          value={systemPrompt}
          onChange={(e) => handleSystemPromptChange(e.target.value)}
          placeholder={t('preferences.systemPromptPlaceholder', 'Enter a system prompt, or select a .txt / .md file below...')}
          rows={6}
          className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-text-primary placeholder-text-secondary focus:outline-none focus:ring-2 focus:ring-accent hover:border-accent resize-y"
        />
        <div className="mt-2 flex gap-2">
          {platform.systemPrompt && (
            <button
              type="button"
              onClick={handleSelectFile}
              className="rounded border border-border bg-surface px-3 py-1.5 text-sm text-text-primary hover:border-accent hover:bg-background transition-colors"
            >
              {t('preferences.selectFile', 'Select .txt or .md file')}
            </button>
          )}
          {systemPrompt && (
            <button
              type="button"
              onClick={handleReset}
              className="rounded border border-border bg-surface px-3 py-1.5 text-sm text-text-secondary hover:border-red-500 hover:text-red-500 transition-colors"
            >
              {t('preferences.reset', 'Reset')}
            </button>
          )}
        </div>
        <label className="mt-4 flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            // Older saved settings don't have it: on
            checked={visualExplanations !== false}
            onChange={(e) => handleVisualExplanationsChange(e.target.checked)}
            className="h-4 w-4 rounded border-border bg-surface text-accent focus:ring-2 focus:ring-accent focus:ring-offset-0"
          />
          <div className="flex-1">
            <div className="text-sm font-medium text-text-primary">{t('preferences.visualExplanations', 'Visual explanations')}</div>
            <div className="text-xs text-text-secondary">
              {t('preferences.visualExplanationsHelp', 'Let the model illustrate explanations with diagrams (added before your system prompt)')}
            </div>
          </div>
        </label>
        <label className="mt-4 flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={pasteLongTextAsFile !== false}
            onChange={(e) => handlePasteLongChange(e.target.checked)}
            className="h-4 w-4 rounded border-border bg-surface text-accent focus:ring-2 focus:ring-accent focus:ring-offset-0"
            data-testid="paste-long-as-file"
          />
          <div className="flex-1">
            <div className="text-sm font-medium text-text-primary">{t('preferences.pasteLongAsFile', 'Attach long pastes')}</div>
            <div className="text-xs text-text-secondary">
              {t('preferences.pasteLongAsFileHelp', 'Pasting a long text (2,000 characters or 40 lines) adds it as a "Pasted text" attachment instead of filling the message box. "Paste as plain text" in the right-click menu always pastes into the box.')}
            </div>
          </div>
        </label>
      </div>

      <div>
        <h3 className="mb-4 text-lg font-semibold text-text-primary">
          {t('preferences.displayTitle', 'Display Preferences')}
        </h3>
        <p className="mb-6 text-sm text-text-secondary">
          {t('preferences.displayHelp', 'Configure what information to display in chat messages.')}
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
            <div className="text-sm font-medium text-text-primary">{t('preferences.showReasoning', 'Show Reasoning')}</div>
            <div className="text-xs text-text-secondary">
              {t('preferences.showReasoningHelp', "Display the model's reasoning process when available (extended thinking models)")}
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
            <div className="text-sm font-medium text-text-primary">{t('preferences.showStatistics', 'Show Statistics')}</div>
            <div className="text-xs text-text-secondary">
              {t('preferences.showStatisticsHelp', 'Display token usage, cost, and performance metrics for each response')}
            </div>
          </div>
        </label>
      </div>

      {platform.capabilities.autoUpdate && (
      <div>
        <h3 className="mb-4 text-lg font-semibold text-text-primary">{t('preferences.autoUpdate', 'Auto Update')}</h3>
        <p className="mb-4 text-sm text-text-secondary">
          {t('preferences.autoUpdateHelp', 'Automatically check for newer portable versions. The URL must point to a JSON manifest file with')}{' '}
          <code className="rounded bg-surface px-1 py-0.5 text-xs font-mono text-text-primary">{"{ \"version\": \"x.y.z\", \"url\": \"...\" }"}</code>.
        </p>
        <Input
          label={t('preferences.updateUrl', 'Update Check URL')}
          type="url"
          value={updateCheckUrl}
          onChange={(e) => handleUpdateCheckUrlChange(e.target.value)}
          placeholder="https://example.com/releases/latest.json"
          helperText={t('preferences.updateUrlHelp', 'Leave empty to disable automatic update checks')}
        />
      </div>
      )}
    </div>
  );
}

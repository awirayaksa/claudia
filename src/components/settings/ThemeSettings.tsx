import { useState, useEffect } from 'react';
import { useTheme, Theme } from '../../hooks/useTheme';
import { useAppSelector } from '../../store';

export function ThemeSettings() {
  const { theme, setTheme, effectiveTheme } = useTheme();
  const appearance = useAppSelector((state) => state.settings.appearance);
  const customization = appearance.customization;

  // State for icon preview
  const [iconPreview, setIconPreview] = useState<string | null>(null);

  const themeOptions: { value: Theme; label: string; description: string; icon: string }[] = [
    {
      value: 'light',
      label: 'Light',
      description: 'Light color scheme',
      icon: '☀️',
    },
    {
      value: 'dark',
      label: 'Dark',
      description: 'Dark color scheme',
      icon: '🌙',
    },
    {
      value: 'system',
      label: 'System',
      description: 'Follow system preferences',
      icon: '💻',
    },
  ];

  // Default accent colors based on current theme
  const defaultAccentColor = effectiveTheme === 'dark' ? '#E8917B' : '#D97757';

  // Load icon preview on mount
  useEffect(() => {
    if (customization?.iconPath) {
      window.electron.icon.getPreview(customization.iconPath).then((preview) => {
        if (preview) {
          setIconPreview(preview);
        }
      });
    } else {
      setIconPreview(null);
    }
  }, [customization?.iconPath]);


  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-text-primary mb-3">Theme</h3>
        <div className="grid grid-cols-3 gap-3">
          {themeOptions.map((option) => (
            <button
              key={option.value}
              onClick={() => setTheme(option.value)}
              className={`flex flex-col items-center gap-2 rounded-lg border-2 p-4 transition-all ${
                theme === option.value
                  ? 'border-accent bg-accent bg-opacity-10'
                  : 'border-border bg-surface hover:bg-surface-hover'
              }`}
            >
              <span className="text-2xl">{option.icon}</span>
              <div className="text-center">
                <p className={`text-sm font-medium ${
                  theme === option.value ? 'text-accent' : 'text-text-primary'
                }`}>
                  {option.label}
                </p>
                <p className="text-xs text-text-secondary mt-1">
                  {option.description}
                </p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Preview section */}
      <div className="rounded-lg border border-border bg-surface p-4">
        <h4 className="text-sm font-medium text-text-primary mb-3">Preview</h4>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded bg-background border border-border" />
            <span className="text-xs text-text-secondary">Background</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded bg-surface border border-border" />
            <span className="text-xs text-text-secondary">Surface</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded bg-accent" />
            <span className="text-xs text-text-secondary">Accent</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded flex items-center justify-center border border-border">
              <span className="text-xs text-text-primary">Aa</span>
            </div>
            <span className="text-xs text-text-secondary">Text</span>
          </div>
        </div>
      </div>

      {/* Accent Color Customization */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold text-text-primary mb-3">Accent Color</h3>
        <div className="flex items-center gap-3">
          <input
            type="color"
            value={customization?.accentColor || defaultAccentColor}
            disabled
            className="w-16 h-16 rounded border-2 border-border opacity-50 cursor-not-allowed"
          />
          <div className="flex-1">
            <p className="text-sm font-medium text-text-primary">
              {customization?.accentColor || 'Default'}
            </p>
            <p className="text-xs text-text-secondary">
              Accent color is fixed for this build
            </p>
          </div>
        </div>
      </div>

      {/* Application Title */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold text-text-primary mb-3">Application Title</h3>
        <input
          type="text"
          value={customization?.appTitle || ''}
          disabled
          maxLength={50}
          className="w-full px-3 py-2 rounded border border-border bg-surface text-text-primary opacity-50 cursor-not-allowed"
        />
        <p className="text-xs text-text-secondary mt-2">
          Application title is fixed for this build
        </p>
      </div>

      {/* Application Icon */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold text-text-primary mb-3">Application Icon</h3>
        <div className="flex items-center gap-3">
          {iconPreview && (
            <img
              src={iconPreview}
              alt="Icon preview"
              className="w-16 h-16 rounded border-2 border-border object-contain"
            />
          )}
          <div className="flex-1">
            <button
              disabled
              className="px-4 py-2 bg-accent text-white rounded opacity-50 cursor-not-allowed"
            >
              Choose Icon
            </button>
            <p className="text-xs text-text-secondary mt-1">
              Application icon is fixed for this build
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

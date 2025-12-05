import React from 'react';
import { useTheme, Theme } from '../../hooks/useTheme';

export function ThemeSettings() {
  const { theme, setTheme } = useTheme();

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
    </div>
  );
}

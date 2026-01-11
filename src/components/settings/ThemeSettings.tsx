import { useState, useEffect } from 'react';
import { useTheme, Theme } from '../../hooks/useTheme';
import { useAppDispatch, useAppSelector } from '../../store';
import { setAppearance } from '../../store/slices/settingsSlice';

export function ThemeSettings() {
  const { theme, setTheme, effectiveTheme } = useTheme();
  const dispatch = useAppDispatch();
  const appearance = useAppSelector((state) => state.settings.appearance);
  const customization = appearance.customization;

  // State for icon preview and restart notification
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);

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

  // Handler for accent color change
  const handleColorChange = async (color: string) => {
    const newCustomization = { ...customization, accentColor: color };
    dispatch(setAppearance({ customization: newCustomization }));

    // Save to electron store
    try {
      await window.electron.config.set({ appearance: { ...appearance, customization: newCustomization } });
    } catch (error) {
      console.error('Failed to save accent color:', error);
    }
  };

  // Handler for resetting accent color
  const handleResetColor = async () => {
    const newCustomization = { ...customization, accentColor: undefined };
    dispatch(setAppearance({ customization: newCustomization }));

    // Save to electron store
    try {
      await window.electron.config.set({ appearance: { ...appearance, customization: newCustomization } });
    } catch (error) {
      console.error('Failed to reset accent color:', error);
    }
  };

  // Handler for app title change
  const handleTitleChange = async (title: string) => {
    const newCustomization = { ...customization, appTitle: title || undefined };
    dispatch(setAppearance({ customization: newCustomization }));

    // Save to electron store
    try {
      await window.electron.config.set({ appearance: { ...appearance, customization: newCustomization } });
    } catch (error) {
      console.error('Failed to save app title:', error);
    }
  };

  // Handler for icon upload
  const handleIconUpload = async () => {
    try {
      // Select icon file
      const filePath = await window.electron.icon.select();
      if (!filePath) return;

      // Upload to AppData
      const destPath = await window.electron.icon.upload(filePath);

      // Save to Redux and electron store
      const newCustomization = { ...customization, iconPath: destPath };
      dispatch(setAppearance({ customization: newCustomization }));
      await window.electron.config.set({ appearance: { ...appearance, customization: newCustomization } });

      // Try to apply immediately
      const result = await window.electron.icon.apply(destPath);

      // Get and set preview
      const preview = await window.electron.icon.getPreview(destPath);
      if (preview) {
        setIconPreview(preview);
      }

      if (result.requiresRestart) {
        setRestartRequired(true);
      }
    } catch (error: any) {
      console.error('Failed to upload icon:', error);
      alert(`Failed to upload icon: ${error.message || 'Unknown error'}`);
    }
  };

  // Handler for resetting icon
  const handleResetIcon = async () => {
    try {
      const newCustomization = { ...customization, iconPath: undefined };
      dispatch(setAppearance({ customization: newCustomization }));
      await window.electron.config.set({ appearance: { ...appearance, customization: newCustomization } });
      await window.electron.icon.reset();
      setIconPreview(null);
      setRestartRequired(false);
    } catch (error) {
      console.error('Failed to reset icon:', error);
    }
  };

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
            onChange={(e) => handleColorChange(e.target.value)}
            className="w-16 h-16 rounded border-2 border-border cursor-pointer"
          />
          <div className="flex-1">
            <p className="text-sm font-medium text-text-primary">
              {customization?.accentColor || 'Default'}
            </p>
            <p className="text-xs text-text-secondary">
              Click to customize accent color
            </p>
          </div>
          {customization?.accentColor && (
            <button
              onClick={handleResetColor}
              className="text-sm text-accent hover:text-accent-hover"
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {/* Application Title */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold text-text-primary mb-3">Application Title</h3>
        <input
          type="text"
          value={customization?.appTitle || ''}
          placeholder="Claudia"
          onChange={(e) => handleTitleChange(e.target.value)}
          maxLength={50}
          className="w-full px-3 py-2 rounded border border-border bg-surface text-text-primary focus:outline-none focus:border-accent"
        />
        <p className="text-xs text-text-secondary mt-2">
          Updates window title, menu items, and about dialog
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
              onClick={handleIconUpload}
              className="px-4 py-2 bg-accent text-white rounded hover:bg-accent-hover"
            >
              Choose Icon
            </button>
            <p className="text-xs text-text-secondary mt-1">
              PNG or ICO format, max 1MB
            </p>
          </div>
          {customization?.iconPath && (
            <button
              onClick={handleResetIcon}
              className="text-sm text-accent hover:text-accent-hover"
            >
              Reset
            </button>
          )}
        </div>

        {restartRequired && (
          <div className="mt-3 p-3 bg-surface-hover rounded border border-border">
            <p className="text-sm text-text-primary mb-2">
              Restart required to apply icon changes
            </p>
            <button
              onClick={() => window.location.reload()}
              className="px-3 py-1 bg-accent text-white rounded text-xs hover:bg-accent-hover"
            >
              Restart Now
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

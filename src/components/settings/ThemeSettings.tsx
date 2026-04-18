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

  const accentSwatches = [
    { hex: '#c96a3d', label: 'Terracotta' },
    { hex: '#3d7bc9', label: 'Blue' },
    { hex: '#3d9966', label: 'Forest' },
    { hex: '#7d5dc9', label: 'Violet' },
    { hex: '#525252', label: 'Slate' },
    { hex: '#b1843a', label: 'Ochre' },
  ];

  const currentAccent = customization?.accentColor || defaultAccentColor;
  const isSwatchSelected = (hex: string) =>
    currentAccent.toLowerCase() === hex.toLowerCase();

  const themeIcons: Record<string, string> = { light: '☀', dark: '☾', system: '◨' };

  const [density, setDensity] = useState<'compact' | 'comfortable' | 'spacious'>('comfortable');

  return (
    <div>
      {/* Section header */}
      <div style={{ padding: '22px 28px 18px', borderBottom: '1px solid #ebe7e1' }}>
        <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: -0.2, marginBottom: 4, color: '#1a1a19' }}>
          Appearance
        </div>
        <div style={{ fontSize: 13, color: '#6f6b66', lineHeight: 1.55 }}>
          Tune how Claudia looks on your system.
        </div>
      </div>

      <div style={{ padding: '22px 28px' }}>
        {/* Theme */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: '#2e2b27', marginBottom: 8 }}>Theme</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            {themeOptions.map((option) => {
              const selected = theme === option.value;
              return (
                <button
                  key={option.value}
                  onClick={() => setTheme(option.value)}
                  style={{
                    border: selected ? '2px solid #c96a3d' : '1px solid #ebe7e1',
                    background: selected ? '#faf2ec' : '#fff',
                    borderRadius: 8,
                    padding: '10px 12px',
                    fontSize: 13,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    textAlign: 'left',
                  }}
                >
                  <span style={{ fontSize: 16, color: selected ? '#c96a3d' : '#2e2b27' }}>
                    {themeIcons[option.value]}
                  </span>
                  <span style={{ fontWeight: selected ? 600 : 450, color: '#2e2b27' }}>
                    {option.label}
                  </span>
                  {selected && (
                    <span style={{ marginLeft: 'auto', color: '#c96a3d', fontSize: 12 }}>✓</span>
                  )}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 11.5, color: '#6f6b66', marginTop: 6 }}>
            System matches your OS appearance and auto-switches.
          </div>
        </div>

        {/* Accent color */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: '#2e2b27', marginBottom: 8 }}>
            Accent color
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {accentSwatches.map((swatch) => {
              const selected = isSwatchSelected(swatch.hex);
              return (
                <button
                  key={swatch.hex}
                  title={swatch.label}
                  onClick={() => handleColorChange(swatch.hex)}
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: '50%',
                    background: swatch.hex,
                    border: selected ? '2px solid #1a1a19' : '2px solid transparent',
                    boxShadow: selected ? '0 0 0 2px #fff inset' : 'none',
                    cursor: 'pointer',
                    padding: 0,
                    flexShrink: 0,
                  }}
                />
              );
            })}
            {/* Custom color picker */}
            <label
              title="Custom color"
              style={{
                width: 30,
                height: 30,
                borderRadius: '50%',
                border: '1px dashed #6f6b66',
                background: '#fff',
                color: '#6f6b66',
                fontSize: 14,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                position: 'relative',
                flexShrink: 0,
              }}
            >
              +
              <input
                type="color"
                value={currentAccent}
                onChange={(e) => handleColorChange(e.target.value)}
                style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
              />
            </label>
            <span style={{ fontSize: 12, color: '#6f6b66', marginLeft: 4 }}>
              {accentSwatches.find((s) => isSwatchSelected(s.hex))?.label || 'Custom'}
              {!customization?.accentColor && ' (default)'}
            </span>
            {customization?.accentColor && (
              <button
                onClick={handleResetColor}
                style={{
                  fontSize: 11.5,
                  color: '#c96a3d',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                Reset
              </button>
            )}
          </div>
        </div>

        {/* Preview */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: '#2e2b27', marginBottom: 8 }}>Preview</div>
          <div
            style={{
              border: '1px solid #ebe7e1',
              borderRadius: 10,
              padding: 14,
              background: '#faf8f5',
            }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 12, marginBottom: 14 }}>
              {[
                ['Background', '#fdfcfa'],
                ['Surface', '#ffffff'],
                ['Accent', currentAccent],
                ['Text', '#1a1a19'],
              ].map(([label, color]) => (
                <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 5,
                      background: color,
                      border: '1px solid #ebe7e1',
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ color: '#2e2b27' }}>{label}</span>
                  <span
                    style={{
                      color: '#6f6b66',
                      fontFamily: 'ui-monospace, Menlo, monospace',
                      fontSize: 11,
                    }}
                  >
                    {color}
                  </span>
                </div>
              ))}
            </div>
            <div
              style={{
                padding: '10px 12px',
                background: '#fff',
                borderRadius: 8,
                border: '1px solid #ebe7e1',
                fontSize: 12.5,
              }}
            >
              <b>Claudia</b> — Here's a sample message to preview your theme.
              <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
                <button
                  style={{
                    background: currentAccent,
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    padding: '4px 10px',
                    fontSize: 11.5,
                    cursor: 'pointer',
                  }}
                >
                  Primary
                </button>
                <button
                  style={{
                    background: '#fff',
                    color: '#2e2b27',
                    border: '1px solid #ebe7e1',
                    borderRadius: 6,
                    padding: '4px 10px',
                    fontSize: 11.5,
                    cursor: 'pointer',
                  }}
                >
                  Secondary
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Density */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: '#2e2b27', marginBottom: 8 }}>Density</div>
          <div
            style={{
              display: 'inline-flex',
              border: '1px solid #ebe7e1',
              borderRadius: 7,
              overflow: 'hidden',
            }}
          >
            {(['compact', 'comfortable', 'spacious'] as const).map((d, i) => (
              <button
                key={d}
                onClick={() => setDensity(d)}
                style={{
                  border: 'none',
                  padding: '6px 14px',
                  fontSize: 12,
                  cursor: 'pointer',
                  background: density === d ? '#faf8f5' : '#fff',
                  color: density === d ? '#1a1a19' : '#6f6b66',
                  fontWeight: density === d ? 600 : 450,
                  borderLeft: i > 0 ? '1px solid #ebe7e1' : 'none',
                  textTransform: 'capitalize',
                }}
              >
                {d.charAt(0).toUpperCase() + d.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Application Title */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: '#2e2b27', marginBottom: 8 }}>Application Title</div>
          <input
            type="text"
            value={customization?.appTitle || ''}
            placeholder="Claudia"
            onChange={(e) => handleTitleChange(e.target.value)}
            maxLength={50}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              border: '1px solid #ebe7e1',
              borderRadius: 7,
              padding: '7px 10px',
              fontSize: 13,
              background: '#fff',
              color: '#2e2b27',
              outline: 'none',
            }}
          />
          <div style={{ fontSize: 11.5, color: '#6f6b66', marginTop: 5 }}>
            Updates window title, menu items, and about dialog
          </div>
        </div>

        {/* Application Icon */}
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: '#2e2b27', marginBottom: 8 }}>Application Icon</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {iconPreview && (
              <img
                src={iconPreview}
                alt="Icon preview"
                style={{ width: 48, height: 48, borderRadius: 8, border: '1px solid #ebe7e1', objectFit: 'contain' }}
              />
            )}
            <div style={{ flex: 1 }}>
              <button
                onClick={handleIconUpload}
                style={{
                  border: '1px solid #ebe7e1',
                  background: '#fff',
                  borderRadius: 7,
                  padding: '6px 14px',
                  fontSize: 12.5,
                  cursor: 'pointer',
                  color: '#2e2b27',
                }}
              >
                Choose Icon
              </button>
              <div style={{ fontSize: 11.5, color: '#6f6b66', marginTop: 4 }}>
                PNG or ICO format, max 1MB
              </div>
            </div>
            {customization?.iconPath && (
              <button
                onClick={handleResetIcon}
                style={{ fontSize: 12, color: '#c96a3d', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                Reset
              </button>
            )}
          </div>

          {restartRequired && (
            <div
              style={{
                marginTop: 12,
                padding: '10px 14px',
                background: '#faf8f5',
                borderRadius: 8,
                border: '1px solid #ebe7e1',
              }}
            >
              <div style={{ fontSize: 12.5, color: '#1a1a19', marginBottom: 6 }}>
                Restart required to apply icon changes
              </div>
              <button
                onClick={() => window.location.reload()}
                style={{
                  background: '#1a1a19',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  padding: '4px 12px',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                Restart Now
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

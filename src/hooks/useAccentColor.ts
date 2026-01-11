import { useEffect } from 'react';
import { useAppSelector } from '../store';
import { useTheme } from './useTheme';
import { generateHoverColor, isValidHexColor } from '../utils/color.utils';

/**
 * Hook to apply custom accent color to CSS variables
 * Updates --color-accent and --color-accent-hover dynamically
 */
export function useAccentColor() {
  const { customization } = useAppSelector((state) => state.settings.appearance);
  const { effectiveTheme } = useTheme();

  useEffect(() => {
    const root = document.documentElement;

    if (customization?.accentColor && isValidHexColor(customization.accentColor)) {
      // Apply custom accent color
      const hoverColor = generateHoverColor(customization.accentColor, effectiveTheme);
      root.style.setProperty('--color-accent', customization.accentColor);
      root.style.setProperty('--color-accent-hover', hoverColor);

      // Update window background color (title bar)
      if (window.electron?.window?.setBackgroundColor) {
        window.electron.window.setBackgroundColor(customization.accentColor).catch((error) => {
          console.error('Failed to set window background color:', error);
        });
      }
    } else {
      // Reset to CSS defaults from globals.css
      root.style.removeProperty('--color-accent');
      root.style.removeProperty('--color-accent-hover');

      // Reset window background color to default
      if (window.electron?.window?.setBackgroundColor) {
        const defaultColor = effectiveTheme === 'dark' ? '#1a1a1a' : '#FAF9F7';
        window.electron.window.setBackgroundColor(defaultColor).catch((error) => {
          console.error('Failed to reset window background color:', error);
        });
      }
    }
  }, [customization?.accentColor, effectiveTheme]);
}

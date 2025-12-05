import { useEffect, useCallback } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { setAppearance } from '../store/slices/settingsSlice';

export type Theme = 'light' | 'dark' | 'system';

export function useTheme() {
  const dispatch = useAppDispatch();
  const { theme } = useAppSelector((state) => state.settings.appearance);

  // Apply theme to document root
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);

    // Save theme to electron store
    window.electron.config.set({
      appearance: { theme },
    }).catch((error) => {
      console.error('Failed to save theme:', error);
    });
  }, [theme]);

  // Set theme
  const setTheme = useCallback(
    (newTheme: Theme) => {
      dispatch(setAppearance({ theme: newTheme }));
    },
    [dispatch]
  );

  // Get effective theme (resolve 'system' to actual theme)
  const getEffectiveTheme = (): 'light' | 'dark' => {
    if (theme === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return theme;
  };

  return {
    theme,
    effectiveTheme: getEffectiveTheme(),
    setTheme,
  };
}

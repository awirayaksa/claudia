import { useEffect } from 'react';
import { useAppSelector } from '../store';

/**
 * Hook to apply custom application title
 * Updates browser tab title and notifies main process to update window title
 */
export function useAppTitle() {
  const { customization } = useAppSelector((state) => state.settings.appearance);

  useEffect(() => {
    const title = customization?.appTitle || 'Claudia';

    // Update browser tab title
    document.title = title;

    // Notify main process to update native window title
    if (window.electron?.window?.setTitle) {
      window.electron.window.setTitle(title).catch((error) => {
        console.error('Failed to set window title:', error);
      });
    }
  }, [customization?.appTitle]);
}

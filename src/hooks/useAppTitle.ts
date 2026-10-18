import { useEffect } from 'react';
import { useAppSelector } from '../store';
import { getPlatform } from '../platform';

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
    const platformWindow = getPlatform().window;
    if (platformWindow) {
      platformWindow.setTitle(title).catch((error) => {
        console.error('Failed to set window title:', error);
      });
    }
  }, [customization?.appTitle]);
}

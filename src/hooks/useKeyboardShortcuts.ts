import { useEffect } from 'react';
import { useAppDispatch } from '../store';
import { setSettingsOpen, setSidebarOpen } from '../store/slices/uiSlice';
import { useConversations } from './useConversations';

export function useKeyboardShortcuts() {
  const dispatch = useAppDispatch();
  const { create: createConversation } = useConversations();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check for modifier keys (Ctrl on Windows/Linux, Cmd on Mac)
      const modifier = event.ctrlKey || event.metaKey;

      // Ctrl/Cmd + K: Open settings
      if (modifier && event.key === 'k') {
        event.preventDefault();
        dispatch(setSettingsOpen(true));
      }

      // Ctrl/Cmd + B: Toggle sidebar
      if (modifier && event.key === 'b') {
        event.preventDefault();
        dispatch(setSidebarOpen());
      }

      // Ctrl/Cmd + N: New conversation
      if (modifier && event.key === 'n') {
        event.preventDefault();
        createConversation().catch((error) => {
          console.error('Failed to create conversation:', error);
        });
      }

      // Escape: Close modals/settings
      if (event.key === 'Escape') {
        dispatch(setSettingsOpen(false));
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [dispatch, createConversation]);
}

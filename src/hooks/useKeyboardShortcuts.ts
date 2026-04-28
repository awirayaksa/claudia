import { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { setSettingsOpen, toggleSidebar } from '../store/slices/uiSlice';
import { clearMessages } from '../store/slices/chatSlice';
import { createConversation } from '../store/slices/conversationSlice';

export function useKeyboardShortcuts() {
  const dispatch = useAppDispatch();
  const { selectedModel } = useAppSelector((state) => state.settings.api);
  const { currentProjectId } = useAppSelector((state) => state.project);
  const { currentConversationId } = useAppSelector((state) => state.conversation);
  const { messages } = useAppSelector((state) => state.chat);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check for modifier keys (Ctrl on Windows/Linux, Cmd on Mac)
      const modifier = event.ctrlKey || event.metaKey;

      // Ctrl/Cmd + B: Toggle sidebar
      if (modifier && event.key === 'b') {
        event.preventDefault();
        dispatch(toggleSidebar());
      }

      // Ctrl/Cmd + N: New conversation
      if (modifier && event.key === 'n') {
        event.preventDefault();
        if (!selectedModel) {
          alert('Please select a model in settings first');
          return;
        }
        // Don't create a new conversation if the current one is still empty
        if (currentConversationId && messages.length === 0) {
          return;
        }
        dispatch(clearMessages());
        dispatch(
          createConversation({
            projectId: currentProjectId,
            title: 'New Conversation',
            model: selectedModel,
          })
        );
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
  }, [dispatch, selectedModel, currentProjectId, currentConversationId, messages.length]);
}

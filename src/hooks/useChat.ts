import { useCallback } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { sendMessage, sendStreamingMessageWithTools, clearMessages, abortStreaming, deleteMessagesAfter, setEditingMessage } from '../store/slices/chatSlice';
import { Attachment } from '../types/message.types';

export function useChat() {
  const dispatch = useAppDispatch();
  const {
    messages,
    isLoading,
    isStreaming,
    streamingContent,
    error,
  } = useAppSelector((state) => state.chat);
  const { selectedModel } = useAppSelector((state) => state.settings.api);
  const { streamingEnabled } = useAppSelector((state) => state.settings.preferences);

  const handleSendMessage = useCallback(
    async (content: string, attachments?: Attachment[]) => {
      if (!selectedModel) {
        throw new Error('Please select a model in settings');
      }

      // Use streaming with tool calling if enabled, otherwise use regular message
      if (streamingEnabled) {
        await dispatch(sendStreamingMessageWithTools({ content, model: selectedModel, attachments }));
      } else {
        await dispatch(sendMessage({ content, model: selectedModel, attachments }));
      }
    },
    [dispatch, selectedModel, streamingEnabled]
  );

  const handleClearMessages = useCallback(() => {
    dispatch(clearMessages());
  }, [dispatch]);

  const handleAbortStreaming = useCallback(() => {
    dispatch(abortStreaming());
  }, [dispatch]);

  const handleEditMessage = useCallback(
    (messageId: string, content: string, attachments?: Attachment[]) => {
      // Abort streaming if active
      if (isStreaming) {
        dispatch(abortStreaming());
      }

      // Delete subsequent messages
      dispatch(deleteMessagesAfter(messageId));

      // Set editing state
      dispatch(setEditingMessage({ id: messageId, content, attachments }));
    },
    [isStreaming, dispatch]
  );

  return {
    messages,
    isLoading,
    isStreaming,
    streamingContent,
    error,
    sendMessage: handleSendMessage,
    clearMessages: handleClearMessages,
    abortStreaming: handleAbortStreaming,
    editMessage: handleEditMessage,
  };
}

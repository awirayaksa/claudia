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
    isExecutingTools,
  } = useAppSelector((state) => state.chat);
  const api = useAppSelector((state) => state.settings.api);
  const selectedModel = (() => {
    switch (api.provider) {
      case 'openwebui':
        return api.openwebui?.selectedModel || '';
      case 'openrouter':
        return api.openrouter?.selectedModel || '';
      case 'custom':
        return api.custom?.selectedModel || '';
      case 'opencode-go':
        return (api as any).opencodeGo?.selectedModel || '';
      default:
        return api.selectedModel || '';
    }
  })();
  const { streamingEnabled } = useAppSelector((state) => state.settings.preferences);

  const handleSendMessage = useCallback(
    async (content: string, attachments?: Attachment[], skillPrompt?: string) => {
      if (!selectedModel) {
        throw new Error('Please select a model in settings');
      }

      console.log('[useChat] Sending message with model:', selectedModel);

      // Use streaming with tool calling if enabled, otherwise use regular message
      if (streamingEnabled) {
        await dispatch(sendStreamingMessageWithTools({ content, model: selectedModel, attachments, skillPrompt }));
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

  const handleRetryMessage = useCallback(
    async (assistantMessageId: string) => {
      const assistantIndex = messages.findIndex((m) => m.id === assistantMessageId);
      if (assistantIndex === -1) return;

      // Find the previous user message
      let userMessageIndex = -1;
      for (let i = assistantIndex - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          userMessageIndex = i;
          break;
        }
      }

      if (userMessageIndex === -1) return;

      const userMessage = messages[userMessageIndex];

      // Abort streaming if active
      if (isStreaming) {
        dispatch(abortStreaming());
      }

      // Delete from the user message onwards (including the user message and assistant response)
      dispatch(deleteMessagesAfter(userMessage.id));

      // Re-send the user message
      await handleSendMessage(userMessage.content, userMessage.attachments);
    },
    [messages, isStreaming, dispatch, handleSendMessage]
  );

  return {
    messages,
    isLoading,
    isStreaming,
    streamingContent,
    error,
    isExecutingTools,
    sendMessage: handleSendMessage,
    clearMessages: handleClearMessages,
    abortStreaming: handleAbortStreaming,
    editMessage: handleEditMessage,
    retryMessage: handleRetryMessage,
  };
}

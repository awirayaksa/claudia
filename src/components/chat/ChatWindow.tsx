import { useEffect, useRef, useState, useCallback } from 'react';
import { ChatMessage } from './ChatMessage';
import { StreamingMessage } from './StreamingMessage';
import { ChatInput, ChatInputRef } from './ChatInput';
import { useChat } from '../../hooks/useChat';
import { useConversations } from '../../hooks/useConversations';
import { useProjects } from '../../hooks/useProjects';
import { useAppSelector, useAppDispatch } from '../../store';
import { Attachment } from '../../types/message.types';
import { clearMessages, addMessage, deleteMessagesAfter, setEditingMessage } from '../../store/slices/chatSlice';
import { setApiConfig } from '../../store/slices/settingsSlice';
import { Conversation } from '../../types/conversation.types';

export function ChatWindow() {
  const dispatch = useAppDispatch();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const chatInputRef = useRef<ChatInputRef>(null);

  const {
    messages,
    isLoading,
    isStreaming,
    streamingContent,
    error,
    isExecutingTools,
    sendMessage,
    abortStreaming,
  } = useChat();

  const editingMessage = useAppSelector((state) => state.chat.editingMessage);
  const streamingReasoning = useAppSelector((state) => state.chat.streamingReasoning);

  const {
    currentConversationId,
    currentConversation,
    create: createConversation,
    load: loadConversation,
    save: saveConversation,
    update: updateConversation,
  } = useConversations();

  const { currentProjectId: _currentProjectId } = useProjects();

  const apiConfig = useAppSelector((state) => state.settings.api);
  const [pendingModel, setPendingModel] = useState<string | null>(null);

  // Get the selected model and check if configured based on current provider
  const getProviderConfig = () => {
    if (apiConfig.provider === 'openwebui') {
      return apiConfig.openwebui;
    } else if (apiConfig.provider === 'openrouter') {
      return apiConfig.openrouter;
    }
    return null;
  };

  const providerConfig = getProviderConfig();
  const selectedModel = providerConfig?.selectedModel || '';
  const availableModels = apiConfig.availableModels || [];

  // Check if configured based on provider type
  const isConfigured = (() => {
    if (apiConfig.provider === 'openwebui') {
      return !!(apiConfig.openwebui?.baseUrl && apiConfig.openwebui?.apiKey && apiConfig.openwebui?.selectedModel);
    } else if (apiConfig.provider === 'openrouter') {
      return !!(apiConfig.openrouter?.apiKey && apiConfig.openrouter?.selectedModel);
    }
    return false;
  })();

  // Auto-scroll to bottom when new messages arrive or streaming content changes
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  // Auto-focus input after response completes
  useEffect(() => {
    if (!isLoading && !isStreaming && !isExecutingTools && messages.length > 0) {
      // Use requestAnimationFrame for immediate focus
      requestAnimationFrame(() => {
        chatInputRef.current?.focus();
      });
    }
  }, [isLoading, isStreaming, isExecutingTools, messages.length]);

  // Auto-focus input when a new conversation is created (no messages yet)
  useEffect(() => {
    if (currentConversationId && messages.length === 0 && !isLoading && !isStreaming && !isExecutingTools) {
      // Use requestAnimationFrame for immediate focus
      requestAnimationFrame(() => {
        chatInputRef.current?.focus();
      });
    }
  }, [currentConversationId, messages.length, isLoading, isStreaming, isExecutingTools]);

  // Track if we've loaded this conversation before to avoid clearing messages on create
  const loadedConversationRef = useRef<string | null>(null);

  // Load conversation when selected
  useEffect(() => {
    if (currentConversationId && currentConversation) {
      // Only load if this is a different conversation (not the one we just created)
      if (loadedConversationRef.current === currentConversationId) {
        return;
      }

      loadConversation(currentConversationId, currentConversation.projectId)
        .then((result) => {
          const conversation = result as Conversation;
          if (conversation && conversation.messages && conversation.messages.length > 0) {
            // Only clear and load if the conversation has existing messages
            // This prevents clearing messages when creating a new conversation
            dispatch(clearMessages());
            conversation.messages.forEach((msg) => {
              dispatch(addMessage(msg));
            });
          }
          loadedConversationRef.current = currentConversationId;
        })
        .catch((error) => {
          console.error('Failed to load conversation:', error);
        });
    }
  }, [currentConversationId]);

  // Auto-save conversation when messages change
  useEffect(() => {
    if (messages.length === 0 || !currentConversationId || !currentConversation) {
      return;
    }

    // Debounce saves - wait 1 second after last change
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(() => {
      const conversation: Conversation = {
        id: currentConversationId,
        projectId: currentConversation.projectId,
        title: currentConversation.title,
        createdAt: currentConversation.createdAt,
        updatedAt: new Date().toISOString(),
        model: currentConversation.model,
        messages: messages,
        messageCount: messages.length,
      };

      // Auto-generate title from first user message if still "New Conversation"
      if (conversation.title === 'New Conversation' && messages.length > 0) {
        const firstUserMessage = messages.find((m) => m.role === 'user');
        if (firstUserMessage) {
          const title = firstUserMessage.content.slice(0, 50) + (firstUserMessage.content.length > 50 ? '...' : '');
          conversation.title = title;
          updateConversation(currentConversationId, { title });
        }
      }

      saveConversation(conversation).catch((error) => {
        console.error('Failed to auto-save conversation:', error);
      });
    }, 1000);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [messages, currentConversationId, currentConversation, saveConversation, updateConversation]);

  const handleModelChange = async (newModel: string) => {
    try {
      console.log('[ChatWindow] Model changed to:', newModel);

      // Update the provider-specific config
      const updatedConfig = { ...apiConfig };

      if (apiConfig.provider === 'openwebui' && updatedConfig.openwebui) {
        updatedConfig.openwebui = { ...updatedConfig.openwebui, selectedModel: newModel };
      } else if (apiConfig.provider === 'openrouter' && updatedConfig.openrouter) {
        updatedConfig.openrouter = { ...updatedConfig.openrouter, selectedModel: newModel };
      }

      // IMPORTANT: Update the top-level selectedModel for backward compatibility
      // (useChat hook reads from this)
      updatedConfig.selectedModel = newModel;

      console.log('[ChatWindow] Updated config:', updatedConfig);

      // Update global default
      dispatch(setApiConfig(updatedConfig));

      // Persist to Electron store
      await window.electron.config.set({
        api: updatedConfig,
      });

      // Update current conversation if it exists
      if (currentConversationId) {
        await updateConversation(currentConversationId, { model: newModel });
      } else {
        // Store for when conversation is created
        setPendingModel(newModel);
      }
    } catch (error) {
      console.error('Failed to update model:', error);
    }
  };

  const handleSend = async (content: string, attachments?: Attachment[]) => {
    try {
      // Create new conversation if none exists
      if (!currentConversationId) {
        const modelToUse = pendingModel || selectedModel;
        await createConversation('New Conversation', modelToUse);
        setPendingModel(null);
      }

      await sendMessage(content, attachments);
    } catch (error) {
      console.error('Failed to send message:', error);
    }
  };

  const handleAbortStreaming = useCallback(() => {
    abortStreaming();
    // Immediate focus attempt after abort
    requestAnimationFrame(() => {
      chatInputRef.current?.focus();
    });
  }, [abortStreaming]);

  const handleEditMessage = useCallback((messageId: string, content: string, attachments?: Attachment[]) => {
    // 1. Abort any active streaming
    if (isStreaming) {
      abortStreaming();
    }

    // 2. Delete messages from this point forward
    dispatch(deleteMessagesAfter(messageId));

    // 3. Set editing state (for input population)
    dispatch(setEditingMessage({ id: messageId, content, attachments }));

    // 4. Scroll to bottom and focus input
    setTimeout(() => {
      chatInputRef.current?.focus();
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  }, [isStreaming, abortStreaming, dispatch]);

  const handleCancelEdit = useCallback(() => {
    dispatch(setEditingMessage(null));
  }, [dispatch]);

  // Show configuration prompt if not configured
  if (!isConfigured) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8 overflow-hidden">
        <div className="max-w-md text-center">
          <svg
            className="mx-auto mb-4 h-16 w-16 text-text-secondary"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
            />
          </svg>
          <h2 className="mb-2 text-xl font-semibold text-text-primary">
            Configuration Required
          </h2>
          <p className="mb-4 text-text-secondary">
            Please configure your API provider and select a model to start chatting.
          </p>
          <p className="text-sm text-text-secondary">
            Click the <span className="font-semibold">Settings</span> button in the top-right to get started.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {messages.length === 0 ? (
        /* Empty state - centered input */
        <div className="flex flex-1 flex-col items-center bg-background pt-52 px-8">
          <div className="w-full max-w-3xl">
            {/* Welcome message */}
            <div className="mb-8 flex flex-col items-center text-center">
              <svg
                className="mb-4 h-12 w-12 text-text-secondary opacity-50"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                />
              </svg>
              <h3 className="mb-2 text-lg font-medium text-text-primary">
                Start a conversation
              </h3>
              <p className="text-sm text-text-secondary">
                Type a message below to begin chatting with {selectedModel}
              </p>
            </div>

            {/* Centered input with rounded style */}
            <div className="rounded-3xl border border-border bg-surface shadow-sm overflow-hidden">
              <ChatInput
                ref={chatInputRef}
                variant="centered"
                onSend={handleSend}
                onAbort={handleAbortStreaming}
                disabled={isLoading}
                isGenerating={isStreaming || isExecutingTools}
                placeholder={`Message ${currentConversation?.model || pendingModel || selectedModel}...`}
                selectedModel={currentConversation?.model || pendingModel || selectedModel}
                availableModels={availableModels}
                onModelChange={handleModelChange}
                initialMessage={editingMessage?.content}
                initialAttachments={editingMessage?.attachments}
                onCancelEdit={handleCancelEdit}
              />
            </div>
          </div>
        </div>
      ) : (
        /* Chat with messages - normal layout */
        <>
          {/* Messages area */}
          <div
            ref={messagesContainerRef}
            className="flex-1 overflow-y-auto bg-background p-4"
          >
            {messages.map((message) => (
              <ChatMessage
                key={message.id}
                message={message}
                onEdit={handleEditMessage}
                disabled={isLoading || isStreaming || isExecutingTools}
              />
            ))}
            {/* Streaming message */}
            {isStreaming && (
              <StreamingMessage
                content={streamingContent}
                reasoning={streamingReasoning}
              />
            )}
            {/* Show stop button during tool execution without streaming */}
            {!isStreaming && isExecutingTools && (
              <div className="flex justify-start py-2">
                <div className="max-w-[70%] rounded-lg border border-border bg-surface px-4 py-3">
                  <div className="mb-1 flex items-center justify-between gap-4">
                    <button
                      onClick={handleAbortStreaming}
                      className="rounded p-1 text-xs text-text-secondary hover:bg-background hover:text-error"
                      title="Stop generating"
                    >
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                    <span className="text-xs text-text-secondary">Executing tools...</span>
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <div className="flex gap-1">
                      <div className="h-2 w-2 animate-bounce rounded-full bg-accent [animation-delay:-0.3s]"></div>
                      <div className="h-2 w-2 animate-bounce rounded-full bg-accent [animation-delay:-0.15s]"></div>
                      <div className="h-2 w-2 animate-bounce rounded-full bg-accent"></div>
                    </div>
                    <span className="text-sm text-text-secondary">Processing...</span>
                  </div>
                </div>
              </div>
            )}
            {/* Loading indicator for non-streaming */}
            {isLoading && !isStreaming && (
              <div className="flex justify-start py-2">
                <div className="max-w-[70%] rounded-lg border border-border bg-surface px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="flex gap-1">
                      <div className="h-2 w-2 animate-bounce rounded-full bg-accent [animation-delay:-0.3s]"></div>
                      <div className="h-2 w-2 animate-bounce rounded-full bg-accent [animation-delay:-0.15s]"></div>
                      <div className="h-2 w-2 animate-bounce rounded-full bg-accent"></div>
                    </div>
                    <span className="text-sm text-text-secondary">
                      Thinking...
                    </span>
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Error display */}
          {error && (
            <div className="border-t border-error bg-error bg-opacity-10 px-4 py-2">
              <p className="text-sm text-error" style={{ color: 'white' }}>{error}</p>
            </div>
          )}

          {/* Input area */}
          <ChatInput
            ref={chatInputRef}
            onSend={handleSend}
            onAbort={handleAbortStreaming}
            disabled={isLoading}
            isGenerating={isStreaming || isExecutingTools}
            placeholder={`Message ${currentConversation?.model || pendingModel || selectedModel}...`}
            selectedModel={currentConversation?.model || pendingModel || selectedModel}
            availableModels={availableModels}
            onModelChange={handleModelChange}
            initialMessage={editingMessage?.content}
            initialAttachments={editingMessage?.attachments}
            onCancelEdit={handleCancelEdit}
          />
        </>
      )}
    </div>
  );
}

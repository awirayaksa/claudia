import { useEffect, useRef, useState, useCallback, DragEvent } from 'react';
import { format, isToday, isYesterday, parseISO } from 'date-fns';
import { ChatMessage } from './ChatMessage';
import { StreamingMessage } from './StreamingMessage';
import { ChatInput, ChatInputRef } from './ChatInput';
import { FilesystemDirectoryBar } from './FilesystemDirectoryBar';
import { TextSelectionMenu } from './TextSelectionMenu';
import { SuggestedPrompts } from './SuggestedPrompts';
import { useChat } from '../../hooks/useChat';
import { useConversations } from '../../hooks/useConversations';
import { useProjects } from '../../hooks/useProjects';
import { useAppSelector, useAppDispatch } from '../../store';
import { Attachment } from '../../types/message.types';
import { clearMessages, addMessage, deleteMessagesAfter, setEditingMessage, setFilesystemDirectory } from '../../store/slices/chatSlice';
import { setCurrentConversation } from '../../store/slices/conversationSlice';
import { resolveSkillCommand } from '../../utils/skill-utils';
import { setApiConfig } from '../../store/slices/settingsSlice';
import { Conversation } from '../../types/conversation.types';
import { getAPIProvider } from '../../services/api/provider.service';

export function ChatWindow() {
  const dispatch = useAppDispatch();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const chatInputRef = useRef<ChatInputRef>(null);
  const titleGeneratedRef = useRef<Set<string>>(new Set());

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
  const filesystemDirectory = useAppSelector((state) => state.chat.filesystemDirectory);
  const serverStates = useAppSelector((state) => state.mcp.serverStates);

  const {
    conversations,
    currentConversationId,
    currentConversation,
    create: createConversation,
    load: loadConversation,
    save: saveConversation,
    update: updateConversation,
  } = useConversations();

  const { currentProjectId: _currentProjectId } = useProjects();

  const skills = useAppSelector((state) => state.skills.skills);
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

  // No auto-scroll during streaming — user stays at their current position

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

  // Clear per-session filesystem directory when switching conversations
  const prevConversationIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevConversationIdRef.current;
    prevConversationIdRef.current = currentConversationId;

    if (prev !== null && prev !== currentConversationId && filesystemDirectory) {
      dispatch(setFilesystemDirectory(null));

      // Find the filesystem server and restart it with empty allowed dirs
      const filesystemEntry = Object.entries(serverStates).find(
        ([, s]) => s.config.builtinId === 'builtin-filesystem-001' && s.status === 'ready'
      );
      if (filesystemEntry) {
        const [serverId] = filesystemEntry;
        window.electron.mcp.restartWithBuiltinConfig(serverId, { allowedDirectories: [] }).catch((err) => {
          console.error('[ChatWindow] Failed to clear filesystem dirs on conversation switch:', err);
        });
      }
    }
  }, [currentConversationId]);

  const generateConversationTitle = useCallback(async (
    conversationId: string,
    firstUserMessage: string,
    firstAssistantMessage: string,
    model: string
  ) => {
    if (titleGeneratedRef.current.has(conversationId)) return;
    titleGeneratedRef.current.add(conversationId);

    try {
      const provider = getAPIProvider();
      const response = await provider.chatCompletion({
        model,
        messages: [
          {
            role: 'system',
            content: 'Generate a very short title (3-6 words) for this conversation. Reply with only the title, no quotes, no punctuation at the end.',
          },
          {
            role: 'user',
            content: firstUserMessage.slice(0, 500),
          },
          {
            role: 'assistant',
            content: firstAssistantMessage.slice(0, 500),
          },
        ],
        stream: false,
        max_tokens: 30,
        temperature: 0.3,
      });

      const rawTitle = response.choices[0]?.message?.content;
      if (rawTitle && typeof rawTitle === 'string') {
        const title = rawTitle.trim().replace(/^["']|["']$/g, '').slice(0, 60);
        if (title) {
          updateConversation(conversationId, { title });
        }
      }
    } catch (error) {
      console.error('Failed to generate conversation title:', error);
    }
  }, [updateConversation]);

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
        starred: currentConversation.starred,
      };

      // Auto-generate title from first exchange if still "New Conversation"
      if (conversation.title === 'New Conversation' && !titleGeneratedRef.current.has(currentConversationId)) {
        const firstUserMessage = messages.find((m) => m.role === 'user');
        const firstAssistantMessage = messages.find((m) => m.role === 'assistant');
        if (firstUserMessage && firstAssistantMessage) {
          // Set a temporary truncated title immediately as placeholder
          const tempTitle = firstUserMessage.content.slice(0, 50) + (firstUserMessage.content.length > 50 ? '...' : '');
          conversation.title = tempTitle;
          // Kick off async AI title generation (will update Redux + disk when done)
          generateConversationTitle(
            currentConversationId,
            firstUserMessage.content,
            firstAssistantMessage.content,
            currentConversation.model
          );
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
  }, [messages, currentConversationId, currentConversation, saveConversation, updateConversation, generateConversationTitle]);

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

      // Scroll to bottom when user sends a message so they see the response start
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });

      // Check if content is a skill invocation (e.g. "/summarize some text")
      const skillResult = resolveSkillCommand(content, skills);
      if (skillResult) {
        // If the filesystem MCP tool has an active working directory, prepend it to
        // the skill prompt so the skill operates in the right folder automatically.
        let skillPrompt = skillResult.skillPrompt;
        if (filesystemDirectory) {
          skillPrompt = `Working directory: ${filesystemDirectory}\n\n${skillPrompt}`;
        }
        await sendMessage(skillResult.userContent, attachments, skillPrompt);
      } else {
        await sendMessage(content, attachments);
      }
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

  const [showHeaderMenu, setShowHeaderMenu] = useState(false);
  const headerMenuRef = useRef<HTMLDivElement>(null);

  // Close header menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (headerMenuRef.current && !headerMenuRef.current.contains(e.target as Node)) {
        setShowHeaderMenu(false);
      }
    };
    if (showHeaderMenu) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showHeaderMenu]);

  const handleClearChat = useCallback(() => {
    setShowHeaderMenu(false);
    if (window.confirm('Clear this conversation? This cannot be undone.')) {
      dispatch(clearMessages());
    }
  }, [dispatch]);

  // Window-level drag-and-drop for file attachments
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDraggingOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDraggingOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDraggingOver(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      chatInputRef.current?.addFiles(files);
    }
  }, []);

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
    <div
      className="flex flex-1 flex-col overflow-hidden relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Full-window drop overlay */}
      {isDraggingOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background bg-opacity-80 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-accent bg-surface px-12 py-10 text-center shadow-lg">
            <svg className="mx-auto mb-3 h-12 w-12 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <p className="text-lg font-medium text-accent">Drop files to attach</p>
            <p className="mt-1 text-sm text-text-secondary">Images, PDFs, and documents</p>
          </div>
        </div>
      )}
      {messages.length === 0 ? (
        /* Empty state - centered input */
        <div className="flex flex-1 flex-col items-center bg-background overflow-y-auto px-8 pt-16">
          <div className="w-full max-w-2xl">
            {/* Warm greeting */}
            <div className="mb-8">
              <h3 className="text-3xl font-medium tracking-tight text-text-primary mb-1.5">
                {(() => {
                  const h = new Date().getHours();
                  if (h < 12) return 'Good morning.';
                  if (h < 18) return 'Good afternoon.';
                  return 'Good evening.';
                })()}
              </h3>
              <p className="text-sm text-text-secondary">
                What would you like to work on today?
              </p>
            </div>

            {/* Filesystem directory bar */}
            <FilesystemDirectoryBar disabled={isLoading || isStreaming || isExecutingTools} />

            {/* Centered input */}
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

            {/* Jump back in — recent conversations */}
            {conversations.length > 0 && (
              <div className="mt-8">
                <div className="mb-3 flex items-baseline justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                    Jump back in
                  </p>
                </div>
                <div className="grid grid-cols-3 gap-2.5">
                  {conversations.slice(0, 3).map((conv) => (
                    <button
                      key={conv.id}
                      onClick={() => dispatch(setCurrentConversation(conv.id))}
                      className="flex flex-col items-start gap-1 rounded-xl border border-border bg-surface p-3 text-left transition-colors hover:bg-surface-hover hover:border-accent hover:border-opacity-40"
                    >
                      <p className="w-full truncate text-sm font-semibold text-text-primary leading-snug">
                        {conv.title}
                      </p>
                      <p className="text-xs text-text-secondary">
                        {format(parseISO(conv.updatedAt), 'h:mm a')}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Suggested prompts */}
            <SuggestedPrompts
              model={currentConversation?.model || pendingModel || selectedModel}
              onSelect={(prompt) => {
                handleSend(prompt);
              }}
            />
          </div>
        </div>
      ) : (
        /* Chat with messages - normal layout */
        <>
          {/* Text selection context menu (portal-rendered, fixed positioning) */}
          <TextSelectionMenu containerRef={messagesContainerRef} />

          {/* Conversation header */}
          <div className="flex items-center justify-between border-b border-border bg-background px-5 py-2.5">
            <div className="flex min-w-0 items-center gap-3">
              <span className="truncate text-sm font-semibold text-text-primary">
                {currentConversation?.title || 'New Conversation'}
              </span>
              <span className="flex-shrink-0 text-xs text-text-secondary">
                {messages.length} {messages.length === 1 ? 'message' : 'messages'}
                {currentConversation?.createdAt ? ` · ${format(parseISO(currentConversation.createdAt), 'h:mm a')}` : ''}
              </span>
            </div>
            {/* ⋯ menu */}
            <div className="relative" ref={headerMenuRef}>
              <button
                className="rounded p-1.5 text-text-secondary hover:bg-surface-hover transition-colors"
                onClick={() => setShowHeaderMenu((v) => !v)}
                title="More options"
              >
                <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                  <circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" />
                </svg>
              </button>
              {showHeaderMenu && (
                <div className="absolute right-0 top-8 z-50 min-w-[160px] rounded-lg border border-border bg-surface shadow-lg py-1">
                  <button
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-error hover:bg-surface-hover transition-colors"
                    onClick={handleClearChat}
                  >
                    Clear Chat
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Messages area */}
          <div
            ref={messagesContainerRef}
            className="flex-1 overflow-y-auto bg-background py-6"
          >
            <div className="px-4">
            {messages.map((message, index) => {
              const prevMessage = index > 0 ? messages[index - 1] : null;
              const curDate = parseISO(message.timestamp);
              const showDateDivider = !prevMessage || (
                format(parseISO(prevMessage.timestamp), 'yyyy-MM-dd') !== format(curDate, 'yyyy-MM-dd')
              );
              const dateLabel = isToday(curDate) ? 'Today' : isYesterday(curDate) ? 'Yesterday' : format(curDate, 'MMM d');
              return (
                <div key={message.id}>
                  {showDateDivider && (
                    <div className="my-6 flex items-center gap-3 text-xs text-text-secondary">
                      <div className="h-px flex-1 bg-border" />
                      <span>{dateLabel} · {format(curDate, 'h:mm a')}</span>
                      <div className="h-px flex-1 bg-border" />
                    </div>
                  )}
                  <ChatMessage
                    message={message}
                    onEdit={handleEditMessage}
                    disabled={isLoading || isStreaming || isExecutingTools}
                  />
                </div>
              );
            })}
            {/* Streaming message */}
            {isStreaming && (
              <StreamingMessage
                content={streamingContent}
                reasoning={streamingReasoning}
              />
            )}
            {/* Show stop button during tool execution without streaming */}
            {!isStreaming && isExecutingTools && (
              <div className="py-4">
                <div className="mb-2 flex items-center gap-2">
                  <div className="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-[5px] bg-accent text-[11px] font-bold text-white">C</div>
                  <span className="text-sm font-semibold text-text-primary">Claudia</span>
                  <button
                    onClick={handleAbortStreaming}
                    className="ml-2 rounded px-2 py-0.5 text-xs text-text-secondary hover:bg-surface hover:text-error transition-colors"
                  >
                    ✕ Stop
                  </button>
                </div>
                <div className="pl-[30px] flex items-center gap-2">
                  <div className="flex gap-1">
                    <div className="h-2 w-2 animate-bounce rounded-full bg-accent [animation-delay:-0.3s]"></div>
                    <div className="h-2 w-2 animate-bounce rounded-full bg-accent [animation-delay:-0.15s]"></div>
                    <div className="h-2 w-2 animate-bounce rounded-full bg-accent"></div>
                  </div>
                  <span className="text-sm text-text-secondary">Executing tools…</span>
                </div>
              </div>
            )}
            {/* Loading indicator for non-streaming */}
            {isLoading && !isStreaming && (
              <div className="py-4">
                <div className="mb-2 flex items-center gap-2">
                  <div className="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-[5px] bg-accent text-[11px] font-bold text-white">C</div>
                  <span className="text-sm font-semibold text-text-primary">Claudia</span>
                </div>
                <div className="pl-[30px] flex gap-1">
                  <div className="h-2 w-2 animate-bounce rounded-full bg-accent [animation-delay:-0.3s]"></div>
                  <div className="h-2 w-2 animate-bounce rounded-full bg-accent [animation-delay:-0.15s]"></div>
                  <div className="h-2 w-2 animate-bounce rounded-full bg-accent"></div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
            </div>
          </div>

          {/* Error display */}
          {error && (
            <div className="border-t border-error bg-error bg-opacity-10 px-4 py-2">
              <p className="text-sm text-error" style={{ color: 'white' }}>{error}</p>
            </div>
          )}

          {/* Filesystem directory bar */}
          <FilesystemDirectoryBar disabled={isLoading || isStreaming || isExecutingTools} />

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

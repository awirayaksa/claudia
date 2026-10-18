import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { Message, Attachment, ToolCall, ToolResult } from '../../types/message.types';
import { MessageUsage } from '../../types/statistics.types';
import { ChatCompletionRequest } from '../../types/api.types';
import {
  buildAPIMessage,
  buildMessageContent,
  remoteFileIds,
  toolContentForModel,
  uiResourceConfirmation,
} from '../../services/chat/message-builder';
import type { IAPIProvider } from '../../services/api/provider.interface';
import { getAPIProvider } from '../../services/api/provider.service';
import { ToolIntegrationService } from '../../services/mcp/tool-integration.service';
import { v4 as uuidv4 } from 'uuid';
import type { RootState } from '../index';
import { ReasoningEffort, resolveEffort, coerceEffort } from '../../utils/effort-utils';

interface ChatState {
  messages: Message[];
  isLoading: boolean;
  isStreaming: boolean;
  streamingMessageId: string | null;
  streamingContent: string;
  streamingReasoning: string;
  streamingUsage: MessageUsage | null;
  error: string | null;
  abortController: AbortController | null;
  // Tool calling state
  pendingToolCalls: ToolCall[];
  isExecutingTools: boolean;
  toolCallIteration: number;
  // Edit state
  editingMessage: { id: string; content: string; attachments?: Attachment[] } | null;
}

const initialState: ChatState = {
  messages: [],
  isLoading: false,
  isStreaming: false,
  streamingMessageId: null,
  streamingContent: '',
  streamingReasoning: '',
  streamingUsage: null,
  error: null,
  abortController: null,
  pendingToolCalls: [],
  isExecutingTools: false,
  toolCallIteration: 0,
  editingMessage: null,
};

/**
 * Open WebUI resolves uploaded files itself: send every file id referenced in
 * the conversation so documents stay in context on later turns. Other
 * providers get the text inlined instead and must not see this field.
 */
function openWebUIFiles(
  provider: IAPIProvider,
  history: Message[],
  attachments?: Attachment[]
): ChatCompletionRequest['files'] {
  if (provider.getProviderType() !== 'openwebui') return undefined;
  const ids = new Set([...history.flatMap((m) => remoteFileIds(m.attachments)), ...remoteFileIds(attachments)]);
  return ids.size > 0 ? [...ids].map((id) => ({ type: 'file' as const, id })) : undefined;
}

/**
 * Effort that applies to an outgoing request: an explicit per-message override,
 * then the session override, then the Preferences default — mapped onto a tier
 * the target model actually accepts.
 */
function effortForRequest(
  state: RootState,
  model: string,
  oneShot?: ReasoningEffort | null
): ReasoningEffort | undefined {
  const resolved = resolveEffort(oneShot, state.composer.effortLevel, state.settings.preferences.reasoningEffort);
  return coerceEffort(resolved, model);
}

// Async thunk for sending a message
export const sendMessage = createAsyncThunk(
  'chat/sendMessage',
  async (
    { content, model, attachments, effort }: { content: string; model: string; attachments?: Attachment[]; effort?: ReasoningEffort | null },
    { getState, rejectWithValue }
  ) => {
    try {
      const state = getState() as RootState;
      const provider = getAPIProvider();
      const temperature = state.settings.preferences.temperature;
      const reasoningEffort = effortForRequest(state, model, effort);

      // Get all messages for context (include attachments for prior messages)
      const messages = state.chat.messages.map((msg: Message) => buildAPIMessage(msg));

      // Add the new user message with attachments
      messages.push({
        role: 'user' as const,
        content: buildMessageContent(content, attachments),
      });

      // Prepend global system prompt if set (only to API payload, not stored in chat state)
      const systemPrompt = state.settings.preferences.systemPrompt;
      if (systemPrompt) {
        messages.unshift({ role: 'system' as const, content: systemPrompt });
      }

      // Call the API
      const response = await provider.chatCompletion({
        model,
        messages,
        stream: false,
        temperature: temperature,
        reasoning_effort: reasoningEffort,
        files: openWebUIFiles(provider, state.chat.messages, attachments),
      });

      // Assistant responses are always plain text strings
      const rawContent = response.choices[0].message.content;
      const assistantContent = typeof rawContent === 'string' ? rawContent : '';
      const assistantReasoning = response.choices[0].message.reasoning;

      return {
        userMessageId: uuidv4(),
        assistantMessageId: uuidv4(),
        userContent: content,
        userAttachments: attachments,
        userEffort: reasoningEffort,
        assistantContent: assistantContent,
        assistantReasoning: assistantReasoning,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return rejectWithValue(
        error instanceof Error ? error.message : 'Failed to send message'
      );
    }
  }
);

const chatSlice = createSlice({
  name: 'chat',
  initialState,
  reducers: {
    addMessage: (state, action: PayloadAction<Message>) => {
      state.messages.push(action.payload);
    },
    clearMessages: (state) => {
      state.messages = [];
      state.error = null;
      state.streamingContent = '';
      state.streamingReasoning = '';
      state.streamingUsage = null;
      state.streamingMessageId = null;
      state.isStreaming = false;
      state.isLoading = false;
      state.abortController = null;
      state.pendingToolCalls = [];
      state.isExecutingTools = false;
      state.toolCallIteration = 0;
    },
    setError: (state, action: PayloadAction<string | null>) => {
      state.error = action.payload;
    },
    // Streaming actions
    startStreaming: (state, action: PayloadAction<{ userMessageId: string; assistantMessageId: string; userContent: string; userAttachments?: Attachment[]; timestamp: string; effort?: ReasoningEffort }>) => {
      state.isStreaming = true;
      state.streamingContent = '';
      state.streamingReasoning = '';
      state.streamingUsage = null;
      state.streamingMessageId = action.payload.assistantMessageId;
      state.error = null;

      // Add user message only if content is not empty (skip for tool call iterations)
      if (action.payload.userContent.trim()) {
        state.messages.push({
          id: action.payload.userMessageId,
          role: 'user',
          content: action.payload.userContent,
          attachments: action.payload.userAttachments,
          timestamp: action.payload.timestamp,
          effort: action.payload.effort,
        });
      }
    },
    appendStreamingContent: (state, action: PayloadAction<string>) => {
      state.streamingContent += action.payload;
    },
    appendStreamingReasoning: (state, action: PayloadAction<string>) => {
      state.streamingReasoning += action.payload;
    },
    setStreamingUsage: (state, action: PayloadAction<MessageUsage>) => {
      state.streamingUsage = action.payload;
    },
    completeStreaming: (state) => {
      if (state.streamingMessageId && (state.streamingContent || state.streamingReasoning)) {
        const existingIndex = state.messages.findIndex((m) => m.id === state.streamingMessageId);
        if (existingIndex !== -1) {
          // Update existing message (e.g. one that already has toolCalls)
          state.messages[existingIndex] = {
            ...state.messages[existingIndex],
            content: state.streamingContent,
            reasoning: state.streamingReasoning || undefined,
            usage: state.streamingUsage || undefined,
            timestamp: new Date().toISOString(),
          };
        } else {
          const newMessage = {
            id: state.streamingMessageId,
            role: 'assistant' as const,
            content: state.streamingContent,
            reasoning: state.streamingReasoning || undefined,
            usage: state.streamingUsage || undefined,
            timestamp: new Date().toISOString(),
          };
          // Add the complete assistant message
          state.messages.push(newMessage);
        }
      }

      state.isStreaming = false;
      state.streamingContent = '';
      state.streamingReasoning = '';
      state.streamingUsage = null;
      state.streamingMessageId = null;
      state.abortController = null;
    },
    setAbortController: (state, action: PayloadAction<AbortController | null>) => {
      state.abortController = action.payload as any;
    },
    abortStreaming: (state) => {
      if (state.abortController) {
        (state.abortController as any).abort();
      }
      // Clear ALL streaming and tool-related state
      state.isStreaming = false;
      state.streamingContent = '';
      state.streamingReasoning = '';
      state.streamingUsage = null;
      state.streamingMessageId = null;
      state.abortController = null;
      state.isExecutingTools = false;
      state.pendingToolCalls = [];
      state.toolCallIteration = 0;
    },
    // Tool calling actions
    setToolCalls: (state, action: PayloadAction<ToolCall[]>) => {
      state.pendingToolCalls = action.payload;
    },
    clearToolCalls: (state) => {
      state.pendingToolCalls = [];
      state.isExecutingTools = false;
      state.toolCallIteration = 0;
    },
    setExecutingTools: (state, action: PayloadAction<boolean>) => {
      state.isExecutingTools = action.payload;
    },
    incrementToolIteration: (state) => {
      state.toolCallIteration += 1;
    },
    addToolCallMessage: (state, action: PayloadAction<Message>) => {
      state.messages.push(action.payload);
    },
    updateMessageToolResults: (
      state,
      action: PayloadAction<{ messageId: string; toolResults: import('../../types/message.types').ToolResult[] }>
    ) => {
      const message = state.messages.find((m) => m.id === action.payload.messageId);
      if (message) {
        message.toolResults = action.payload.toolResults;
      }
    },
    // Edit message actions
    deleteMessagesAfter: (state, action: PayloadAction<string>) => {
      const messageIndex = state.messages.findIndex((m) => m.id === action.payload);
      if (messageIndex !== -1) {
        state.messages = state.messages.slice(0, messageIndex);
      }
    },
    setEditingMessage: (
      state,
      action: PayloadAction<{ id: string; content: string; attachments?: Attachment[] } | null>
    ) => {
      state.editingMessage = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      // Send message pending
      .addCase(sendMessage.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      // Send message fulfilled
      .addCase(sendMessage.fulfilled, (state, action) => {
        state.isLoading = false;

        // Add user message
        state.messages.push({
          id: action.payload.userMessageId,
          role: 'user',
          content: action.payload.userContent,
          attachments: action.payload.userAttachments,
          timestamp: action.payload.timestamp,
          effort: action.payload.userEffort,
        });

        // Add assistant message
        state.messages.push({
          id: action.payload.assistantMessageId,
          role: 'assistant',
          content: action.payload.assistantContent || '',
          reasoning: action.payload.assistantReasoning || undefined,
          timestamp: action.payload.timestamp,
        });
      })
      // Send message rejected
      .addCase(sendMessage.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload as string;
      })
      // Send streaming message pending
      .addCase(sendStreamingMessage.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      // Send streaming message fulfilled
      .addCase(sendStreamingMessage.fulfilled, (state) => {
        state.isLoading = false;
      })
      // Send streaming message rejected
      .addCase(sendStreamingMessage.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || 'Streaming failed';
      })
      // Send streaming message with tools pending
      .addCase(sendStreamingMessageWithTools.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      // Send streaming message with tools fulfilled
      .addCase(sendStreamingMessageWithTools.fulfilled, (state) => {
        state.isLoading = false;
      })
      // Send streaming message with tools rejected
      .addCase(sendStreamingMessageWithTools.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || 'Streaming with tools failed';
      })
      // Execute UI action pending
      .addCase(executeUIAction.pending, (state) => {
        state.error = null;
      })
      // Execute UI action fulfilled
      .addCase(executeUIAction.fulfilled, () => {
        // Don't modify isLoading - UI actions run in parallel with chat
      })
      // Execute UI action rejected
      .addCase(executeUIAction.rejected, (state, action) => {
        state.error = action.error.message || 'UI action failed';
      });
  },
});

export const {
  addMessage,
  clearMessages,
  setError,
  startStreaming,
  appendStreamingContent,
  appendStreamingReasoning,
  setStreamingUsage,
  completeStreaming,
  setAbortController,
  abortStreaming,
  setToolCalls,
  clearToolCalls,
  setExecutingTools,
  incrementToolIteration,
  addToolCallMessage,
  updateMessageToolResults,
  deleteMessagesAfter,
  setEditingMessage,
} = chatSlice.actions;

// Thunk for sending streaming message
export const sendStreamingMessage = createAsyncThunk(
  'chat/sendStreamingMessage',
  async (
    { content, model, attachments, effort }: { content: string; model: string; attachments?: Attachment[]; effort?: ReasoningEffort | null },
    { getState, dispatch }
  ) => {
    const state = getState() as RootState;
    const provider = getAPIProvider();
    const temperature = state.settings.preferences.temperature;
    const reasoningEffort = effortForRequest(state, model, effort);

    const userMessageId = uuidv4();
    const assistantMessageId = uuidv4();
    const timestamp = new Date().toISOString();

    // Start streaming
    dispatch(startStreaming({
      userMessageId,
      assistantMessageId,
      userContent: content,
      userAttachments: attachments,
      timestamp,
      effort: reasoningEffort,
    }));

    // Get all messages for context (include attachments for prior messages)
    const messages = state.chat.messages.map((msg: Message) => buildAPIMessage(msg));

    // Add the new user message with attachments
    messages.push({
      role: 'user' as const,
      content: buildMessageContent(content, attachments),
    });

    // Prepend global system prompt if set (only to API payload, not stored in chat state)
    const systemPrompt = state.settings.preferences.systemPrompt;
    if (systemPrompt) {
      messages.unshift({ role: 'system' as const, content: systemPrompt });
    }

    // Create abort controller
    const abortController = new AbortController();
    dispatch(setAbortController(abortController as any));

    return new Promise<void>((resolve, reject) => {
      provider.streamChatCompletion(
        {
          model,
          messages,
          temperature: temperature,
          reasoning_effort: reasoningEffort,
          files: openWebUIFiles(provider, state.chat.messages, attachments),
        },
        {
          onChunk: (chunk) => {
            dispatch(appendStreamingContent(chunk));
          },
          onReasoning: (reasoning) => {
            dispatch(appendStreamingReasoning(reasoning));
          },
          onUsage: (usage) => {
            dispatch(setStreamingUsage(usage));
          },
          onComplete: () => {
            dispatch(completeStreaming());
            resolve();
          },
          onError: (error) => {
            dispatch(setError(error.message));
            dispatch(completeStreaming());
            reject(error);
          },
        },
        abortController.signal
      );
    });
  }
);

// Thunk for sending streaming message with tool calling support
export const sendStreamingMessageWithTools = createAsyncThunk(
  'chat/sendStreamingMessageWithTools',
  async (
    { content, model, attachments, skillPrompt, effort }: { content: string; model: string; attachments?: Attachment[]; skillPrompt?: string; effort?: ReasoningEffort | null },
    { getState, dispatch }
  ) => {
    const MAX_TOOL_ITERATIONS = 5;
    const state = getState() as RootState;
    const provider = getAPIProvider();
    const temperature = state.settings.preferences.temperature;
    const reasoningEffort = effortForRequest(state, model, effort);

    const userMessageId = uuidv4();
    const assistantMessageId = uuidv4();
    const timestamp = new Date().toISOString();

    // Start streaming
    dispatch(startStreaming({
      userMessageId,
      assistantMessageId,
      userContent: content,
      userAttachments: attachments,
      timestamp,
      effort: reasoningEffort,
    }));

    // Clear tool state
    dispatch(clearToolCalls());

    // Get all messages for context (include attachments for prior messages)
    const messages = state.chat.messages.map((msg: Message) => buildAPIMessage(msg));

    // Add the new user message with attachments
    messages.push({
      role: 'user' as const,
      content: buildMessageContent(content, attachments),
      tool_calls: undefined,
      tool_call_id: undefined,
      name: undefined,
    });

    // Prepend global system prompt if set (only to API payload, not stored in chat state)
    const systemPromptText = state.settings.preferences.systemPrompt;
    if (systemPromptText) {
      messages.unshift({
        role: 'system' as const,
        content: systemPromptText,
        tool_calls: undefined,
        tool_call_id: undefined,
        name: undefined,
      });
    }

    // Inject skill prompt if a skill was invoked (inserted after global system prompt)
    if (skillPrompt) {
      const insertIdx = systemPromptText ? 1 : 0;
      messages.splice(insertIdx, 0, {
        role: 'system' as const,
        content: skillPrompt,
        tool_calls: undefined,
        tool_call_id: undefined,
        name: undefined,
      });
    }

    // Get available MCP tools, named by alias so same-named tools on two servers both work
    const mcpState = state.mcp;
    const openAITools = ToolIntegrationService.getOpenAITools(mcpState);
    const hasTools = openAITools.length > 0;
    const toolsFirstTurnOnly = provider.getCapabilities().toolsFirstTurnOnly === true;
    const files = openWebUIFiles(provider, state.chat.messages, attachments);

    console.log('[chatSlice] Sending message with tools:', {
      availableToolCount: openAITools.length,
      toolNames: openAITools.map(t => t.function.name),
      readyServers: Object.entries(mcpState.serverStates)
        .filter(([_, state]) => state.status === 'ready')
        .map(([id, state]) => ({ id, name: state.config.name, toolCount: state.tools.length })),
    });

    // Create abort controller
    const abortController = new AbortController();
    dispatch(setAbortController(abortController as any));

    // Tool calling loop
    let iteration = 0;
    let shouldContinue = true;

    while (shouldContinue && iteration < MAX_TOOL_ITERATIONS) {
      // Check if user aborted before starting new iteration
      if (abortController.signal.aborted) {
        dispatch(completeStreaming());
        dispatch(clearToolCalls());
        return;
      }

      try {
        // Tools are offered on every iteration so the model can chain calls,
        // unless the provider only accepts them on the first request.
        const offerTools = hasTools && (iteration === 0 || !toolsFirstTurnOnly);
        const tools = offerTools ? openAITools : undefined;
        const tool_choice = offerTools ? 'auto' : 'none';

        let assistantToolCalls: ToolCall[] = [];

        // Stream LLM response
        await new Promise<void>((resolve, reject) => {
          provider.streamChatCompletion(
            {
              model,
              messages,
              tools,
              tool_choice: tool_choice,
              temperature: temperature,
              reasoning_effort: reasoningEffort,
              files,
            },
            {
              onChunk: (chunk) => {
                if (chunk) {
                  dispatch(appendStreamingContent(chunk));
                }
              },
              onReasoning: (reasoning) => {
                dispatch(appendStreamingReasoning(reasoning));
              },
              onUsage: (usage) => {
                dispatch(setStreamingUsage(usage));
              },
              onComplete: () => {
                resolve();
              },
              onError: (error) => {
                dispatch(setError(error.message));
                reject(error);
              },
              onToolCalls: (toolCalls) => {
                assistantToolCalls = toolCalls;
                dispatch(setToolCalls(toolCalls));
              },
            },
            abortController.signal,
            undefined
          );
        });

        // Check if we have tool calls to execute
        if (assistantToolCalls.length > 0) {
          // Add assistant message with tool calls - reuse current streaming message ID
          const assistantMessageId = (getState() as RootState).chat.streamingMessageId || uuidv4();
          const assistantContent = (getState() as RootState).chat.streamingContent || '';
          const assistantReasoning = (getState() as RootState).chat.streamingReasoning || '';
          const assistantMessage: Message = {
            id: assistantMessageId,
            role: 'assistant',
            content: assistantContent,
            reasoning: assistantReasoning || undefined,
            timestamp: new Date().toISOString(),
            toolCalls: assistantToolCalls,
          };
          dispatch(addToolCallMessage(assistantMessage));

          // IMPORTANT: Add assistant message to messages array for LLM context
          // Strict providers (e.g. DeepSeek) reject assistant messages that have
          // BOTH 'content' and 'tool_calls'. We must send one or the other.
          // reasoning_content must still be included for DeepSeek thinking mode.
          const assistantAPIMessage: any = {
            role: 'assistant',
            tool_calls: assistantToolCalls,
          };
          if (assistantReasoning && assistantReasoning.trim()) {
            assistantAPIMessage.reasoning_content = assistantReasoning;
          }
          messages.push(assistantAPIMessage);

          // Clear streaming content for next iteration. completeStreaming() also
          // drops the stored controller, so re-register it: Stop must still
          // reach this loop while tools run.
          dispatch(completeStreaming());
          dispatch(setAbortController(abortController as any));

          // Check if user aborted before executing tools
          if (abortController.signal.aborted) {
            dispatch(clearToolCalls());
            return;
          }

          // Execute tools
          dispatch(setExecutingTools(true));
          const toolResults = await ToolIntegrationService.executeToolCalls(
            assistantToolCalls,
            mcpState,
            undefined
          );
          dispatch(setExecutingTools(false));

          // Update the assistant message with tool results
          dispatch(updateMessageToolResults({
            messageId: assistantMessageId,
            toolResults: toolResults,
          }));

          // Add tool result messages to history for LLM context
          for (const result of toolResults) {
            // Handle UI resources differently - send confirmation to LLM without full content
            let contentString: string;

            if (result.hasUI && result.uiResource) {
              // Send a simple confirmation to LLM instead of full UI content
              contentString = uiResourceConfirmation(result.name);

              // Add to Redux for UI rendering
              const toolResultMessage: Message = {
                id: uuidv4(),
                role: 'tool',
                content: contentString,
                timestamp: new Date().toISOString(),
                tool_call_id: result.tool_call_id,
                name: result.name,
                toolResults: [result],
              };
              dispatch(addToolCallMessage(toolResultMessage));
            } else {
              // Regular tool result - prepare content string for LLM
              if (typeof result.content === 'string') {
                contentString = result.content;
              } else {
                // Fallback for unexpected cases (should not happen with proper tool integration)
                contentString = JSON.stringify(result.content);
              }

              const toolResultMessage: Message = {
                id: uuidv4(),
                role: 'tool',
                content: contentString,
                timestamp: new Date().toISOString(),
                tool_call_id: result.tool_call_id,
                name: result.name,
                toolResults: [result],
              };
              dispatch(addToolCallMessage(toolResultMessage));
            }

            // Add to messages for next iteration (both UI and regular results)
            // Note: OpenAI tool messages only need role, content, tool_call_id.
            // 'name' is NOT part of the spec for role === 'tool' and can cause 400s.
            // Also truncate content to avoid hitting provider size limits.
            messages.push({
              role: 'tool',
              content: toolContentForModel(contentString),
              tool_call_id: result.tool_call_id,
            });
          }

          // Stopped while tools ran: keep the results, but don't ask the model again
          if (abortController.signal.aborted) {
            dispatch(clearToolCalls());
            return;
          }

          // Increment iteration and continue loop
          dispatch(incrementToolIteration());
          iteration++;
          shouldContinue = true;

          // Reset streaming for next iteration
          const nextAssistantMessageId = uuidv4();
          dispatch(startStreaming({
            userMessageId: uuidv4(),
            assistantMessageId: nextAssistantMessageId,
            userContent: '',
            timestamp: new Date().toISOString(),
          }));
          dispatch(setAbortController(abortController as any));
        } else {
          // No tool calls - complete streaming
          dispatch(completeStreaming());
          dispatch(clearToolCalls());
          shouldContinue = false;
        }
      } catch (error) {
        // Don't show error if user aborted
        if (error instanceof Error && error.name === 'AbortError') {
          dispatch(completeStreaming());
          dispatch(clearToolCalls());
          return;
        }
        dispatch(setError(error instanceof Error ? error.message : 'Unknown error'));
        dispatch(completeStreaming());
        dispatch(clearToolCalls());
        throw error;
      }
    }

    // If we hit max iterations, force completion
    if (iteration >= MAX_TOOL_ITERATIONS && shouldContinue) {
      dispatch(setError('Maximum tool calling iterations reached'));
      dispatch(completeStreaming());
      dispatch(clearToolCalls());
    }
  }
);

// Execute UI action from UIResourceRenderer
export const executeUIAction = createAsyncThunk(
  'chat/executeUIAction',
  async (
    {
      uri: _uri,
      toolName,
      action: _action,
      data,
      originalToolCallId,
    }: {
      uri: string;
      toolName: string;
      action: string;
      data?: Record<string, unknown>;
      originalToolCallId: string;
    },
    { getState, dispatch }
  ) => {
    const state = getState() as RootState;
    const mcpState = state.mcp;

    // Prefer the server that produced the UI resource, so a same-named tool on
    // another server is never picked by accident.
    const originalResult = state.chat.messages
      .flatMap((m) => m.toolResults ?? [])
      .find((r) => r.tool_call_id === originalToolCallId);
    const serverId = ToolIntegrationService.findServerForTool(toolName, mcpState, originalResult?.serverId);
    if (!serverId) {
      throw new Error(`Server for tool ${toolName} not found`);
    }

    // Use the data directly as tool arguments (data contains the actual tool params)
    const toolCall: ToolCall = {
      id: uuidv4(),
      type: 'function',
      function: {
        name: toolName,
        arguments: JSON.stringify(data || {}),
      },
    };

    dispatch(setExecutingTools(true));

    // Execute tool
    const result = await ToolIntegrationService.executeToolCall(toolCall, mcpState, undefined, {
      serverId,
      tool: toolName,
    });

    // Update original message with new result
    const message = state.chat.messages.find((m) =>
      m.toolResults?.some((r) => r.tool_call_id === originalToolCallId)
    );

    if (message && message.toolResults) {
      // Override the result's tool_call_id to match the original
      const updatedResult: ToolResult = {
        ...result,
        tool_call_id: originalToolCallId,
      };

      const updatedResults = message.toolResults.map((r) =>
        r.tool_call_id === originalToolCallId ? updatedResult : r
      );

      dispatch(updateMessageToolResults({
        messageId: message.id,
        toolResults: updatedResults,
      }));
    }

    dispatch(setExecutingTools(false));

    return result;
  }
);

export default chatSlice.reducer;

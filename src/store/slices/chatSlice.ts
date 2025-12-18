import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { Message, Attachment, ToolCall, ToolResult } from '../../types/message.types';
import { getAPIProvider } from '../../services/api/provider.service';
import { ToolIntegrationService } from '../../services/mcp/tool-integration.service';
import { v4 as uuidv4 } from 'uuid';
import type { RootState } from '../index';

interface ChatState {
  messages: Message[];
  isLoading: boolean;
  isStreaming: boolean;
  streamingMessageId: string | null;
  streamingContent: string;
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
  error: null,
  abortController: null,
  pendingToolCalls: [],
  isExecutingTools: false,
  toolCallIteration: 0,
  editingMessage: null,
};

// Async thunk for sending a message
export const sendMessage = createAsyncThunk(
  'chat/sendMessage',
  async (
    { content, model, attachments }: { content: string; model: string; attachments?: Attachment[] },
    { getState, rejectWithValue }
  ) => {
    try {
      const state = getState() as any;
      const provider = getAPIProvider();
      const temperature = state.settings.preferences.temperature;

      // Get all messages for context
      const messages = state.chat.messages.map((msg: Message) => ({
        role: msg.role,
        content: msg.content,
      }));

      // Add the new user message
      messages.push({
        role: 'user' as const,
        content,
      });

      // Call the API
      const response = await provider.chatCompletion({
        model,
        messages,
        stream: false,
        temperature: temperature,
      });

      const assistantContent = response.choices[0].message.content;

      return {
        userMessageId: uuidv4(),
        assistantMessageId: uuidv4(),
        userContent: content,
        userAttachments: attachments,
        assistantContent: assistantContent,
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
    startStreaming: (state, action: PayloadAction<{ userMessageId: string; assistantMessageId: string; userContent: string; userAttachments?: Attachment[]; timestamp: string }>) => {
      state.isStreaming = true;
      state.streamingContent = '';
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
        });
      }
    },
    appendStreamingContent: (state, action: PayloadAction<string>) => {
      state.streamingContent += action.payload;
    },
    completeStreaming: (state) => {
      if (state.streamingMessageId && state.streamingContent) {
        // Add the complete assistant message
        state.messages.push({
          id: state.streamingMessageId,
          role: 'assistant',
          content: state.streamingContent,
          timestamp: new Date().toISOString(),
        });
      }

      state.isStreaming = false;
      state.streamingContent = '';
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
      state.isStreaming = false;
      state.streamingContent = '';
      state.streamingMessageId = null;
      state.abortController = null;
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
        });

        // Add assistant message
        state.messages.push({
          id: action.payload.assistantMessageId,
          role: 'assistant',
          content: action.payload.assistantContent || '',
          timestamp: action.payload.timestamp,
        });
      })
      // Send message rejected
      .addCase(sendMessage.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload as string;
      });
  },
});

export const {
  addMessage,
  clearMessages,
  setError,
  startStreaming,
  appendStreamingContent,
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
    { content, model, attachments }: { content: string; model: string; attachments?: Attachment[] },
    { getState, dispatch }
  ) => {
    const state = getState() as any;
    const provider = getAPIProvider();
    const temperature = state.settings.preferences.temperature;

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
    }));

    // Get all messages for context
    const messages = state.chat.messages.map((msg: Message) => ({
      role: msg.role,
      content: msg.content,
    }));

    // Add the new user message
    messages.push({
      role: 'user' as const,
      content,
    });

    // Create abort controller
    const abortController = new AbortController();
    dispatch(setAbortController(abortController as any));

    return new Promise<void>((resolve, reject) => {
      provider.streamChatCompletion(
        {
          model,
          messages,
          temperature: temperature,
        },
        {
          onChunk: (chunk) => {
            dispatch(appendStreamingContent(chunk));
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
    { content, model, attachments }: { content: string; model: string; attachments?: Attachment[] },
    { getState, dispatch }
  ) => {
    const MAX_TOOL_ITERATIONS = 5;
    const state = getState() as RootState;
    const provider = getAPIProvider();
    const temperature = state.settings.preferences.temperature;

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
    }));

    // Clear tool state
    dispatch(clearToolCalls());

    // Get all messages for context
    let messages = state.chat.messages.map((msg: Message) => ({
      role: msg.role,
      content: msg.content,
      tool_calls: msg.toolCalls,
      tool_call_id: msg.tool_call_id,
      name: msg.name,
    }));

    // Add the new user message
    messages.push({
      role: 'user' as const,
      content,
      tool_calls: undefined,
      tool_call_id: undefined,
      name: undefined,
    });

    // Get available MCP tools
    const mcpState = state.mcp;
    const availableTools = ToolIntegrationService.getAvailableTools(mcpState);
    const hasTools = ToolIntegrationService.hasAvailableTools(mcpState);

    // Create abort controller
    const abortController = new AbortController();
    dispatch(setAbortController(abortController as any));

    // Tool calling loop
    let iteration = 0;
    let shouldContinue = true;

    while (shouldContinue && iteration < MAX_TOOL_ITERATIONS) {
      try {
        // Convert MCP tools to OpenAI format
        const openAITools = hasTools
          ? ToolIntegrationService.mcpToolsToOpenAI(availableTools)
          : undefined;

        const tool_choice = !hasTools ? 'none' : (iteration >= MAX_TOOL_ITERATIONS - 1 ? 'none' : 'auto');

        let assistantToolCalls: ToolCall[] = [];

        // Stream LLM response
        await new Promise<void>((resolve, reject) => {
          provider.streamChatCompletion(
            {
              model,
              messages,
              tools: openAITools,
              tool_choice: tool_choice,
              temperature: temperature,
            },
            {
              onChunk: (chunk) => {
                if (chunk) {
                  dispatch(appendStreamingContent(chunk));
                }
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
          // Add assistant message with tool calls
          const assistantMessageId = uuidv4();
          const assistantContent = (getState() as RootState).chat.streamingContent || '';
          const assistantMessage: Message = {
            id: assistantMessageId,
            role: 'assistant',
            content: assistantContent,
            timestamp: new Date().toISOString(),
            toolCalls: assistantToolCalls,
          };
          dispatch(addToolCallMessage(assistantMessage));

          // IMPORTANT: Add assistant message to messages array for LLM context
          messages.push({
            role: 'assistant',
            content: assistantContent,
            tool_calls: assistantToolCalls,
            tool_call_id: undefined,
            name: undefined,
          });

          // Clear streaming content for next iteration
          dispatch(completeStreaming());

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
              contentString = `Interactive UI component displayed successfully. The user can now interact with the ${result.name} interface.`;

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
            messages.push({
              role: 'tool',
              content: contentString,
              tool_calls: undefined,
              tool_call_id: result.tool_call_id,
              name: result.name,
            });
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
        } else {
          // No tool calls - complete streaming
          dispatch(completeStreaming());
          dispatch(clearToolCalls());
          shouldContinue = false;
        }
      } catch (error) {
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

    // Find server for this tool
    const serverId = ToolIntegrationService['findServerForTool'](toolName, mcpState);
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
    const result = await ToolIntegrationService.executeToolCall(toolCall, mcpState);

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

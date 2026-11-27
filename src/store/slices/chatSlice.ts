import { createSlice, createAsyncThunk, PayloadAction, type UnknownAction } from '@reduxjs/toolkit';
import { Message, Attachment, ToolCall, ToolResult } from '../../types/message.types';
import { MessageUsage } from '../../types/statistics.types';
import { ChatCompletionRequest, ChatMessage, RequestOptions } from '../../types/api.types';
import {
  buildMessageContent,
  remoteFileIds,
  toolContentForModel,
  uiResourceConfirmation,
} from '../../services/chat/message-builder';
import type { IAPIProvider } from '../../services/api/provider.interface';
import { getAPIProvider } from '../../services/api/provider.service';
import { ToolIntegrationService } from '../../services/mcp/tool-integration.service';
import {
  answerApproval,
  approvalTarget,
  waitForApproval,
  waitingCallsFor,
  type ApprovalDecision,
} from '../../services/mcp/tool-approvals';
import { withToolPolicy } from '../../services/mcp/tool-policy';
import { saveMCPServer } from './mcpSlice';
import { v4 as uuidv4 } from 'uuid';
import type { RootState } from '../index';
import { ReasoningEffort, resolveEffort, coerceEffort } from '../../utils/effort-utils';
import { withVisualExplanations } from '../../utils/visual-explanations';
import { prepareHistory } from '../../services/chat/history-compaction';

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
  /** Earlier messages are being summarized to fit the context window. */
  isCompacting: boolean;
  /** Tool calls (ids) waiting for the user to allow or deny them. */
  awaitingApproval: string[];
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
  isCompacting: false,
  awaitingApproval: [],
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
 * then the session override, then the Preferences default â€” mapped onto a tier
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

/** The open conversation, so providers that route by conversation keep one session per chat. */
function conversationOptions(state: RootState): RequestOptions {
  return { sessionId: state.conversation.currentConversationId ?? undefined };
}

/**
 * The messages to send: system prompts, the chat so far fitted to the model's
 * context window (the oldest exchanges summarized when it nears the limit),
 * and the message being sent. A new summary is stored on the last message it
 * covers, so the conversation's autosave keeps it for later sends.
 */
async function requestMessages(
  state: RootState,
  dispatch: (action: UnknownAction) => unknown,
  provider: IAPIProvider,
  model: string,
  system: ChatMessage[],
  current: ChatMessage[],
  signal?: AbortSignal
): Promise<ChatMessage[]> {
  const prefs = state.settings.preferences;
  try {
    const prepared = await prepareHistory({
      history: state.chat.messages,
      system,
      current,
      model,
      modelContextLengths: state.settings.api.modelContextLengths,
      compaction: { enabled: prefs.contextCompaction !== false, threshold: prefs.compactionThreshold },
      provider,
      signal,
      sessionId: conversationOptions(state).sessionId,
      onSummarizing: () => dispatch(setCompacting(true)),
    });
    if (prepared.compaction) dispatch(setCompaction(prepared.compaction));
    return prepared.messages;
  } finally {
    dispatch(setCompacting(false));
  }
}

/** The global system prompt and an invoked skill: sent with the request, never stored in the chat. */
function systemMessages(state: RootState, skillPrompt?: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  const systemPrompt = withVisualExplanations(state.settings.preferences.systemPrompt, state.settings.preferences.visualExplanations);
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
  if (skillPrompt) out.push({ role: 'system', content: skillPrompt });
  return out;
}

// Async thunk for sending a message
export const sendMessage = createAsyncThunk(
  'chat/sendMessage',
  async (
    { content, model, attachments, effort }: { content: string; model: string; attachments?: Attachment[]; effort?: ReasoningEffort | null },
    { getState, dispatch, rejectWithValue }
  ) => {
    try {
      const state = getState() as RootState;
      const provider = getAPIProvider();
      const temperature = state.settings.preferences.temperature;
      const reasoningEffort = effortForRequest(state, model, effort);

      // System prompts, the history that fits, then the new message
      const messages = await requestMessages(state, dispatch, provider, model, systemMessages(state), [
        { role: 'user', content: buildMessageContent(content, attachments) },
      ]);

      // Call the API
      const response = await provider.chatCompletion({
        model,
        messages,
        stream: false,
        temperature: temperature,
        reasoning_effort: reasoningEffort,
        files: openWebUIFiles(provider, state.chat.messages, attachments),
      }, conversationOptions(state));

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
      // A reply still running belongs to the chat being cleared: stop it
      // (this also releases tool calls waiting for approval)
      (state.abortController as AbortController | null)?.abort();
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
      state.awaitingApproval = [];
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
      state.awaitingApproval = [];
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
    /** A tool call waits for the user, or how they decided. */
    setToolApproval: (state, action: PayloadAction<{ callId: string; approval: NonNullable<ToolCall['approval']> }>) => {
      const { callId, approval } = action.payload;
      for (const message of state.messages) {
        const call = message.toolCalls?.find((c) => c.id === callId);
        if (call) call.approval = approval;
      }
      state.awaitingApproval = state.awaitingApproval.filter((id) => id !== callId);
      if (approval === 'pending') state.awaitingApproval.push(callId);
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
    setCompacting: (state, action: PayloadAction<boolean>) => {
      state.isCompacting = action.payload;
    },
    /** The messages up to and including `messageId` were summarized. */
    setCompaction: (state, action: PayloadAction<{ messageId: string; summary: string; turns: number }>) => {
      const message = state.messages.find((m) => m.id === action.payload.messageId);
      if (message) message.compaction = { summary: action.payload.summary, turns: action.payload.turns };
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
  setCompacting,
  setCompaction,
  setToolApproval,
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

    // Created first, so Stop also reaches a summary of earlier messages
    const abortController = new AbortController();
    dispatch(setAbortController(abortController as any));

    // System prompts, the history that fits, then the new message
    let messages: ChatMessage[];
    try {
      messages = await requestMessages(state, dispatch, provider, model, systemMessages(state), [
        { role: 'user', content: buildMessageContent(content, attachments) },
      ], abortController.signal);
    } catch (error) {
      dispatch(completeStreaming());
      if (abortController.signal.aborted) return;
      throw error;
    }
    // Stopped while the summary was being written: don't send
    if (abortController.signal.aborted) {
      dispatch(completeStreaming());
      return;
    }

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
        abortController.signal,
        undefined,
        conversationOptions(state)
      );
    });
  }
);

/** A tool call that did not run, with the reason for the model. */
function notRun(call: ToolCall, name: string, serverId: string, reason: string): ToolResult {
  return { tool_call_id: call.id, role: 'tool', name, content: JSON.stringify({ error: reason }), isError: true, serverId };
}

/**
 * Run a reply's tool calls in parallel, each by its tool's policy: allowed
 * ones run, blocked ones are refused, and the rest wait for the user's
 * approval first (Stop refuses those still waiting).
 */
async function runToolCalls(
  calls: ToolCall[],
  getState: () => unknown,
  dispatch: (action: UnknownAction) => unknown,
  signal: AbortSignal
): Promise<ToolResult[]> {
  return Promise.all(
    calls.map(async (call) => {
      const mcp = (getState() as RootState).mcp;
      const target = ToolIntegrationService.resolveTool(call.function.name, mcp);
      if (target) {
        const policy = ToolIntegrationService.policyFor(target, mcp);
        if (policy === 'block') {
          return notRun(call, target.tool, target.serverId, "This tool is blocked in Claudia's settings, so it was not run.");
        }
        if (policy === 'ask') {
          dispatch(setToolApproval({ callId: call.id, approval: 'pending' }));
          const decision = await waitForApproval(call.id, target, signal);
          if (decision === 'deny' || decision === 'stopped') {
            dispatch(setToolApproval({ callId: call.id, approval: 'rejected' }));
            const reason = decision === 'deny' ? 'The user denied this tool call.' : 'Stopped by the user before the tool ran.';
            return notRun(call, target.tool, target.serverId, reason);
          }
          dispatch(setToolApproval({ callId: call.id, approval: 'approved' }));
        }
      }
      return ToolIntegrationService.executeToolCall(call, (getState() as RootState).mcp, undefined, target);
    })
  );
}

/**
 * The user's answer to a tool call waiting for approval. "Always allow" saves
 * the tool as allowed on its server, and lets the other waiting calls to it run too.
 */
export const answerToolApproval = createAsyncThunk(
  'chat/answerToolApproval',
  async ({ callId, decision }: { callId: string; decision: ApprovalDecision }, { getState, dispatch }) => {
    const target = approvalTarget(callId);
    if (!target) return;
    if (decision !== 'always') {
      answerApproval(callId, decision);
      return;
    }
    const mcp = (getState() as RootState).mcp;
    const config = mcp.servers[target.serverId];
    if (config) {
      const tool = mcp.serverStates[target.serverId]?.tools?.find((t) => t.name === target.tool) ?? { name: target.tool };
      // (if saving fails, this call still runs: it was allowed)
      await dispatch(saveMCPServer(withToolPolicy(config, tool, 'allow')));
    }
    for (const id of waitingCallsFor(target)) answerApproval(id, 'always');
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

    // Create abort controller (Stop also reaches a summary of earlier messages)
    const abortController = new AbortController();
    dispatch(setAbortController(abortController as any));

    // System prompts and the invoked skill, the history that fits, then the new message
    let messages: ChatMessage[];
    try {
      messages = await requestMessages(state, dispatch, provider, model, systemMessages(state, skillPrompt), [
        { role: 'user', content: buildMessageContent(content, attachments) },
      ], abortController.signal);
    } catch (error) {
      dispatch(completeStreaming());
      dispatch(clearToolCalls());
      if (abortController.signal.aborted) return;
      throw error;
    }

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
            undefined,
            conversationOptions(state)
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

          // Execute tools (those that ask wait for the user first)
          dispatch(setExecutingTools(true));
          const toolResults = await runToolCalls(assistantToolCalls, getState, dispatch, abortController.signal);
          dispatch(setExecutingTools(false));

          // The chat was cleared or switched while they ran: nothing to add the results to
          if (abortController.signal.aborted && !(getState() as RootState).chat.messages.some((m) => m.id === assistantMessageId)) {
            dispatch(clearToolCalls());
            return;
          }

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

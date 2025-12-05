import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import {
  Conversation,
  ConversationMetadata,
  ConversationState,
  CreateConversationParams,
  UpdateConversationParams,
} from '../../types/conversation.types';
import { Message } from '../../types/message.types';
import { v4 as uuidv4 } from 'uuid';

const initialState: ConversationState = {
  conversations: [],
  currentConversationId: null,
  isLoading: false,
  isSaving: false,
  error: null,
};

// Create a new conversation
export const createConversation = createAsyncThunk(
  'conversation/create',
  async (params: CreateConversationParams, { rejectWithValue }) => {
    try {
      const conversation: Conversation = {
        id: uuidv4(),
        projectId: params.projectId ?? null,
        title: params.title || 'New Conversation',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        model: params.model,
        messages: [],
        messageCount: 0,
      };

      const result = await window.electron.conversation.save(conversation);

      if (!result.success) {
        return rejectWithValue(result.error || 'Failed to create conversation');
      }

      return conversation;
    } catch (error) {
      return rejectWithValue(
        error instanceof Error ? error.message : 'Failed to create conversation'
      );
    }
  }
);

// Load all conversations
export const loadConversations = createAsyncThunk(
  'conversation/loadAll',
  async (projectId: string | null | undefined, { rejectWithValue }) => {
    try {
      const result = await window.electron.conversation.list(projectId);

      if (!result.success) {
        return rejectWithValue(result.error || 'Failed to load conversations');
      }

      return result.data as ConversationMetadata[];
    } catch (error) {
      return rejectWithValue(
        error instanceof Error ? error.message : 'Failed to load conversations'
      );
    }
  }
);

// Load a specific conversation
export const loadConversation = createAsyncThunk(
  'conversation/load',
  async ({ id, projectId }: { id: string; projectId: string | null }, { rejectWithValue }) => {
    try {
      const result = await window.electron.conversation.load(id, projectId);

      if (!result.success) {
        return rejectWithValue(result.error || 'Failed to load conversation');
      }

      return result.data as Conversation;
    } catch (error) {
      return rejectWithValue(
        error instanceof Error ? error.message : 'Failed to load conversation'
      );
    }
  }
);

// Save conversation
export const saveConversation = createAsyncThunk(
  'conversation/save',
  async (conversation: Conversation, { rejectWithValue }) => {
    try {
      const result = await window.electron.conversation.save(conversation);

      if (!result.success) {
        return rejectWithValue(result.error || 'Failed to save conversation');
      }

      return conversation;
    } catch (error) {
      return rejectWithValue(
        error instanceof Error ? error.message : 'Failed to save conversation'
      );
    }
  }
);

// Update conversation metadata
export const updateConversation = createAsyncThunk(
  'conversation/update',
  async (params: UpdateConversationParams, { getState, rejectWithValue }) => {
    try {
      const state = getState() as any;
      const conversation = state.conversation.conversations.find(
        (c: ConversationMetadata) => c.id === params.id
      );

      if (!conversation) {
        return rejectWithValue('Conversation not found');
      }

      // Load full conversation
      const loadResult = await window.electron.conversation.load(
        params.id,
        conversation.projectId
      );

      if (!loadResult.success) {
        return rejectWithValue('Failed to load conversation');
      }

      const fullConversation: Conversation = loadResult.data;

      // Update fields
      if (params.title !== undefined) {
        fullConversation.title = params.title;
      }
      if (params.model !== undefined) {
        fullConversation.model = params.model;
      }

      fullConversation.updatedAt = new Date().toISOString();

      // Save updated conversation
      const saveResult = await window.electron.conversation.save(fullConversation);

      if (!saveResult.success) {
        return rejectWithValue('Failed to save conversation');
      }

      return {
        id: fullConversation.id,
        projectId: fullConversation.projectId,
        title: fullConversation.title,
        createdAt: fullConversation.createdAt,
        updatedAt: fullConversation.updatedAt,
        model: fullConversation.model,
        messageCount: fullConversation.messageCount,
      } as ConversationMetadata;
    } catch (error) {
      return rejectWithValue(
        error instanceof Error ? error.message : 'Failed to update conversation'
      );
    }
  }
);

// Delete conversation
export const deleteConversation = createAsyncThunk(
  'conversation/delete',
  async ({ id, projectId }: { id: string; projectId: string | null }, { rejectWithValue }) => {
    try {
      const result = await window.electron.conversation.delete(id, projectId);

      if (!result.success) {
        return rejectWithValue(result.error || 'Failed to delete conversation');
      }

      return id;
    } catch (error) {
      return rejectWithValue(
        error instanceof Error ? error.message : 'Failed to delete conversation'
      );
    }
  }
);

const conversationSlice = createSlice({
  name: 'conversation',
  initialState,
  reducers: {
    setCurrentConversation: (state, action: PayloadAction<string | null>) => {
      state.currentConversationId = action.payload;
    },
    clearError: (state) => {
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      // Create conversation
      .addCase(createConversation.pending, (state) => {
        state.isSaving = true;
        state.error = null;
      })
      .addCase(createConversation.fulfilled, (state, action) => {
        state.isSaving = false;
        state.conversations.unshift({
          id: action.payload.id,
          projectId: action.payload.projectId,
          title: action.payload.title,
          createdAt: action.payload.createdAt,
          updatedAt: action.payload.updatedAt,
          model: action.payload.model,
          messageCount: action.payload.messageCount,
        });
        state.currentConversationId = action.payload.id;
      })
      .addCase(createConversation.rejected, (state, action) => {
        state.isSaving = false;
        state.error = action.payload as string;
      })

      // Load conversations
      .addCase(loadConversations.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(loadConversations.fulfilled, (state, action) => {
        state.isLoading = false;
        state.conversations = action.payload;
      })
      .addCase(loadConversations.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload as string;
      })

      // Load conversation
      .addCase(loadConversation.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(loadConversation.fulfilled, (state, action) => {
        state.isLoading = false;
        state.currentConversationId = action.payload.id;
      })
      .addCase(loadConversation.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload as string;
      })

      // Save conversation
      .addCase(saveConversation.pending, (state) => {
        state.isSaving = true;
      })
      .addCase(saveConversation.fulfilled, (state, action) => {
        state.isSaving = false;
        // Update conversation metadata in the list
        const index = state.conversations.findIndex((c) => c.id === action.payload.id);
        if (index !== -1) {
          state.conversations[index] = {
            id: action.payload.id,
            projectId: action.payload.projectId,
            title: action.payload.title,
            createdAt: action.payload.createdAt,
            updatedAt: action.payload.updatedAt,
            model: action.payload.model,
            messageCount: action.payload.messageCount,
          };
        }
      })
      .addCase(saveConversation.rejected, (state, action) => {
        state.isSaving = false;
        state.error = action.payload as string;
      })

      // Update conversation
      .addCase(updateConversation.pending, (state) => {
        state.isSaving = true;
      })
      .addCase(updateConversation.fulfilled, (state, action) => {
        state.isSaving = false;
        const index = state.conversations.findIndex((c) => c.id === action.payload.id);
        if (index !== -1) {
          state.conversations[index] = action.payload;
        }
      })
      .addCase(updateConversation.rejected, (state, action) => {
        state.isSaving = false;
        state.error = action.payload as string;
      })

      // Delete conversation
      .addCase(deleteConversation.pending, (state) => {
        state.isLoading = true;
      })
      .addCase(deleteConversation.fulfilled, (state, action) => {
        state.isLoading = false;
        state.conversations = state.conversations.filter((c) => c.id !== action.payload);
        if (state.currentConversationId === action.payload) {
          state.currentConversationId = null;
        }
      })
      .addCase(deleteConversation.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload as string;
      });
  },
});

export const { setCurrentConversation, clearError } = conversationSlice.actions;

export default conversationSlice.reducer;

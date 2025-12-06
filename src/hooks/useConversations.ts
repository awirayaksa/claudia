import { useCallback, useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import {
  loadConversations,
  loadConversation,
  createConversation,
  saveConversation,
  updateConversation,
  deleteConversation,
  setCurrentConversation,
} from '../store/slices/conversationSlice';
import { Conversation } from '../types/conversation.types';

export function useConversations() {
  const dispatch = useAppDispatch();
  const {
    conversations,
    currentConversationId,
    isLoading,
    isSaving,
    error,
  } = useAppSelector((state) => state.conversation);

  const { selectedModel } = useAppSelector((state) => state.settings.api);
  const { currentProjectId } = useAppSelector((state) => state.project);

  // Load conversations for a project (or all if no projectId)
  const loadAll = useCallback(
    (projectId?: string | null) => {
      dispatch(loadConversations(projectId));
    },
    [dispatch]
  );

  // Create a new conversation
  const create = useCallback(
    async (title?: string, model?: string) => {
      const modelToUse = model || selectedModel;
      if (!modelToUse) {
        throw new Error('Please select a model in settings');
      }

      const result = await dispatch(
        createConversation({
          projectId: currentProjectId,
          title: title || 'New Conversation',
          model: modelToUse,
        })
      );

      return result.payload;
    },
    [dispatch, selectedModel, currentProjectId]
  );

  // Load a specific conversation
  const load = useCallback(
    async (id: string, projectId: string | null) => {
      const result = await dispatch(loadConversation({ id, projectId }));
      return result.payload;
    },
    [dispatch]
  );

  // Save conversation
  const save = useCallback(
    async (conversation: Conversation) => {
      await dispatch(saveConversation(conversation));
    },
    [dispatch]
  );

  // Update conversation metadata
  const update = useCallback(
    async (id: string, updates: { title?: string; model?: string }) => {
      await dispatch(updateConversation({ id, ...updates }));
    },
    [dispatch]
  );

  // Delete conversation
  const remove = useCallback(
    async (id: string, projectId: string | null) => {
      await dispatch(deleteConversation({ id, projectId }));
    },
    [dispatch]
  );

  // Set current conversation
  const setCurrent = useCallback(
    (id: string | null) => {
      dispatch(setCurrentConversation(id));
    },
    [dispatch]
  );

  // Get current conversation metadata
  const currentConversation = conversations.find(
    (c) => c.id === currentConversationId
  );

  return {
    conversations,
    currentConversationId,
    currentConversation,
    isLoading,
    isSaving,
    error,
    loadAll,
    create,
    load,
    save,
    update,
    remove,
    setCurrent,
  };
}

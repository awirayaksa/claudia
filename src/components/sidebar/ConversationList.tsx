import React, { useEffect, useState } from 'react';
import { ConversationItem } from './ConversationItem';
import { ProjectSelector } from './ProjectSelector';
import { Button } from '../common/Button';
import { ProjectManager } from '../project/ProjectManager';
import { useAppSelector, useAppDispatch } from '../../store';
import { useProjects } from '../../hooks/useProjects';
import {
  loadConversations,
  setCurrentConversation,
  updateConversation,
  deleteConversation,
  createConversation,
} from '../../store/slices/conversationSlice';
import { clearMessages } from '../../store/slices/chatSlice';

export function ConversationList() {
  const dispatch = useAppDispatch();
  const {
    conversations,
    currentConversationId,
    isLoading,
    error,
  } = useAppSelector((state) => state.conversation);
  const { selectedModel } = useAppSelector((state) => state.settings.api);
  const { currentProjectId } = useProjects();

  const [isProjectManagerOpen, setIsProjectManagerOpen] = useState(false);

  // Load conversations when project changes
  useEffect(() => {
    dispatch(loadConversations(currentProjectId));
  }, [dispatch, currentProjectId]);

  const handleNewConversation = async () => {
    if (!selectedModel) {
      alert('Please select a model in settings first');
      return;
    }

    // Clear the current chat state (messages, loading states, etc.)
    dispatch(clearMessages());

    // Create new conversation
    await dispatch(
      createConversation({
        projectId: currentProjectId,
        title: 'New Conversation',
        model: selectedModel,
      })
    );
  };

  const handleSelectConversation = (id: string) => {
    dispatch(setCurrentConversation(id));
  };

  const handleRename = async (id: string, newTitle: string) => {
    await dispatch(updateConversation({ id, title: newTitle }));
  };

  const handleDelete = async (id: string) => {
    const conversation = conversations.find((c) => c.id === id);
    if (conversation) {
      await dispatch(deleteConversation({ id, projectId: conversation.projectId }));
    }
  };

  return (
    <div className="flex h-full flex-col bg-surface border-r border-border w-64">
      {/* Header */}
      <div className="border-b border-border p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-text-primary">Conversations</h2>
        </div>

        {/* Project Selector */}
        <div className="mb-3">
          <ProjectSelector onManageProjects={() => setIsProjectManagerOpen(true)} />
        </div>

        <Button onClick={handleNewConversation} className="w-full" size="sm">
          <svg
            className="h-4 w-4 mr-2"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 4v16m8-8H4"
            />
          </svg>
          New Chat
        </Button>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto p-2">
        {isLoading && conversations.length === 0 ? (
          <div className="flex items-center justify-center h-32">
            <div className="text-sm text-text-secondary">Loading...</div>
          </div>
        ) : error ? (
          <div className="p-4 text-center">
            <p className="text-sm text-error">{error}</p>
          </div>
        ) : conversations.length === 0 ? (
          <div className="p-4 text-center">
            <svg
              className="mx-auto mb-2 h-12 w-12 text-text-secondary opacity-50"
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
            <p className="text-sm text-text-secondary">No conversations yet</p>
            <p className="mt-1 text-xs text-text-secondary">
              Click "New Chat" to start
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {conversations.map((conversation) => (
              <ConversationItem
                key={conversation.id}
                conversation={conversation}
                isActive={conversation.id === currentConversationId}
                onClick={() => handleSelectConversation(conversation.id)}
                onRename={handleRename}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>

      {/* Footer info */}
      <div className="border-t border-border p-3">
        <p className="text-xs text-text-secondary">
          {conversations.length} conversation{conversations.length !== 1 ? 's' : ''}
        </p>
      </div>

      {/* Project Manager Modal */}
      <ProjectManager
        isOpen={isProjectManagerOpen}
        onClose={() => setIsProjectManagerOpen(false)}
      />
    </div>
  );
}

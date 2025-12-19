import { useEffect, useState } from 'react';
import { ConversationItem } from './ConversationItem';
import { ProjectSelector } from './ProjectSelector';
import { Button } from '../common/Button';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { ProjectManager } from '../project/ProjectManager';
import { useAppSelector, useAppDispatch } from '../../store';
import { useProjects } from '../../hooks/useProjects';
import {
  loadConversations,
  setCurrentConversation,
  updateConversation,
  deleteConversation,
  deleteMultipleConversations,
  deleteAllConversations,
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
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showDeleteAllDialog, setShowDeleteAllDialog] = useState(false);
  const [showDeleteSelectedDialog, setShowDeleteSelectedDialog] = useState(false);

  // Load conversations when project changes
  useEffect(() => {
    dispatch(loadConversations(currentProjectId));
  }, [dispatch, currentProjectId]);

  // Reset selection mode when project changes
  useEffect(() => {
    setIsSelectionMode(false);
    setSelectedIds(new Set());
  }, [currentProjectId]);

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

  const handleToggleSelectionMode = () => {
    setIsSelectionMode(!isSelectionMode);
    setSelectedIds(new Set());
  };

  const handleToggleSelect = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  const handleSelectAll = () => {
    if (selectedIds.size === conversations.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(conversations.map((c) => c.id)));
    }
  };

  const handleDeleteSelected = async () => {
    const conversationsToDelete = Array.from(selectedIds)
      .map((id) => {
        const conv = conversations.find((c) => c.id === id);
        return conv ? { id, projectId: conv.projectId } : null;
      })
      .filter((c): c is { id: string; projectId: string | null } => c !== null);

    await dispatch(deleteMultipleConversations(conversationsToDelete));

    setShowDeleteSelectedDialog(false);
    setSelectedIds(new Set());
    setIsSelectionMode(false);
  };

  const handleDeleteAll = async () => {
    await dispatch(deleteAllConversations(currentProjectId));
    setShowDeleteAllDialog(false);
  };

  return (
    <div className="flex h-full flex-col bg-surface border-r border-border w-64">
      {/* Header */}
      <div className="border-b border-border p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-text-primary">Conversations</h2>
          {conversations.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleToggleSelectionMode}
            >
              {isSelectionMode ? 'Cancel' : 'Select'}
            </Button>
          )}
        </div>

        {/* Project Selector */}
        <div className="mb-3">
          <ProjectSelector onManageProjects={() => setIsProjectManagerOpen(true)} />
        </div>

        {/* Selection Mode Toolbar */}
        {isSelectionMode && (
          <div className="mb-3 flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleSelectAll}
              className="flex-1"
            >
              {selectedIds.size === conversations.length ? 'Deselect All' : 'Select All'}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => setShowDeleteSelectedDialog(true)}
              disabled={selectedIds.size === 0}
              className="flex-1 bg-error hover:bg-error-hover disabled:bg-error disabled:opacity-50"
            >
              Delete ({selectedIds.size})
            </Button>
          </div>
        )}

        {/* New Chat Button */}
        {!isSelectionMode && (
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
        )}
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
                isSelectionMode={isSelectionMode}
                isSelected={selectedIds.has(conversation.id)}
                onClick={() => handleSelectConversation(conversation.id)}
                onToggleSelect={handleToggleSelect}
                onRename={handleRename}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>

      {/* Footer info */}
      <div className="border-t border-border p-3">
        {!isSelectionMode ? (
          <div className="flex items-center justify-between">
            <p className="text-xs text-text-secondary">
              {conversations.length} conversation{conversations.length !== 1 ? 's' : ''}
            </p>
            {conversations.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowDeleteAllDialog(true)}
                className="text-xs text-error hover:bg-error hover:bg-opacity-10"
              >
                Delete All
              </Button>
            )}
          </div>
        ) : (
          <p className="text-xs text-text-secondary">
            {selectedIds.size} selected
          </p>
        )}
      </div>

      {/* Project Manager Modal */}
      <ProjectManager
        isOpen={isProjectManagerOpen}
        onClose={() => setIsProjectManagerOpen(false)}
      />

      {/* Delete All Confirmation Dialog */}
      <ConfirmDialog
        isOpen={showDeleteAllDialog}
        onClose={() => setShowDeleteAllDialog(false)}
        onConfirm={handleDeleteAll}
        title="Delete All Conversations"
        message={`Are you sure you want to delete all ${conversations.length} conversation${
          conversations.length !== 1 ? 's' : ''
        }? This action cannot be undone.`}
        confirmText="Delete All"
        isDestructive={true}
        isLoading={isLoading}
      />

      {/* Delete Selected Confirmation Dialog */}
      <ConfirmDialog
        isOpen={showDeleteSelectedDialog}
        onClose={() => setShowDeleteSelectedDialog(false)}
        onConfirm={handleDeleteSelected}
        title="Delete Selected Conversations"
        message={`Are you sure you want to delete ${selectedIds.size} conversation${
          selectedIds.size !== 1 ? 's' : ''
        }? This action cannot be undone.`}
        confirmText="Delete Selected"
        isDestructive={true}
        isLoading={isLoading}
      />
    </div>
  );
}

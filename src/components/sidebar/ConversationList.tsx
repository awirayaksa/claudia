import { useEffect, useState, useRef } from 'react';
import { ConversationItem } from './ConversationItem';
import { UpdateNotification } from './UpdateNotification';
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
import { ConversationMetadata } from '../../types/conversation.types';
import { isToday, isYesterday, isThisWeek, parseISO } from 'date-fns';

function groupConversations(conversations: ConversationMetadata[]) {
  const today: ConversationMetadata[] = [];
  const yesterday: ConversationMetadata[] = [];
  const week: ConversationMetadata[] = [];
  const earlier: ConversationMetadata[] = [];

  for (const c of conversations) {
    const date = parseISO(c.updatedAt);
    if (isToday(date)) today.push(c);
    else if (isYesterday(date)) yesterday.push(c);
    else if (isThisWeek(date, { weekStartsOn: 1 })) week.push(c);
    else earlier.push(c);
  }

  return { today, yesterday, week, earlier };
}

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
  const [searchQuery, setSearchQuery] = useState('');
  const [showFooterMenu, setShowFooterMenu] = useState(false);
  const footerMenuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    dispatch(loadConversations(currentProjectId));
  }, [dispatch, currentProjectId]);

  useEffect(() => {
    setIsSelectionMode(false);
    setSelectedIds(new Set());
  }, [currentProjectId]);

  // Close footer menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (footerMenuRef.current && !footerMenuRef.current.contains(e.target as Node)) {
        setShowFooterMenu(false);
      }
    };
    if (showFooterMenu) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showFooterMenu]);

  // ⌘K focuses search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const handleNewConversation = async () => {
    if (!selectedModel) {
      alert('Please select a model in settings first');
      return;
    }
    dispatch(clearMessages());
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

  const handleStar = async (id: string) => {
    const conversation = conversations.find((c) => c.id === id);
    if (conversation) {
      await dispatch(updateConversation({ id, starred: !conversation.starred }));
    }
  };

  const handleToggleSelectionMode = () => {
    setIsSelectionMode(!isSelectionMode);
    setSelectedIds(new Set());
    setShowFooterMenu(false);
  };

  const handleToggleSelect = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) newSelected.delete(id);
    else newSelected.add(id);
    setSelectedIds(newSelected);
  };

  const handleSelectAll = () => {
    if (selectedIds.size === conversations.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(conversations.map((c) => c.id)));
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

  const filtered = searchQuery.trim()
    ? conversations.filter((c) =>
        c.title.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : conversations;

  const groups = groupConversations(filtered);

  const renderGroup = (label: string, items: ConversationMetadata[]) => {
    if (items.length === 0) return null;
    return (
      <div key={label} className="mb-1">
        <p className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
          {label}
        </p>
        {items.map((conversation) => (
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
            onStar={handleStar}
          />
        ))}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col bg-surface border-r border-border w-60">
      {/* New Chat — ghost button, orange is reserved for Send */}
      <div className="p-3 pb-2">
        <Button onClick={handleNewConversation} variant="secondary" className="w-full" size="sm">
          <svg className="h-4 w-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Chat
        </Button>
      </div>

      {/* Search */}
      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-text-secondary">
          <svg className="h-3.5 w-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={searchRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search conversations"
            className="flex-1 bg-transparent text-xs text-text-primary placeholder-text-secondary outline-none"
          />
          <kbd className="rounded border border-border bg-surface px-1 py-0.5 text-xs text-text-secondary">⌘K</kbd>
        </div>
      </div>

      {/* Selection Mode Toolbar */}
      {isSelectionMode && (
        <div className="px-3 pb-2 flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={handleSelectAll} className="flex-1">
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
          <Button variant="ghost" size="sm" onClick={handleToggleSelectionMode}>
            Cancel
          </Button>
        </div>
      )}

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && conversations.length === 0 ? (
          <div className="flex items-center justify-center h-32">
            <div className="text-sm text-text-secondary">Loading...</div>
          </div>
        ) : error ? (
          <div className="p-4 text-center">
            <p className="text-sm text-error">{error}</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-4 text-center">
            {searchQuery ? (
              <p className="text-sm text-text-secondary">No results for "{searchQuery}"</p>
            ) : (
              <>
                <svg className="mx-auto mb-2 h-10 w-10 text-text-secondary opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                </svg>
                <p className="text-sm text-text-secondary">No conversations yet</p>
                <p className="mt-1 text-xs text-text-secondary">Click "New Chat" to start</p>
              </>
            )}
          </div>
        ) : searchQuery ? (
          // Flat list when searching
          <div className="py-1">
            {filtered.map((conversation) => (
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
                onStar={handleStar}
              />
            ))}
          </div>
        ) : (
          <div className="py-1">
            {renderGroup('Today', groups.today)}
            {renderGroup('Yesterday', groups.yesterday)}
            {renderGroup('Previous 7 days', groups.week)}
            {renderGroup('Earlier', groups.earlier)}
          </div>
        )}
      </div>

      {/* Auto-update notification */}
      <UpdateNotification />

      {/* Footer */}
      <div className="border-t border-border px-3 py-2">
        {isSelectionMode ? (
          <p className="text-xs text-text-secondary">{selectedIds.size} selected</p>
        ) : (
          <div className="flex items-center justify-between">
            <p className="text-xs text-text-secondary">
              {conversations.length} conversation{conversations.length !== 1 ? 's' : ''}
            </p>
            {conversations.length > 0 && (
              <div className="relative" ref={footerMenuRef}>
                <button
                  className="rounded p-1 text-text-secondary hover:bg-surface-hover transition-colors"
                  onClick={() => setShowFooterMenu((v) => !v)}
                  title="More options"
                >
                  <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                    <circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" />
                  </svg>
                </button>
                {showFooterMenu && (
                  <div className="absolute bottom-8 right-0 z-50 min-w-[160px] rounded-lg border border-border bg-surface shadow-lg py-1">
                    <button
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-text-primary hover:bg-surface-hover transition-colors"
                      onClick={handleToggleSelectionMode}
                    >
                      Select conversations
                    </button>
                    <button
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-text-primary hover:bg-surface-hover transition-colors"
                      onClick={() => { setIsProjectManagerOpen(true); setShowFooterMenu(false); }}
                    >
                      Manage projects
                    </button>
                    <div className="my-1 border-t border-border" />
                    <button
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-error hover:bg-surface-hover transition-colors"
                      onClick={() => { setShowDeleteAllDialog(true); setShowFooterMenu(false); }}
                    >
                      Delete all conversations
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Project Manager Modal */}
      <ProjectManager isOpen={isProjectManagerOpen} onClose={() => setIsProjectManagerOpen(false)} />

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

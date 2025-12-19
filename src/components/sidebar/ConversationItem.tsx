import React, { useState } from 'react';
import { ConversationMetadata } from '../../types/conversation.types';
import { format } from 'date-fns';

interface ConversationItemProps {
  conversation: ConversationMetadata;
  isActive: boolean;
  isSelectionMode?: boolean;
  isSelected?: boolean;
  onClick: () => void;
  onToggleSelect?: (id: string) => void;
  onRename: (id: string, newTitle: string) => void;
  onDelete: (id: string) => void;
}

export const ConversationItem = React.memo(function ConversationItem({
  conversation,
  isActive,
  isSelectionMode = false,
  isSelected = false,
  onClick,
  onToggleSelect,
  onRename,
  onDelete,
}: ConversationItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(conversation.title);
  const [showMenu, setShowMenu] = useState(false);

  const handleClick = () => {
    if (isSelectionMode && onToggleSelect) {
      onToggleSelect(conversation.id);
    } else {
      onClick();
    }
  };

  const handleRename = () => {
    if (editTitle.trim() && editTitle !== conversation.title) {
      onRename(conversation.id, editTitle.trim());
    }
    setIsEditing(false);
    setShowMenu(false);
  };

  const handleDelete = () => {
    if (window.confirm(`Delete "${conversation.title}"?`)) {
      onDelete(conversation.id);
    }
    setShowMenu(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleRename();
    } else if (e.key === 'Escape') {
      setEditTitle(conversation.title);
      setIsEditing(false);
    }
  };

  const formattedDate = format(new Date(conversation.updatedAt), 'MMM d, h:mm a');

  return (
    <div
      className={`group relative flex items-center gap-2 rounded-lg px-3 py-2 cursor-pointer transition-colors ${
        isActive
          ? 'bg-accent text-white'
          : 'hover:bg-surface-hover text-text-primary'
      }`}
      onClick={handleClick}
    >
      {/* Checkbox for selection mode */}
      {isSelectionMode && (
        <input
          type="checkbox"
          checked={isSelected}
          onChange={(e) => {
            e.stopPropagation();
            onToggleSelect?.(conversation.id);
          }}
          className="h-4 w-4 rounded border-border text-accent focus:ring-accent"
        />
      )}

      {/* Chat icon */}
      <svg
        className={`h-4 w-4 flex-shrink-0 ${
          isActive ? 'text-white' : 'text-text-secondary'
        }`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
        />
      </svg>

      <div className="flex-1 min-w-0">
        {isEditing ? (
          <input
            type="text"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onBlur={handleRename}
            onKeyDown={handleKeyDown}
            onClick={(e) => e.stopPropagation()}
            className="w-full bg-background border border-border rounded px-2 py-1 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
            autoFocus
          />
        ) : (
          <>
            <p
              className={`text-sm font-medium truncate ${
                isActive ? 'text-white' : 'text-text-primary'
              }`}
            >
              {conversation.title}
            </p>
            <p
              className={`text-xs truncate ${
                isActive ? 'text-white text-opacity-80' : 'text-text-secondary'
              }`}
            >
              {formattedDate} • {conversation.messageCount} messages
            </p>
          </>
        )}
      </div>

      {/* Menu button */}
      {!isEditing && (
        <div className="relative">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowMenu(!showMenu);
            }}
            className={`p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity ${
              isActive
                ? 'hover:bg-white hover:bg-opacity-20'
                : 'hover:bg-surface'
            }`}
          >
            <svg
              className={`h-4 w-4 ${isActive ? 'text-white' : 'text-text-secondary'}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z"
              />
            </svg>
          </button>

          {/* Dropdown menu */}
          {showMenu && (
            <>
              {/* Backdrop */}
              <div
                className="fixed inset-0 z-10"
                onClick={() => setShowMenu(false)}
              />

              {/* Menu */}
              <div className="absolute right-0 top-full mt-1 w-32 bg-surface border border-border rounded-lg shadow-lg z-20">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsEditing(true);
                    setShowMenu(false);
                  }}
                  className="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-background transition-colors rounded-t-lg"
                >
                  Rename
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete();
                  }}
                  className="w-full px-3 py-2 text-left text-sm text-error hover:bg-background transition-colors rounded-b-lg"
                >
                  Delete
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
});

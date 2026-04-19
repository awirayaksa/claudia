import React, { useState } from 'react';
import { ConversationMetadata } from '../../types/conversation.types';
import { format, isToday, isYesterday, parseISO } from 'date-fns';

function relativeTime(iso: string): string {
  const date = parseISO(iso);
  if (isToday(date)) return format(date, 'h:mm a');
  if (isYesterday(date)) return 'Yesterday';
  return format(date, 'MMM d');
}

interface ConversationItemProps {
  conversation: ConversationMetadata;
  isActive: boolean;
  isSelectionMode?: boolean;
  isSelected?: boolean;
  onClick: () => void;
  onToggleSelect?: (id: string) => void;
  onRename: (id: string, newTitle: string) => void;
  onDelete: (id: string) => void;
  onStar: (id: string) => void;
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
  onStar,
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

  const timeLabel = relativeTime(conversation.updatedAt);

  return (
    <div
      className={`group relative flex items-center gap-2 rounded-lg mx-1 px-2 py-1 cursor-pointer transition-colors ${
        isActive
          ? 'border-l-2 border-l-accent bg-[#f3ece4] text-text-primary'
          : 'border-l-2 border-l-transparent hover:bg-surface-hover text-text-primary'
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

      {/* Chat icon or star icon */}
      {conversation.starred ? (
        <svg
          className="h-4 w-4 flex-shrink-0 text-yellow-400"
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      ) : (
        <svg
          className={`h-4 w-4 flex-shrink-0 ${
            isActive ? 'text-accent' : 'text-text-secondary'
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
      )}

      <div className="flex-1 min-w-0 overflow-hidden">
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
          <div className="flex items-center gap-1 min-w-0">
            <p
              className={`flex-1 text-xs truncate ${
                isActive ? 'font-medium text-text-primary' : 'text-text-primary'
              }`}
            >
              {conversation.title}
            </p>
            <span
              className="flex-shrink-0 text-xs tabular-nums text-text-secondary"
            >
              {timeLabel}
            </span>
          </div>
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
            className="p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface"
          >
            <svg
              className="h-4 w-4 text-text-secondary"
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
              <div className="absolute right-0 top-full mt-1 w-36 bg-surface border border-border rounded-lg shadow-lg z-20">
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
                    onStar(conversation.id);
                    setShowMenu(false);
                  }}
                  className="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-background transition-colors"
                >
                  {conversation.starred ? 'Unstar' : 'Star'}
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

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DirectoryEntry } from '../../hooks/useFileMention';

interface FileMentionDropdownProps {
  isOpen: boolean;
  entries: DirectoryEntry[];
  activeIndex: number;
  anchorRef: React.RefObject<HTMLTextAreaElement>;
  onSelect: (entry: DirectoryEntry) => void;
  onClose: () => void;
}

export function FileMentionDropdown({
  isOpen,
  entries,
  activeIndex,
  anchorRef,
  onSelect,
  onClose,
}: FileMentionDropdownProps) {
  const dropdownRef = useRef<HTMLDivElement>(null);
  const activeItemRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0 });

  // Calculate position when dropdown opens
  useEffect(() => {
    if (isOpen && anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setPosition({
        top: rect.top - 8,
        left: rect.left,
        width: Math.max(rect.width, 280),
      });
    }
  }, [isOpen, anchorRef]);

  // Scroll active item into view
  useEffect(() => {
    if (isOpen && activeItemRef.current) {
      activeItemRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, isOpen]);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;

    function handleMouseDown(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    }

    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [isOpen, onClose, anchorRef]);

  if (!isOpen) return null;

  return createPortal(
    <div
      ref={dropdownRef}
      className="fixed z-50 rounded-lg border border-border bg-surface shadow-lg"
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
        width: `${position.width}px`,
        transform: 'translateY(-100%) translateY(-8px)',
      }}
    >
      <div className="max-h-60 overflow-y-auto p-1">
        {entries.length === 0 ? (
          <div className="px-3 py-2 text-sm text-text-secondary">No matches</div>
        ) : (
          entries.map((entry, idx) => {
            const isActive = idx === activeIndex;
            return (
              <button
                key={`${entry.name}-${entry.isDirectory}`}
                ref={isActive ? activeItemRef : null}
                type="button"
                className={`flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-sm transition-colors ${
                  isActive
                    ? 'bg-accent text-white'
                    : 'text-text-primary hover:bg-background'
                }`}
                onMouseDown={(e) => {
                  e.preventDefault(); // Prevent textarea blur before selection
                  onSelect(entry);
                }}
              >
                {entry.isDirectory ? (
                  // Folder icon
                  <svg className="h-4 w-4 flex-shrink-0 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                  </svg>
                ) : (
                  // File icon
                  <svg className="h-4 w-4 flex-shrink-0 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                  </svg>
                )}
                <span className="flex-1 truncate">{entry.name}</span>
                {entry.isDirectory && (
                  <span className="text-xs text-text-secondary">/</span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>,
    document.body
  );
}

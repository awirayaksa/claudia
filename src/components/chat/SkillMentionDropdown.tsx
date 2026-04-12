import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Skill } from '../../types/skill.types';

interface SkillMentionDropdownProps {
  isOpen: boolean;
  skills: Skill[];
  activeIndex: number;
  anchorRef: React.RefObject<HTMLTextAreaElement>;
  onSelect: (skill: Skill) => void;
  onClose: () => void;
}

export function SkillMentionDropdown({
  isOpen,
  skills,
  activeIndex,
  anchorRef,
  onSelect,
  onClose,
}: SkillMentionDropdownProps) {
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
        width: Math.max(rect.width, 320),
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
        {skills.length === 0 ? (
          <div className="px-3 py-2 text-sm text-text-secondary">No skills found</div>
        ) : (
          skills.map((skill, idx) => {
            const isActive = idx === activeIndex;
            return (
              <button
                key={skill.id}
                ref={isActive ? activeItemRef : null}
                type="button"
                className={`flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-sm transition-colors ${
                  isActive
                    ? 'bg-accent text-white'
                    : 'text-text-primary hover:bg-background'
                }`}
                onMouseDown={(e) => {
                  e.preventDefault(); // Prevent textarea blur before selection
                  onSelect(skill);
                }}
              >
                {/* Slash icon */}
                <svg
                  className={`h-4 w-4 flex-shrink-0 ${isActive ? 'text-white' : 'text-accent'}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17 3L7 21"
                  />
                </svg>
                {/* Command name */}
                <span className={`font-mono font-medium ${isActive ? 'text-white' : 'text-text-primary'}`}>
                  {skill.id}
                </span>
                {/* Description */}
                <span className={`flex-1 truncate text-xs ${isActive ? 'text-white opacity-80' : 'text-text-secondary'}`}>
                  {skill.description}
                </span>
                {/* Built-in badge */}
                {skill.builtin && (
                  <span
                    className={`text-xs px-1 rounded ${
                      isActive ? 'text-white opacity-70' : 'text-text-secondary'
                    }`}
                  >
                    built-in
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
      <div className="border-t border-border px-3 py-1.5 text-xs text-text-secondary">
        Tab/Enter to select • Esc to close
      </div>
    </div>,
    document.body
  );
}

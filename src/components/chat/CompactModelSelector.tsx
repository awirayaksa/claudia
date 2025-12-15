import React, { useState, useRef, useEffect } from 'react';
import { abbreviateModelName, truncateModelName } from '../../utils/modelHelpers';

interface CompactModelSelectorProps {
  value: string;
  models: string[];
  onChange: (model: string) => void;
  disabled?: boolean;
}

export function CompactModelSelector({
  value,
  models,
  onChange,
  disabled = false,
}: CompactModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const selectedItemRef = useRef<HTMLButtonElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  // Auto-scroll to selected item when dropdown opens
  useEffect(() => {
    if (isOpen && selectedItemRef.current && dropdownRef.current) {
      // Small delay to ensure the dropdown is fully rendered
      setTimeout(() => {
        selectedItemRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
      }, 10);
    }
  }, [isOpen]);

  // Handle keyboard navigation
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      setIsOpen(false);
      buttonRef.current?.focus();
    }
  };

  const handleSelectModel = (model: string) => {
    onChange(model);
    setIsOpen(false);
    buttonRef.current?.focus();
  };

  const isModelAvailable = models.includes(value);
  const displayName = abbreviateModelName(value);
  const truncatedName = truncateModelName(displayName, 20);

  // Sort models alphabetically
  const sortedModels = [...models].sort((a, b) => a.localeCompare(b));

  return (
    <div className="relative" onKeyDown={handleKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={`flex items-center gap-1.5 rounded border border-border bg-background px-3 py-2 text-sm text-text-primary transition-colors hover:border-accent focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-50 ${!isModelAvailable ? 'border-warning text-warning' : ''
          }`}
        style={{ minWidth: '140px', maxWidth: '180px' }}
        title={isModelAvailable ? displayName : `${displayName} (unavailable)`}
        aria-label="Select model"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className="flex-1 truncate text-left">{truncatedName}</span>
        <svg
          className={`h-4 w-4 flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="absolute bottom-full left-0 mb-2 w-64 rounded-lg border border-border bg-surface shadow-lg"
          role="listbox"
          aria-label="Available models"
        >
          <div className="max-h-80 overflow-y-auto p-2">
            {sortedModels.length === 0 ? (
              <div className="px-3 py-2 text-sm text-text-secondary">No models available</div>
            ) : (
              sortedModels.map((model) => {
                const isSelected = model === value;
                const modelDisplayName = abbreviateModelName(model);

                return (
                  <button
                    key={model}
                    ref={isSelected ? selectedItemRef : null}
                    type="button"
                    onClick={() => handleSelectModel(model)}
                    className={`flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm transition-colors hover:bg-background ${isSelected ? 'bg-background text-accent' : 'text-text-primary'
                      }`}
                    role="option"
                    aria-selected={isSelected}
                  >
                    <span className="flex-1 truncate" title={model}>
                      {modelDisplayName}
                    </span>
                    {isSelected && (
                      <svg
                        className="h-4 w-4 flex-shrink-0 text-accent"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

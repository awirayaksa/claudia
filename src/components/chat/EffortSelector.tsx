import React, { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  ReasoningEffort,
  coerceEffort,
  formatEffort,
  getEffortLevels,
} from '../../utils/effort-utils';

interface EffortSelectorProps {
  /** Session-level effort, or null to follow the Preferences default. */
  value: ReasoningEffort | null;
  onChange: (effort: ReasoningEffort | null) => void;
  /** Effort inherited from Preferences, shown when no session override is set. */
  fallback?: ReasoningEffort | null;
  /**
   * Effort detected in the text currently being typed (`--effort high ...`).
   * It wins for the next message only, so the button reflects it.
   */
  pending?: ReasoningEffort | null;
  /** Active model — decides which tiers are on offer. */
  model?: string;
  disabled?: boolean;
}

const EFFORT_HINTS: Record<ReasoningEffort, string> = {
  minimal: 'Answer fast, barely think',
  low: 'Light reasoning',
  medium: 'Balanced reasoning',
  high: 'Think hard before answering',
  xhigh: 'Think as hard as it can',
};

export function EffortSelector({
  value,
  onChange,
  fallback = null,
  pending,
  model,
  disabled = false,
}: EffortSelectorProps) {
  const levels = useMemo(() => getEffortLevels(model), [model]);
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

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

  // Calculate dropdown position when it opens
  useEffect(() => {
    if (isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownPosition({ top: rect.top - 8, left: rect.left });
    }
  }, [isOpen]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      setIsOpen(false);
      buttonRef.current?.focus();
    }
  };

  const handleSelect = (effort: ReasoningEffort | null) => {
    onChange(effort);
    setIsOpen(false);
    buttonRef.current?.focus();
  };

  // `pending` is undefined when the prompt has no directive; null means the
  // prompt explicitly asked for the provider default.
  const requested = pending !== undefined ? pending : value ?? fallback;
  // What actually goes on the wire — the model may not offer the requested tier.
  const active = coerceEffort(requested ?? undefined, model) ?? null;
  const isOneShot = pending !== undefined;
  const wasCoerced = requested != null && active !== requested;
  const label = active ? formatEffort(active) : 'Auto';

  const source = isOneShot
    ? `Effort for this message: ${label} (from the prompt)`
    : `Reasoning effort: ${label}${!value && fallback ? ' (from Preferences)' : ''}`;
  const title = wasCoerced
    ? `${source} — ${model} has no "${formatEffort(requested!)}" tier, using ${label}`
    : source;

  return (
    <div className="relative" onKeyDown={handleKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={`flex items-center gap-1.5 rounded border px-3 py-2 text-sm transition-colors hover:border-accent focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-50 ${
          active ? 'border-accent/60 bg-background text-accent' : 'border-border bg-background text-text-secondary'
        }`}
        title={title}
        aria-label="Select reasoning effort"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <svg className="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M13 10V3L4 14h7v7l9-11h-7z"
          />
        </svg>
        <span className="whitespace-nowrap">{label}</span>
        {isOneShot && <span className="text-xs opacity-70">1×</span>}
      </button>

      {isOpen &&
        createPortal(
          <div
            ref={dropdownRef}
            className="fixed z-50 w-60 rounded-lg border border-border bg-surface shadow-lg"
            style={{
              top: `${dropdownPosition.top}px`,
              left: `${dropdownPosition.left}px`,
              transform: 'translateY(-100%)',
            }}
            role="listbox"
            aria-label="Reasoning effort"
          >
            <div className="p-2">
              <button
                type="button"
                onClick={() => handleSelect(null)}
                className={`flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm transition-colors hover:bg-background ${
                  value === null ? 'bg-background text-accent' : 'text-text-primary'
                }`}
                role="option"
                aria-selected={value === null}
              >
                <span>
                  Auto
                  <span className="ml-2 text-xs text-text-secondary">
                    {fallback
                      ? `Preferences: ${formatEffort(coerceEffort(fallback, model)!)}`
                      : 'provider default'}
                  </span>
                </span>
              </button>

              {levels.map((level) => {
                // A session value the model can't take still highlights the tier
                // it gets mapped onto, so the menu matches the button.
                const isSelected = value === level || (value !== null && active === level);
                return (
                  <button
                    key={level}
                    type="button"
                    onClick={() => handleSelect(level)}
                    className={`flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm transition-colors hover:bg-background ${
                      isSelected ? 'bg-background text-accent' : 'text-text-primary'
                    }`}
                    role="option"
                    aria-selected={isSelected}
                    title={EFFORT_HINTS[level]}
                  >
                    <span>
                      {formatEffort(level)}
                      <span className="ml-2 text-xs text-text-secondary">{EFFORT_HINTS[level]}</span>
                    </span>
                  </button>
                );
              })}

              <p className="mt-1 border-t border-border px-3 pt-2 text-xs text-text-secondary">
                Tip: type <code className="text-text-primary">--effort high</code> in a message to
                use it just once.
              </p>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

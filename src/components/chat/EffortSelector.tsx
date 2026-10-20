import React, { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  ReasoningEffort,
  coerceEffort,
  getEffortLevels,
} from '../../utils/effort-utils';
import { t, useT } from '../../i18n';

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

/** Each tier's name and hint, in the current language. */
const EFFORT_TEXT: Record<ReasoningEffort, () => { name: string; hint: string }> = {
  minimal: () => ({ name: t('effort.levels.minimal', 'Minimal'), hint: t('effort.hints.minimal', 'Answer fast, barely think') }),
  low: () => ({ name: t('effort.levels.low', 'Low'), hint: t('effort.hints.low', 'Light reasoning') }),
  medium: () => ({ name: t('effort.levels.medium', 'Medium'), hint: t('effort.hints.medium', 'Balanced reasoning') }),
  high: () => ({ name: t('effort.levels.high', 'High'), hint: t('effort.hints.high', 'Think hard before answering') }),
  xhigh: () => ({ name: t('effort.levels.xhigh', 'X-High'), hint: t('effort.hints.xhigh', 'Think as hard as it can') }),
};

/** The tier's name ("X-High"), translated. */
export const effortLabel = (level: ReasoningEffort) => EFFORT_TEXT[level]().name;
const effortHint = (level: ReasoningEffort) => EFFORT_TEXT[level]().hint;

export function EffortSelector({
  value,
  onChange,
  fallback = null,
  pending,
  model,
  disabled = false,
}: EffortSelectorProps) {
  const t = useT();
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
  const label = active ? effortLabel(active) : t('effort.auto', 'Auto');

  const source = isOneShot
    ? t('effort.oneShot', 'Effort for this message: {{level}} (from the prompt)', { level: label })
    : !value && fallback
      ? t('effort.fromPreferences', 'Reasoning effort: {{level}} (from Preferences)', { level: label })
      : t('effort.current', 'Reasoning effort: {{level}}', { level: label });
  const title = wasCoerced
    ? t('effort.coerced', '{{source}} — {{model}} has no "{{requested}}" tier, using {{level}}', {
        source,
        model: model ?? '',
        requested: effortLabel(requested!),
        level: label,
      })
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
        aria-label={t('effort.select', 'Select reasoning effort')}
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
            aria-label={t('effort.label', 'Reasoning effort')}
          >
            <div className="p-2">
              <button
                type="button"
                onClick={() => handleSelect(null)}
                className={`flex w-full items-center justify-between rounded px-3 py-2 text-start text-sm transition-colors hover:bg-background ${
                  value === null ? 'bg-background text-accent' : 'text-text-primary'
                }`}
                role="option"
                aria-selected={value === null}
              >
                <span>
                  {t('effort.auto', 'Auto')}
                  <span className="ms-2 text-xs text-text-secondary">
                    {fallback
                      ? t('effort.preferences', 'Preferences: {{level}}', { level: effortLabel(coerceEffort(fallback, model)!) })
                      : t('effort.providerDefault', 'provider default')}
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
                    className={`flex w-full items-center justify-between rounded px-3 py-2 text-start text-sm transition-colors hover:bg-background ${
                      isSelected ? 'bg-background text-accent' : 'text-text-primary'
                    }`}
                    role="option"
                    aria-selected={isSelected}
                    title={effortHint(level)}
                  >
                    <span>
                      {effortLabel(level)}
                      <span className="ms-2 text-xs text-text-secondary">{effortHint(level)}</span>
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

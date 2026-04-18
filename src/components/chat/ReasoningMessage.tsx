import { useState } from 'react';

interface ReasoningMessageProps {
  reasoning: string;
  isStreaming?: boolean;
}

function estimateDuration(text: string): string {
  if (!text) return 'a moment';
  const words = text.trim().split(/\s+/).length;
  const secs = Math.max(1, Math.round(words / 40));
  return secs === 1 ? '1 second' : `${secs} seconds`;
}

export function ReasoningMessage({ reasoning, isStreaming = false }: ReasoningMessageProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!reasoning) return null;

  const label = isStreaming ? 'Thinking…' : `Thought for ${estimateDuration(reasoning)}`;

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-background max-w-[360px]">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center justify-between px-3 py-2 text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-text-secondary text-xs">✦</span>
          <span className="text-sm text-text-primary">{label}</span>
          {isStreaming && (
            <svg className="h-3 w-3 animate-spin text-text-secondary" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          )}
        </div>
        <span className="text-xs text-text-secondary">{isExpanded ? '▾' : '▸'}</span>
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="border-t border-border bg-surface px-4 py-3 pl-7 text-xs leading-relaxed text-text-secondary">
          <pre className="overflow-x-auto whitespace-pre-wrap font-sans">{reasoning}</pre>
        </div>
      )}
    </div>
  );
}

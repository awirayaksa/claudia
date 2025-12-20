import { useState } from 'react';

interface ReasoningMessageProps {
  reasoning: string;
  isStreaming?: boolean;
}

export function ReasoningMessage({ reasoning, isStreaming = false }: ReasoningMessageProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!reasoning) return null;

  return (
    <div className="my-2 rounded-lg border border-border bg-blue-500 bg-opacity-10 p-3">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-lg">💭</span>
          <span className="font-mono text-sm font-medium text-text-primary">
            Reasoning
          </span>
          {isStreaming && (
            <span className="flex items-center gap-1 text-xs text-blue-500">
              <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="none"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <span>Thinking...</span>
            </span>
          )}
        </div>
        <span className="ml-4 text-text-secondary">
          {isExpanded ? '▼' : '▶'}
        </span>
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="mt-3 w-full border-t border-border pt-3">
          <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-surface p-3 text-xs text-text-primary">
            {reasoning}
          </pre>
        </div>
      )}
    </div>
  );
}

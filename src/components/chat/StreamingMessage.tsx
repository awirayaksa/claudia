import { format } from 'date-fns';
import { MarkdownRenderer } from './MarkdownRenderer';
import { useThrottledValue } from '../../hooks/useThrottledValue';

interface StreamingMessageProps {
  content: string;
  onAbort?: () => void;
}

export function StreamingMessage({ content, onAbort }: StreamingMessageProps) {
  const formattedTime = format(new Date(), 'h:mm a');

  // Throttle markdown parsing to every 100ms for performance
  const throttledContent = useThrottledValue(content, 100);

  return (
    <div className="flex justify-start py-2">
      <div className="max-w-[70%] rounded-lg border border-border bg-surface px-4 py-3 text-text-primary">
        {/* Message header */}
        <div className="mb-1 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-text-primary">
              Claudia
            </span>
            <span className="text-xs text-text-secondary">{formattedTime}</span>
          </div>

          {/* Abort button */}
          {onAbort && (
            <button
              onClick={onAbort}
              className="rounded p-1 text-xs text-text-secondary hover:bg-background hover:text-error"
              title="Stop generating"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          )}
        </div>

        {/* Streaming content with live markdown rendering */}
        <div className="text-sm text-text-primary">
          <MarkdownRenderer content={throttledContent} isUser={false} />
          {/* Blinking cursor */}
          <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-accent"></span>
        </div>

        {/* Streaming indicator */}
        <div className="mt-2 flex items-center gap-2 text-xs text-text-secondary">
          <div className="flex gap-1">
            <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.3s]"></div>
            <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.15s]"></div>
            <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent"></div>
          </div>
          <span>Generating...</span>
        </div>
      </div>
    </div>
  );
}

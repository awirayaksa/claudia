import { format } from 'date-fns';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ReasoningMessage } from './ReasoningMessage';
import { useThrottledValue } from '../../hooks/useThrottledValue';
import { useAppSelector } from '../../store';

interface StreamingMessageProps {
  content: string;
  reasoning?: string;
  onAbort?: () => void;
}

export function StreamingMessage({ content, reasoning, onAbort }: StreamingMessageProps) {
  const formattedTime = format(new Date(), 'h:mm a');

  const { showReasoning } = useAppSelector((state) => state.settings.preferences);

  // Throttle markdown parsing to every 100ms for performance
  const throttledContent = useThrottledValue(content, 100);
  const throttledReasoning = useThrottledValue(reasoning || '', 100);

  return (
    <div className="py-4">
      {/* Avatar chip + name */}
      <div className="mb-2 flex items-center gap-2">
        <div className="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-[5px] bg-accent text-[11px] font-bold text-white">
          C
        </div>
        <span className="text-sm font-semibold text-text-primary">Claudia</span>
        <span className="text-xs text-text-secondary">{formattedTime}</span>
        {/* Abort button */}
        {onAbort && (
          <button
            onClick={onAbort}
            className="ml-2 rounded px-2 py-0.5 text-xs text-text-secondary hover:bg-surface hover:text-error transition-colors"
            title="Stop generating"
          >
            ✕ Stop
          </button>
        )}
      </div>

      <div className="pl-[30px]">
        {/* Streaming reasoning */}
        {showReasoning && throttledReasoning && (
          <ReasoningMessage reasoning={throttledReasoning} isStreaming={true} />
        )}

        {/* Streaming content */}
        <div className="text-sm text-text-primary">
          <MarkdownRenderer content={throttledContent} isUser={false} />
          <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-accent align-middle"></span>
        </div>

        {/* Generating indicator */}
        <div className="mt-2 flex items-center gap-2 text-xs text-text-secondary">
          <div className="flex gap-1">
            <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.3s]"></div>
            <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.15s]"></div>
            <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent"></div>
          </div>
        </div>
      </div>
    </div>
  );
}

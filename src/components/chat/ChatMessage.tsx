import React, { useState } from 'react';
import { Message, Attachment } from '../../types/message.types';
import { MessageAttachment } from './MessageAttachment';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ToolCallMessage } from './ToolCallMessage';
import { ReasoningMessage } from './ReasoningMessage';
import { UIResourceDisplay } from './UIResourceDisplay';
import { format } from 'date-fns';
import { useAppSelector } from '../../store';

interface ChatMessageProps {
  message: Message;
  onEdit?: (messageId: string, content: string, attachments?: Attachment[]) => void;
  disabled?: boolean;
}

export const ChatMessage = React.memo(function ChatMessage({ message, onEdit, disabled }: ChatMessageProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isTool = message.role === 'tool';
  const [copied, setCopied] = useState(false);

  const { showReasoning, showStatistics } = useAppSelector((state) => state.settings.preferences);

  const formattedTime = format(new Date(message.timestamp), 'h:mm a');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text:', err);
    }
  };

  if (isSystem) {
    return (
      <div className="flex justify-center py-2">
        <div className="rounded bg-surface px-3 py-1 text-xs text-text-secondary">
          {message.content}
        </div>
      </div>
    );
  }

  // Tool result messages are not displayed directly (shown in ToolCallMessage)
  if (isTool) {
    return null;
  }

  if (isUser) {
    return (
      <div className="group flex justify-end py-2">
        <div className="max-w-[65%]">
          {/* Muted beige bubble — already-sent context, not primary focus */}
          <div className="rounded-[14px] bg-[#f1ede6] px-[14px] py-[10px] text-sm leading-relaxed text-[#2e2b27]">
            <div className="whitespace-pre-wrap">{message.content}</div>
            {/* Attachments */}
            {message.attachments && message.attachments.length > 0 && (
              <div className="mt-2 space-y-2">
                {message.attachments.map((attachment) => (
                  <MessageAttachment key={attachment.id} attachment={attachment} />
                ))}
              </div>
            )}
          </div>
          {/* Hover actions */}
          <div className="mt-1 flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              onClick={handleCopy}
              className="rounded px-2 py-1 text-xs text-text-secondary hover:bg-surface hover:text-text-primary transition-colors"
              title={copied ? 'Copied!' : 'Copy'}
            >
              {copied ? '✓' : 'Copy'}
            </button>
            <button
              onClick={() => onEdit?.(message.id, message.content, message.attachments)}
              disabled={disabled}
              className="rounded px-2 py-1 text-xs text-text-secondary hover:bg-surface hover:text-text-primary transition-colors disabled:cursor-not-allowed disabled:opacity-30"
              title="Edit message"
            >
              Edit
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Assistant message — bubble-less transcript */}
      <div className="group py-4">
        {/* Avatar chip + name + inline stats */}
        <div className="mb-2 flex items-center gap-2 flex-wrap">
          <div className="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-[5px] bg-accent text-[11px] font-bold text-white">
            C
          </div>
          <span className="text-sm font-semibold text-text-primary">Claudia</span>
          <span className="text-xs text-text-secondary">{formattedTime}</span>
          {showStatistics && message.usage?.total_tokens != null && (
            <>
              <span className="text-xs text-text-secondary">·</span>
              <span className="text-xs text-text-secondary">{message.usage.total_tokens.toLocaleString()} tokens</span>
            </>
          )}
          {showStatistics && message.usage?.cost != null && (
            <>
              <span className="text-xs text-text-secondary">·</span>
              <span className="text-xs text-text-secondary">${message.usage.cost.toFixed(6)}</span>
            </>
          )}
        </div>

        <div className="pl-[30px]">
          {/* Reasoning Block */}
          {showReasoning && message.reasoning && (
            <ReasoningMessage reasoning={message.reasoning} />
          )}

          {/* Message content */}
          <div className="text-[14px] leading-[1.7] text-text-primary">
            <MarkdownRenderer content={message.content} isUser={false} />
          </div>

          {/* Error display */}
          {message.error && (
            <div className="mt-2 rounded bg-error bg-opacity-10 px-2 py-1 text-xs text-error">
              {message.error}
            </div>
          )}

          {/* Attachments */}
          {message.attachments && message.attachments.length > 0 && (
            <div className="mt-2 space-y-2">
              {message.attachments.map((attachment) => (
                <MessageAttachment key={attachment.id} attachment={attachment} />
              ))}
            </div>
          )}

          {/* Tool Calls */}
          {message.toolCalls && message.toolCalls.length > 0 && (
            <div className="mt-2 space-y-2">
              {message.toolCalls.map((toolCall) => {
                const result = message.toolResults?.find(
                  (r) => r.tool_call_id === toolCall.id
                );
                return (
                  <ToolCallMessage
                    key={toolCall.id}
                    toolCall={toolCall}
                    result={result}
                    hideUIResource={true}
                  />
                );
              })}
            </div>
          )}

          {/* Action row — persistent */}
          <div className="mt-2 flex gap-1">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-text-secondary hover:bg-surface hover:text-text-primary transition-colors"
              title={copied ? 'Copied!' : 'Copy'}
            >
              {copied ? '✓ Copied' : '⎘ Copy'}
            </button>
            <button disabled className="rounded px-2 py-1 text-xs text-text-secondary opacity-50 cursor-not-allowed">
              ↻ Retry
            </button>
            <button disabled className="rounded px-2 py-1 text-xs text-text-secondary opacity-50 cursor-not-allowed">
              ↗ Branch
            </button>
            <button disabled className="rounded px-2 py-1 text-xs text-text-secondary opacity-50 cursor-not-allowed">👍</button>
            <button disabled className="rounded px-2 py-1 text-xs text-text-secondary opacity-50 cursor-not-allowed">👎</button>
          </div>
        </div>
      </div>

      {/* UI Resources Row - Full width, separate row */}
      {message.toolResults && message.toolResults.some(r => r.hasUI && r.uiResource) && (
        <div className="w-full py-2 space-y-2">
          {message.toolResults
            .filter(r => r.hasUI && r.uiResource)
            .map((result) => (
              <UIResourceDisplay
                key={result.tool_call_id}
                resource={result.uiResource!}
                toolCallId={result.tool_call_id}
                toolName={result.name}
              />
            ))}
        </div>
      )}
    </>
  );
});

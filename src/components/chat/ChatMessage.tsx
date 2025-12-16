import React, { useState } from 'react';
import { Message, Attachment } from '../../types/message.types';
import { MessageAttachment } from './MessageAttachment';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ToolCallMessage } from './ToolCallMessage';
import { UIResourceDisplay } from './UIResourceDisplay';
import { format } from 'date-fns';

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

  return (
    <>
      {/* Message Row */}
      <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} py-2`}>
        <div
          className={`max-w-[70%] rounded-lg px-4 py-3 ${
            isUser
              ? 'bg-accent text-white'
              : 'bg-surface text-text-primary border border-border'
          }`}
        >
          {/* Message header */}
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className={`text-xs font-semibold ${isUser ? 'text-white' : 'text-text-primary'}`}>
                {isUser ? 'You' : 'Claudia'}
              </span>
              <span className={`text-xs ${isUser ? 'text-white text-opacity-80' : 'text-text-secondary'}`}>
                {formattedTime}
              </span>
            </div>
            <div className="flex gap-1">
              {/* Copy button - available for both user and assistant */}
              <button
                onClick={handleCopy}
                className={`group relative flex items-center justify-center opacity-70 hover:opacity-100 transition-opacity ${
                  isUser ? 'text-white' : 'text-text-secondary hover:text-text-primary'
                }`}
                title={copied ? 'Copied!' : 'Copy message'}
              >
                {copied ? (
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
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                ) : (
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
                      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                    />
                  </svg>
                )}
              </button>

              {/* Edit button - only for user messages */}
              {isUser && (
                <button
                  onClick={() => onEdit?.(message.id, message.content, message.attachments)}
                  disabled={disabled}
                  className="group relative flex items-center justify-center opacity-70 hover:opacity-100 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed text-white"
                  title="Edit message"
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
                      d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                    />
                  </svg>
                </button>
              )}
            </div>
          </div>

          {/* Message content */}
          <div className={`text-sm ${isUser ? 'text-white' : 'text-text-primary'}`}>
            {isUser ? (
              <div className="whitespace-pre-wrap selection:bg-white selection:text-accent">{message.content}</div>
            ) : (
              <MarkdownRenderer content={message.content} isUser={isUser} />
            )}
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
                // Find the corresponding tool result
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

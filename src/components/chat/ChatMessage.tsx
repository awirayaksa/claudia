import React from 'react';
import { Message } from '../../types/message.types';
import { MessageAttachment } from './MessageAttachment';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ToolCallMessage } from './ToolCallMessage';
import { format } from 'date-fns';

interface ChatMessageProps {
  message: Message;
}

export const ChatMessage = React.memo(function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isTool = message.role === 'tool';

  const formattedTime = format(new Date(message.timestamp), 'h:mm a');

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
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} py-2`}>
      <div
        className={`max-w-[70%] rounded-lg px-4 py-3 ${
          isUser
            ? 'bg-accent text-white'
            : 'bg-surface text-text-primary border border-border'
        }`}
      >
        {/* Message header */}
        <div className="mb-1 flex items-center gap-2">
          <span className={`text-xs font-semibold ${isUser ? 'text-white' : 'text-text-primary'}`}>
            {isUser ? 'You' : 'Claudia'}
          </span>
          <span className={`text-xs ${isUser ? 'text-white text-opacity-80' : 'text-text-secondary'}`}>
            {formattedTime}
          </span>
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
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});

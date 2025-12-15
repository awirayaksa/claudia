import { useState, useEffect } from 'react';
import { ToolCall, ToolResult } from '../../types/message.types';
import { ToolIntegrationService } from '../../services/mcp/tool-integration.service';
import { UIResourceDisplay } from './UIResourceDisplay';

interface ToolCallMessageProps {
  toolCall: ToolCall;
  result?: ToolResult;
  hideUIResource?: boolean;
}

export function ToolCallMessage({ toolCall, result, hideUIResource = false }: ToolCallMessageProps) {
  // Auto-expand if there's a UI resource (but not when hiding UI resource)
  const [isExpanded, setIsExpanded] = useState(false);

  // Auto-expand when UI resource is detected (only if not hiding it)
  useEffect(() => {
    if (result?.hasUI && !hideUIResource) {
      setIsExpanded(true);
    }
  }, [result?.hasUI, hideUIResource]);

  // Parse tool arguments
  let parsedArgs: any = {};
  try {
    parsedArgs = JSON.parse(toolCall.function.arguments);
  } catch (error) {
    parsedArgs = { error: 'Failed to parse arguments' };
  }

  // Determine status
  const status = !result ? 'pending' : result.isError ? 'error' : 'success';

  // Status colors and icons
  const statusConfig = {
    pending: {
      color: 'text-blue-500',
      bg: 'bg-blue-500 bg-opacity-10',
      icon: (
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
      ),
      label: 'Executing...',
    },
    success: {
      color: 'text-green-500',
      bg: 'bg-green-500 bg-opacity-10',
      icon: '✓',
      label: 'Success',
    },
    error: {
      color: 'text-error',
      bg: 'bg-error bg-opacity-10',
      icon: '✗',
      label: 'Error',
    },
  }[status];

  return (
    <div
      className={`my-2 rounded-lg border ${
        status === 'error' ? 'border-error' : 'border-border'
      } ${statusConfig.bg} p-3`}
    >
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-lg">🔧</span>
          <span className="font-mono text-sm font-medium text-text-primary">
            {toolCall.function.name}
          </span>
          <span className={`flex items-center gap-1 text-xs ${statusConfig.color}`}>
            {typeof statusConfig.icon === 'string' ? (
              <span>{statusConfig.icon}</span>
            ) : (
              statusConfig.icon
            )}
            <span>{statusConfig.label}</span>
          </span>
        </div>
        <span className="ml-4 text-text-secondary">
          {isExpanded ? '▼' : '▶'}
        </span>
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="mt-3 w-full space-y-3 border-t border-border pt-3">
          {/* Arguments */}
          <div>
            <div className="mb-1 text-xs font-medium text-text-secondary">Arguments:</div>
            <pre className="overflow-x-auto rounded bg-surface p-2 text-xs text-text-primary">
              {JSON.stringify(parsedArgs, null, 2)}
            </pre>
          </div>

          {/* Result */}
          {result && (
            <div>
              <div className="mb-1 text-xs font-medium text-text-secondary">
                {result.isError ? 'Error:' : 'Result:'}
              </div>

              {/* Render UI resource OR text result */}
              {result.hasUI && result.uiResource && !hideUIResource ? (
                <UIResourceDisplay
                  resource={result.uiResource}
                  toolCallId={result.tool_call_id}
                  toolName={result.name}
                />
              ) : (
                <pre
                  className={`overflow-x-auto rounded p-2 text-xs ${
                    result.isError
                      ? 'bg-error bg-opacity-10 text-error'
                      : 'bg-surface text-text-primary'
                  }`}
                >
                  {ToolIntegrationService.formatToolResultForDisplay(result)}
                </pre>
              )}
            </div>
          )}

          {/* Tool call ID (for debugging) */}
          <div className="text-xs text-text-secondary">
            ID: {toolCall.id}
          </div>
        </div>
      )}
    </div>
  );
}

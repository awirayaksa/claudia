import React from 'react';
import { useAppDispatch } from '../../store';
import { startMCPServer, stopMCPServer } from '../../store/slices/mcpSlice';
import { clearMessages } from '../../store/slices/chatSlice';
import { MCPServerConfig, MCPServerState, MCPServerStatus } from '../../types/mcp.types';

interface MCPServerBadgeProps {
  config: MCPServerConfig;
  state?: MCPServerState;
  status: MCPServerStatus;
  toolCount: number;
  disabled?: boolean;
}

const MCPServerBadge: React.FC<MCPServerBadgeProps> = ({
  config,
  state,
  status,
  toolCount,
  disabled = false,
}) => {
  const dispatch = useAppDispatch();

  // Status color mapping
  const statusColors: Record<MCPServerStatus, string> = {
    stopped: 'text-gray-400',
    starting: 'text-blue-500 animate-pulse',
    initializing: 'text-blue-500 animate-pulse',
    ready: 'text-green-500',
    error: 'text-red-500',
    stopping: 'text-gray-400',
  };

  // Status symbols
  const statusSymbols: Record<MCPServerStatus, string> = {
    stopped: '○',
    starting: '◐',
    initializing: '◑',
    ready: '●',
    error: '⚠',
    stopping: '○',
  };

  // Determine if toggle should be disabled
  const isTransitioning = status === 'starting' || status === 'stopping' || status === 'initializing';
  const isToggleDisabled = disabled || isTransitioning;

  // Handle toggle click
  const handleToggle = () => {
    if (isToggleDisabled) return;

    if (status === 'ready') {
      // Server is running, stop it
      dispatch(stopMCPServer(config.id));
      // Clear chat to refresh context without the tools
      dispatch(clearMessages());
    } else if (status === 'stopped' || status === 'error') {
      // Server is stopped or errored, start it
      dispatch(startMCPServer(config.id));
      // Clear chat to refresh context with the new tools
      dispatch(clearMessages());
    }
  };

  // Truncate server name if too long
  const displayName = config.name.length > 20 ? `${config.name.slice(0, 20)}...` : config.name;

  return (
    <div
      className="flex items-center gap-2 rounded border border-border bg-background px-3 py-2"
      title={state?.error || undefined}
    >
      {/* Status indicator */}
      <span className={`text-base ${statusColors[status]}`}>
        {statusSymbols[status]}
      </span>

      {/* Server name */}
      <span className="text-sm text-text-primary max-w-[150px] truncate">
        {displayName}
      </span>

      {/* Tool count (only show if server is ready and has tools) */}
      {status === 'ready' && toolCount > 0 && (
        <span className="text-xs text-text-secondary">
          ({toolCount})
        </span>
      )}

      {/* Error message (truncated) */}
      {status === 'error' && state?.error && (
        <span className="text-xs text-error max-w-[100px] truncate" title={state.error}>
          {state.error.slice(0, 20)}...
        </span>
      )}

      {/* Toggle button */}
      <button
        onClick={handleToggle}
        disabled={isToggleDisabled}
        aria-label={status === 'ready' ? `Stop ${config.name}` : `Start ${config.name}`}
        className="ml-1 p-1 text-text-secondary hover:text-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isTransitioning ? (
          // Spinner during state transitions
          <svg
            className="h-4 w-4 animate-spin"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        ) : (
          // Power icon
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 10V3L4 14h7v7l9-11h-7z"
            />
          </svg>
        )}
      </button>
    </div>
  );
};

export default MCPServerBadge;

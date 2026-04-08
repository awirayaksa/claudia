import React, { useEffect, useRef, useState } from 'react';
import { useAppSelector } from '../../store';
import { selectEnabledMCPServers } from '../../store/slices/mcpSlice';
import MCPServerBadge from './MCPServerBadge';

interface MCPServerBadgesProps {
  disabled?: boolean;
}

// Approximate height of 2 rows of badges (badge height ~36px + gap 8px + 1px buffer)
const TWO_ROW_HEIGHT = 81;

/**
 * Container component that displays a horizontal list of enabled MCP server badges.
 * Auto-collapses to 2 rows when there are many servers, with an expand/collapse toggle.
 */
const MCPServerBadges: React.FC<MCPServerBadgesProps> = ({ disabled = false }) => {
  const enabledServers = useAppSelector(selectEnabledMCPServers);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Temporarily remove max-height to measure full height
    el.style.maxHeight = 'none';
    const fullHeight = el.scrollHeight;
    el.style.maxHeight = '';

    setIsOverflowing(fullHeight > TWO_ROW_HEIGHT);
  }, [enabledServers]);

  if (enabledServers.length === 0) return null;

  const showToggle = isOverflowing;
  const isCollapsed = showToggle && !isExpanded;

  return (
    <div className="mb-3">
      <div
        ref={containerRef}
        className="flex flex-wrap gap-2 overflow-hidden transition-all duration-200"
        style={isCollapsed ? { maxHeight: `${TWO_ROW_HEIGHT}px` } : undefined}
      >
        {enabledServers.map((server) => (
          <MCPServerBadge
            key={server.config.id}
            config={server.config}
            state={server.state}
            status={server.status}
            toolCount={server.toolCount}
            disabled={disabled}
          />
        ))}
      </div>

      {showToggle && (
        <button
          onClick={() => setIsExpanded((prev) => !prev)}
          className="mt-1 flex items-center gap-1 text-xs text-text-secondary hover:text-accent transition-colors"
        >
          <svg
            className={`h-3 w-3 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
          {isExpanded
            ? 'Show less'
            : `Show all (${enabledServers.length})`}
        </button>
      )}
    </div>
  );
};

export default MCPServerBadges;

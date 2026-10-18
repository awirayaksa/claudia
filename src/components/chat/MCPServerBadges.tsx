import React, { useState } from 'react';
import { useAppSelector } from '../../store';
import { selectStartedMCPServers } from '../../store/slices/mcpSlice';
import MCPServerBadge from './MCPServerBadge';
import { useT } from '../../i18n';

interface MCPServerBadgesProps {
  disabled?: boolean;
  /** Called after the user starts or stops a server from its badge. */
  onServerToggled?: (serverId: string, running: boolean) => void;
}

/**
 * Container component that displays a horizontal list of started MCP server badges.
 * Always shows an expand/collapse toggle. Collapse fully hides the badges;
 * expand shows all of them.
 */
const MCPServerBadges: React.FC<MCPServerBadgesProps> = ({ disabled = false, onServerToggled }) => {
  const t = useT();
  const enabledServers = useAppSelector(selectStartedMCPServers);
  const [isExpanded, setIsExpanded] = useState(true);

  if (enabledServers.length === 0) return null;

  return (
    <div className="mb-3">
      {isExpanded && (
        <div className="flex flex-wrap gap-2 overflow-hidden transition-all duration-200">
          {enabledServers.map((server) => (
            <MCPServerBadge
              key={server.config.id}
              config={server.config}
              state={server.state}
              status={server.status}
              toolCount={server.toolCount}
              disabled={disabled}
              onToggled={onServerToggled}
            />
          ))}
        </div>
      )}

      <button
        onClick={() => setIsExpanded((prev) => !prev)}
        className={`${isExpanded ? 'mt-1' : ''} flex items-center gap-1 text-xs text-text-secondary hover:text-accent transition-colors`}
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
          ? t('mcp.hideServers', 'Hide MCP servers')
          : t('mcp.showServers', 'Show MCP servers ({{count}})', { count: enabledServers.length })}
      </button>
    </div>
  );
};

export default MCPServerBadges;

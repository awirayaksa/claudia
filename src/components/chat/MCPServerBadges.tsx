import React from 'react';
import { useAppSelector } from '../../store';
import { selectEnabledMCPServers } from '../../store/slices/mcpSlice';
import MCPServerBadge from './MCPServerBadge';

interface MCPServerBadgesProps {
  disabled?: boolean;
}

/**
 * Container component that displays a horizontal list of enabled MCP server badges.
 * Each badge shows the server status, name, tool count, and a toggle button to start/stop the server.
 * Only displays when there are enabled servers in the configuration.
 */
const MCPServerBadges: React.FC<MCPServerBadgesProps> = ({ disabled = false }) => {
  const enabledServers = useAppSelector(selectEnabledMCPServers);

  // Don't render anything if there are no enabled servers
  if (enabledServers.length === 0) {
    return null;
  }

  return (
    <div className="mb-3 flex flex-wrap gap-2">
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
  );
};

export default MCPServerBadges;

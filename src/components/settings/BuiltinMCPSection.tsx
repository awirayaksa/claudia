import { useState } from 'react';
import { useAppSelector, useAppDispatch } from '../../store';
import {
  startMCPServer,
  stopMCPServer,
  saveMCPServer,
  selectBuiltinServers,
} from '../../store/slices/mcpSlice';
import { MCPServerConfig } from '../../types/mcp.types';
import { Button } from '../common/Button';

interface BuiltinMCPSectionProps {
  onViewLogs: (serverId: string, serverName: string) => void;
}

export function BuiltinMCPSection({ onViewLogs }: BuiltinMCPSectionProps) {
  const dispatch = useAppDispatch();
  const builtinServers = useAppSelector(selectBuiltinServers);
  const serverStates = useAppSelector((state) => state.mcp.serverStates);
  const [configuringDirs, setConfiguringDirs] = useState<string | null>(null);

  if (builtinServers.length === 0) return null;

  const handleStartServer = async (serverId: string) => {
    try {
      await dispatch(startMCPServer(serverId)).unwrap();
    } catch (error) {
      console.error('Failed to start server:', error);
    }
  };

  const handleStopServer = async (serverId: string) => {
    try {
      await dispatch(stopMCPServer(serverId)).unwrap();
    } catch (error) {
      console.error('Failed to stop server:', error);
    }
  };

  const handleConfigureDirectories = async (server: MCPServerConfig) => {
    try {
      const paths = await window.electron.file.selectDirectories();
      if (paths && paths.length > 0) {
        const currentDirs = (server.builtinConfig?.allowedDirectories as string[]) || [];
        const newDirs = [...new Set([...currentDirs, ...paths])];

        const updatedConfig: MCPServerConfig = {
          ...server,
          builtinConfig: {
            ...server.builtinConfig,
            allowedDirectories: newDirs,
          },
        };

        await dispatch(saveMCPServer(updatedConfig)).unwrap();

        // If server is running, it needs a restart for the config to take effect
        const state = serverStates[server.id];
        if (state?.status === 'ready') {
          await dispatch(stopMCPServer(server.id)).unwrap();
          await dispatch(startMCPServer(server.id)).unwrap();
        }
      }
    } catch (error) {
      console.error('Failed to configure directories:', error);
    }
  };

  const handleRemoveDirectory = async (server: MCPServerConfig, dirToRemove: string) => {
    const currentDirs = (server.builtinConfig?.allowedDirectories as string[]) || [];
    const newDirs = currentDirs.filter((d) => d !== dirToRemove);

    const updatedConfig: MCPServerConfig = {
      ...server,
      builtinConfig: {
        ...server.builtinConfig,
        allowedDirectories: newDirs,
      },
    };

    await dispatch(saveMCPServer(updatedConfig)).unwrap();

    // Restart if running
    const state = serverStates[server.id];
    if (state?.status === 'ready') {
      await dispatch(stopMCPServer(server.id)).unwrap();
      await dispatch(startMCPServer(server.id)).unwrap();
    }
  };

  const statusConfig: Record<string, { color: string; icon: string; label: string }> = {
    stopped: { color: 'text-gray-500', icon: '\u25CB', label: 'Stopped' },
    starting: { color: 'text-blue-500', icon: '\u25D0', label: 'Starting...' },
    initializing: { color: 'text-blue-500', icon: '\u25D1', label: 'Initializing...' },
    ready: { color: 'text-green-500', icon: '\u25CF', label: 'Ready' },
    error: { color: 'text-error', icon: '\u26A0', label: 'Error' },
    stopping: { color: 'text-gray-500', icon: '\u25CB', label: 'Stopping...' },
  };

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
        Built-in Tools
      </h4>

      {builtinServers.map((server) => {
        const state = serverStates[server.id];
        const status = state?.status || 'stopped';
        const tools = state?.tools || [];
        const resources = state?.resources || [];
        const prompts = state?.prompts || [];
        const serverError = state?.error;
        const sc = statusConfig[status] || statusConfig.stopped;

        const isFilesystem = server.builtinId === 'builtin-filesystem-001';
        const allowedDirs = (server.builtinConfig?.allowedDirectories as string[]) || [];
        const showDirConfig = configuringDirs === server.id;

        return (
          <div
            key={server.id}
            className="flex flex-col rounded border border-border bg-surface p-4 hover:bg-surface-hover transition-colors"
          >
            {/* Server Info */}
            <div>
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-base font-medium text-text-primary">
                  {server.name}
                </span>
                <span className={`flex items-center gap-1 text-sm ${sc.color}`}>
                  <span>{sc.icon}</span>
                  <span>{sc.label}</span>
                </span>
                <span className="rounded bg-accent bg-opacity-20 px-1.5 py-0.5 text-xs text-accent font-medium">
                  Built-in
                </span>
                {tools.length > 0 && (
                  <span className="rounded-full bg-accent px-2 py-0.5 text-xs text-white">
                    {tools.length} {tools.length === 1 ? 'tool' : 'tools'}
                  </span>
                )}
                {resources.length > 0 && (
                  <span className="rounded-full bg-blue-600 px-2 py-0.5 text-xs text-white">
                    {resources.length} {resources.length === 1 ? 'resource' : 'resources'}
                  </span>
                )}
                {prompts.length > 0 && (
                  <span className="rounded-full bg-purple-600 px-2 py-0.5 text-xs text-white">
                    {prompts.length} {prompts.length === 1 ? 'prompt' : 'prompts'}
                  </span>
                )}
              </div>

              {/* Description */}
              {server.metadata?.description && (
                <div className="mt-1 text-xs text-text-secondary">
                  {server.metadata.description}
                </div>
              )}

              {/* Error message */}
              {serverError && status === 'error' && (
                <div className="mt-2 text-sm text-error">{serverError}</div>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border">
              {status === 'ready' && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => handleStopServer(server.id)}
                >
                  Stop
                </Button>
              )}
              {(status === 'stopped' || status === 'error') && (
                <Button size="sm" onClick={() => handleStartServer(server.id)}>
                  Start
                </Button>
              )}
              {(status === 'starting' || status === 'initializing' || status === 'stopping') && (
                <Button size="sm" variant="secondary" disabled>
                  {sc.label}
                </Button>
              )}

              <Button
                size="sm"
                variant="secondary"
                onClick={() => onViewLogs(server.id, server.name)}
              >
                View Logs
              </Button>

              {isFilesystem && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setConfiguringDirs(showDirConfig ? null : server.id)}
                >
                  {showDirConfig ? 'Hide Directories' : 'Configure Directories'}
                </Button>
              )}
            </div>

            {/* Filesystem directory config panel */}
            {isFilesystem && showDirConfig && (
              <div className="mt-3 pt-3 border-t border-border">
                <div className="text-xs text-text-secondary mb-2">
                  Allowed directories (the filesystem server can only access files within these folders):
                </div>

                {allowedDirs.length > 0 ? (
                  <div className="space-y-1 mb-2">
                    {allowedDirs.map((dir) => (
                      <div
                        key={dir}
                        className="flex items-center justify-between rounded bg-background px-2 py-1 text-xs"
                      >
                        <span className="font-mono text-text-primary truncate mr-2">{dir}</span>
                        <button
                          onClick={() => handleRemoveDirectory(server, dir)}
                          className="text-text-secondary hover:text-error transition-colors shrink-0"
                          title="Remove directory"
                        >
                          &times;
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-text-secondary italic mb-2">
                    No directories configured. Default: Desktop and Documents.
                  </div>
                )}

                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => handleConfigureDirectories(server)}
                >
                  + Add Directory
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

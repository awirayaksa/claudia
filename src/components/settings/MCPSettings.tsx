import { useState, useEffect } from 'react';
import { useAppSelector, useAppDispatch } from '../../store';
import {
  loadMCPServers,
  startMCPServer,
  stopMCPServer,
  deleteMCPServer,
  importFromClaudeDesktop,
  updateServerStatus,
  setServerTools,
  setServerResources,
  setServerPrompts,
  setServerError,
  saveMCPServer,
  syncAllServerTools,
} from '../../store/slices/mcpSlice';
import { MCPServerConfig } from '../../types/mcp.types';
import { Button } from '../common/Button';
import { MCPServerModal } from './MCPServerModal';

export function MCPSettings() {
  const dispatch = useAppDispatch();
  const { servers, serverStates, isLoadingServers, error } = useAppSelector(
    (state) => state.mcp
  );

  const [showAddModal, setShowAddModal] = useState(false);
  const [editingServer, setEditingServer] = useState<MCPServerConfig | null>(null);
  const [importing, setImporting] = useState(false);
  const [logsModal, setLogsModal] = useState<{ serverId: string; serverName: string; logs: string[] } | null>(null);

  // Load servers on mount
  useEffect(() => {
    const initServers = async () => {
      await dispatch(loadMCPServers());
      // Sync tools from all running servers
      await dispatch(syncAllServerTools());
    };
    initServers();
  }, [dispatch]);

  // Subscribe to server events
  useEffect(() => {
    const cleanupStatus = window.electron.mcp.onServerStatusChanged((event: { serverId: string; status: string; error?: string }) => {
      dispatch(
        updateServerStatus({
          id: event.serverId,
          status: event.status as any,
          error: event.error,
        })
      );
    });

    const cleanupTools = window.electron.mcp.onServerToolsUpdated((event: { serverId: string; tools: any[] }) => {
      console.log('[MCPSettings] Tools updated for server:', event.serverId, 'Tools count:', event.tools?.length || 0);
      dispatch(
        setServerTools({
          id: event.serverId,
          tools: event.tools,
        })
      );
    });

    const cleanupResources = window.electron.mcp.onServerResourcesUpdated((event: { serverId: string; resources: any[] }) => {
      console.log('[MCPSettings] Resources updated for server:', event.serverId, 'Resources count:', event.resources?.length || 0);
      dispatch(
        setServerResources({
          id: event.serverId,
          resources: event.resources,
        })
      );
    });

    const cleanupPrompts = window.electron.mcp.onServerPromptsUpdated((event: { serverId: string; prompts: any[] }) => {
      console.log('[MCPSettings] Prompts updated for server:', event.serverId, 'Prompts count:', event.prompts?.length || 0);
      dispatch(
        setServerPrompts({
          id: event.serverId,
          prompts: event.prompts,
        })
      );
    });

    const cleanupError = window.electron.mcp.onServerError((event: { serverId: string; error: string }) => {
      dispatch(
        setServerError({
          id: event.serverId,
          error: event.error,
        })
      );
    });

    return () => {
      cleanupStatus?.();
      cleanupTools?.();
      cleanupResources?.();
      cleanupPrompts?.();
      cleanupError?.();
    };
  }, [dispatch]);

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

  const handleDeleteServer = async (serverId: string) => {
    const server = servers[serverId];
    if (window.confirm(`Delete "${server?.name}"? This cannot be undone.`)) {
      try {
        await dispatch(deleteMCPServer(serverId)).unwrap();
      } catch (error) {
        console.error('Failed to delete server:', error);
      }
    }
  };

  const handleImportClaudeDesktop = async () => {
    setImporting(true);
    try {
      const result = await dispatch(importFromClaudeDesktop()).unwrap();
      alert(
        `Successfully imported ${result.length} server(s) from Claude Desktop:\n\n${result
          .map((s: MCPServerConfig) => `• ${s.name}`)
          .join('\n')}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to import';
      alert(`Import failed:\n\n${message}`);
    } finally {
      setImporting(false);
    }
  };

  const handleSaveServer = async (config: MCPServerConfig) => {
    try {
      await dispatch(saveMCPServer(config)).unwrap();
    } catch (error) {
      console.error('Failed to save server:', error);
      alert(`Failed to save server: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleViewLogs = async (serverId: string, serverName: string) => {
    try {
      const response = await window.electron.mcp.getLogs(serverId);
      if (response.success) {
        setLogsModal({ serverId, serverName, logs: response.logs });
      } else {
        alert(`Failed to get logs: ${response.error}`);
      }
    } catch (error) {
      console.error('Failed to get logs:', error);
      alert(`Failed to get logs: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleClearLogs = async () => {
    if (!logsModal) return;

    if (window.confirm('Clear all logs for this server?')) {
      try {
        const response = await window.electron.mcp.clearLogs(logsModal.serverId);
        if (response.success) {
          // Refresh the logs modal
          setLogsModal({ ...logsModal, logs: [] });
        } else {
          alert(`Failed to clear logs: ${response.error}`);
        }
      } catch (error) {
        console.error('Failed to clear logs:', error);
        alert(`Failed to clear logs: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
  };

  // Helper to get server info display
  const getServerInfo = (server: MCPServerConfig): string => {
    if (server.transport === 'stdio') {
      return `${server.command || ''} ${(server.args || []).join(' ')}`.trim();
    } else if (server.transport === 'streamable-http') {
      return server.url || '';
    }
    return '';
  };

  // Helper to get transport label
  const getTransportLabel = (transport: string): string => {
    switch (transport) {
      case 'stdio':
        return 'stdio';
      case 'streamable-http':
        return 'HTTP';
      case 'sse':
        return 'SSE (legacy)';
      default:
        return transport;
    }
  };

  const serverList = Object.values(servers);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="mb-2 text-lg font-semibold text-text-primary">
          MCP Server Configuration
        </h3>
        <p className="text-sm text-text-secondary">
          Manage Model Context Protocol servers to extend Claude's capabilities with custom
          tools, resources, and prompts.
        </p>
      </div>

      {/* Error Display */}
      {error && (
        <div className="rounded border border-error bg-error bg-opacity-10 p-3 text-sm text-error">
          {error}
        </div>
      )}

      {/* Server List */}
      <div className="space-y-2">
        {isLoadingServers ? (
          <div className="flex items-center justify-center p-8 text-text-secondary">
            <div className="text-center">
              <div className="mb-2 text-sm">Loading servers...</div>
            </div>
          </div>
        ) : serverList.length === 0 ? (
          <div className="rounded border border-border bg-surface p-8 text-center">
            <div className="mb-2 text-sm font-medium text-text-primary">
              No MCP Servers Configured
            </div>
            <p className="mb-4 text-xs text-text-secondary">
              Add a server manually or import from Claude Desktop to get started.
            </p>
            <div className="flex justify-center gap-2">
              <Button onClick={() => setShowAddModal(true)} size="sm">
                + Add Server
              </Button>
              <Button
                onClick={handleImportClaudeDesktop}
                variant="secondary"
                size="sm"
                disabled={importing}
              >
                {importing ? 'Importing...' : 'Import from Claude Desktop'}
              </Button>
            </div>
          </div>
        ) : (
          serverList.map((server) => {
            const state = serverStates[server.id];
            const status = state?.status || 'stopped';
            const tools = state?.tools || [];
            const resources = state?.resources || [];
            const prompts = state?.prompts || [];
            const serverError = state?.error;

            // Status configuration
            const statusConfig = {
              stopped: { color: 'text-gray-500', icon: '○', label: 'Stopped' },
              starting: { color: 'text-blue-500', icon: '◐', label: 'Starting...' },
              initializing: {
                color: 'text-blue-500',
                icon: '◑',
                label: 'Initializing...',
              },
              ready: { color: 'text-green-500', icon: '●', label: 'Ready' },
              error: { color: 'text-error', icon: '⚠', label: 'Error' },
              stopping: { color: 'text-gray-500', icon: '○', label: 'Stopping...' },
            }[status];

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
                    <span className={`flex items-center gap-1 text-sm ${statusConfig.color}`}>
                      <span>{statusConfig.icon}</span>
                      <span>{statusConfig.label}</span>
                    </span>
                    <span className="rounded bg-gray-600 px-1.5 py-0.5 text-xs text-gray-200">
                      {getTransportLabel(server.transport)}
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

                  {/* Server info preview */}
                  <div className="mt-1 text-xs text-text-secondary font-mono truncate max-w-lg">
                    {getServerInfo(server)}
                  </div>

                  {/* Error message - only show when status is error */}
                  {serverError && status === 'error' && (
                    <div className="mt-2 text-sm text-error">{serverError}</div>
                  )}

                  {/* Description */}
                  {server.metadata?.description && (
                    <div className="mt-1 text-xs text-text-secondary">
                      {server.metadata.description}
                    </div>
                  )}
                </div>

                {/* Actions - New Row */}
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
                  {(status === 'starting' ||
                    status === 'initializing' ||
                    status === 'stopping') && (
                    <Button size="sm" variant="secondary" disabled>
                      {statusConfig.label}
                    </Button>
                  )}

                  {/* View Logs button - always show */}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => handleViewLogs(server.id, server.name)}
                  >
                    View Logs
                  </Button>

                  {/* Edit button - show when stopped or error */}
                  {(status === 'stopped' || status === 'error') && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setEditingServer(server)}
                    >
                      Edit
                    </Button>
                  )}

                  {/* Delete button - show when stopped or error */}
                  {(status === 'stopped' || status === 'error') && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => handleDeleteServer(server.id)}
                      className="text-error hover:bg-error hover:bg-opacity-10"
                    >
                      Delete
                    </Button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Action Buttons */}
      {serverList.length > 0 && (
        <div className="flex gap-2">
          <Button onClick={() => setShowAddModal(true)}>+ Add Server</Button>
          <Button
            onClick={handleImportClaudeDesktop}
            variant="secondary"
            disabled={importing}
          >
            {importing ? 'Importing...' : 'Import from Claude Desktop'}
          </Button>
        </div>
      )}

      {/* Add/Edit Modal */}
      <MCPServerModal
        isOpen={showAddModal || !!editingServer}
        onClose={() => {
          setShowAddModal(false);
          setEditingServer(null);
        }}
        onSave={handleSaveServer}
        initialConfig={editingServer}
      />

      {/* Logs Modal */}
      {logsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
          <div className="w-full max-w-4xl max-h-[80vh] bg-background rounded-lg shadow-lg border border-border flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-border">
              <div>
                <h3 className="text-lg font-semibold text-text-primary">Server Logs</h3>
                <p className="text-sm text-text-secondary">{logsModal.serverName}</p>
              </div>
              <button
                onClick={() => setLogsModal(null)}
                className="text-text-secondary hover:text-text-primary transition-colors"
              >
                ✕
              </button>
            </div>

            {/* Logs Content */}
            <div className="flex-1 overflow-auto p-4">
              {logsModal.logs.length === 0 ? (
                <div className="text-center py-8 text-text-secondary">
                  No logs available. Logs are captured from stderr when the server is running.
                </div>
              ) : (
                <pre className="text-xs font-mono text-text-primary whitespace-pre-wrap break-words">
                  {logsModal.logs.join('\n')}
                </pre>
              )}
            </div>

            {/* Footer */}
            <div className="flex justify-between p-4 border-t border-border">
              <Button
                variant="secondary"
                onClick={handleClearLogs}
                className="text-error hover:bg-error hover:bg-opacity-10"
                disabled={logsModal.logs.length === 0}
              >
                Clear Logs
              </Button>
              <Button
                variant="secondary"
                onClick={() => setLogsModal(null)}
              >
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

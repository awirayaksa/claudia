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
import { BuiltinMCPSection } from './BuiltinMCPSection';

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
    } else if (server.transport === 'streamable-http' || server.transport === 'sse') {
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
        return 'SSE';
      default:
        return transport;
    }
  };

  const customServers = Object.values(servers).filter((s) => !s.builtin);
  const serverList = customServers;

  return (
    <div>
      {/* Header */}
      <div
        style={{
          padding: '22px 28px 18px',
          borderBottom: '1px solid #ebe7e1',
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: -0.2, marginBottom: 4, color: '#1a1a19' }}>
          MCP Servers
        </div>
        <div style={{ fontSize: 13, color: '#6f6b66', lineHeight: 1.55 }}>
          Manage Model Context Protocol servers to extend Claudia's capabilities with custom
          tools, resources, and prompts.
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="rounded border border-error bg-error bg-opacity-10 p-3 text-sm text-error">
          {error}
        </div>
      )}

      {/* Built-in + Custom Server sections */}
      <div style={{ padding: '18px 28px' }}>
        {/* Section header row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 11, letterSpacing: 0.8, color: '#6f6b66', fontWeight: 600, textTransform: 'uppercase' }}>
            Installed · {Object.values(servers).length + (isLoadingServers ? 0 : 0)}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleImportClaudeDesktop}
              disabled={importing}
              style={{
                border: '1px solid #ebe7e1',
                background: '#fff',
                borderRadius: 7,
                padding: '5px 12px',
                fontSize: 12,
                cursor: importing ? 'not-allowed' : 'pointer',
                color: '#2e2b27',
                opacity: importing ? 0.6 : 1,
              }}
            >
              {importing ? 'Importing...' : 'Import from Claude Desktop'}
            </button>
            <button
              onClick={() => setShowAddModal(true)}
              style={{
                background: '#1a1a19',
                color: '#fff',
                border: 'none',
                borderRadius: 7,
                padding: '5px 12px',
                fontSize: 12,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              + Add server
            </button>
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <div className="rounded border border-error bg-error bg-opacity-10 p-3 text-sm text-error mb-3">
            {error}
          </div>
        )}

        {/* Built-in Servers */}
        <BuiltinMCPSection onViewLogs={handleViewLogs} />

        {/* Custom Server List */}
        <div className="space-y-2 mt-2">
          {isLoadingServers ? (
            <div style={{ padding: '24px 0', textAlign: 'center', fontSize: 13, color: '#6f6b66' }}>
              Loading servers...
            </div>
          ) : serverList.length === 0 ? (
            <div
              style={{
                border: '1px solid #ebe7e1',
                borderRadius: 10,
                padding: '28px 20px',
                textAlign: 'center',
                background: '#faf8f5',
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 500, color: '#1a1a19', marginBottom: 6 }}>
                No custom MCP servers yet
              </div>
              <div style={{ fontSize: 12, color: '#6f6b66' }}>
                Add a server manually or import from Claude Desktop to get started.
              </div>
            </div>
          ) : (
            serverList.map((server) => {
              const state = serverStates[server.id];
              const status = state?.status || 'stopped';
              const serverError = state?.error;

              type StatusKey = 'stopped' | 'starting' | 'initializing' | 'ready' | 'error' | 'stopping';
              const statusChipMap: Record<StatusKey, { dot: string; bg: string; fg: string; label: string }> = {
                stopped:      { dot: '#9a958e', bg: '#faf8f5', fg: '#6f6b66', label: 'Stopped' },
                starting:     { dot: '#3d7bc9', bg: '#eaf0fb', fg: '#1e3a6e', label: 'Starting…' },
                initializing: { dot: '#3d7bc9', bg: '#eaf0fb', fg: '#1e3a6e', label: 'Initializing…' },
                ready:        { dot: '#2f8f4a', bg: '#eaf6ee', fg: '#1e5a2e', label: 'Running' },
                error:        { dot: '#b14a3b', bg: '#fbeceb', fg: '#8a2f24', label: serverError || 'Error' },
                stopping:     { dot: '#9a958e', bg: '#faf8f5', fg: '#6f6b66', label: 'Stopping…' },
              };
              const chip = statusChipMap[status as StatusKey] || statusChipMap.stopped;
              const isRunning = status === 'ready';
              const isTransient = status === 'starting' || status === 'initializing' || status === 'stopping';

              return (
                <div
                  key={server.id}
                  style={{
                    border: '1px solid #ebe7e1',
                    borderRadius: 10,
                    padding: '14px 16px',
                    background: '#fff',
                    marginBottom: 8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                    {/* Icon */}
                    <div
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 7,
                        background: '#faf8f5',
                        border: '1px solid #ebe7e1',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 14,
                        flexShrink: 0,
                        fontWeight: 600,
                        color: '#2e2b27',
                      }}
                    >
                      {server.name[0]}
                    </div>

                    <div style={{ flex: 1, minWidth: 0 }}>
                      {/* Name + status chip + transport */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 13.5, fontWeight: 600, color: '#1a1a19' }}>
                          {server.name}
                        </span>
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 5,
                            background: chip.bg,
                            color: chip.fg,
                            fontSize: 11,
                            fontWeight: 500,
                            padding: '2px 8px',
                            borderRadius: 10,
                          }}
                        >
                          <span style={{ color: chip.dot, fontSize: 9 }}>●</span>
                          {chip.label}
                        </span>
                        <span
                          style={{
                            fontSize: 10,
                            color: '#6f6b66',
                            border: '1px solid #ebe7e1',
                            borderRadius: 4,
                            padding: '1px 6px',
                          }}
                        >
                          {getTransportLabel(server.transport)}
                        </span>
                      </div>

                      {/* Description / server info */}
                      {server.metadata?.description ? (
                        <div style={{ fontSize: 12, color: '#6f6b66', lineHeight: 1.5, marginBottom: 10 }}>
                          {server.metadata.description}
                        </div>
                      ) : (
                        <div
                          style={{
                            fontSize: 11.5,
                            color: '#6f6b66',
                            fontFamily: 'ui-monospace, Menlo, monospace',
                            marginBottom: 10,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {getServerInfo(server)}
                        </div>
                      )}

                      {/* Action row */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {/* Start / Stop */}
                        {isTransient ? (
                          <button
                            disabled
                            style={{
                              border: '1px solid #ebe7e1',
                              background: '#fff',
                              borderRadius: 6,
                              padding: '4px 10px',
                              fontSize: 12,
                              color: '#6f6b66',
                              cursor: 'not-allowed',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 5,
                            }}
                          >
                            {chip.label}
                          </button>
                        ) : isRunning ? (
                          <button
                            onClick={() => handleStopServer(server.id)}
                            style={{
                              border: '1px solid #ebe7e1',
                              background: '#fff',
                              borderRadius: 6,
                              padding: '4px 10px',
                              fontSize: 12,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 5,
                              color: '#2e2b27',
                            }}
                          >
                            <span>■</span> Stop
                          </button>
                        ) : (
                          <button
                            onClick={() => handleStartServer(server.id)}
                            style={{
                              border: '1px solid #ebe7e1',
                              background: '#fff',
                              borderRadius: 6,
                              padding: '4px 10px',
                              fontSize: 12,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 5,
                              color: '#2e2b27',
                            }}
                          >
                            <span>▶</span> Start
                          </button>
                        )}

                        <button
                          onClick={() => handleViewLogs(server.id, server.name)}
                          style={{
                            border: '1px solid #ebe7e1',
                            background: '#fff',
                            borderRadius: 6,
                            padding: '4px 10px',
                            fontSize: 12,
                            cursor: 'pointer',
                            color: '#2e2b27',
                          }}
                        >
                          Logs
                        </button>

                        {!isRunning && !isTransient && (
                          <button
                            onClick={() => setEditingServer(server)}
                            style={{
                              border: '1px solid #ebe7e1',
                              background: '#fff',
                              borderRadius: 6,
                              padding: '4px 10px',
                              fontSize: 12,
                              cursor: 'pointer',
                              color: '#2e2b27',
                            }}
                          >
                            Configure
                          </button>
                        )}

                        <div style={{ flex: 1 }} />

                        {!isRunning && !isTransient && (
                          <button
                            onClick={() => handleDeleteServer(server.id)}
                            style={{
                              border: '1px solid #ebe7e1',
                              background: '#fff',
                              borderRadius: 6,
                              padding: '4px 8px',
                              fontSize: 13,
                              cursor: 'pointer',
                              color: '#6f6b66',
                            }}
                            title="Delete server"
                          >
                            ⋯
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

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

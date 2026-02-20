import { useAppSelector, useAppDispatch } from '../../store';
import {
  startMCPServer,
  stopMCPServer,
  selectBuiltinServers,
} from '../../store/slices/mcpSlice';
import { Button } from '../common/Button';

interface BuiltinMCPSectionProps {
  onViewLogs: (serverId: string, serverName: string) => void;
}

export function BuiltinMCPSection({ onViewLogs }: BuiltinMCPSectionProps) {
  const dispatch = useAppDispatch();
  const builtinServers = useAppSelector(selectBuiltinServers);
  const serverStates = useAppSelector((state) => state.mcp.serverStates);

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
            </div>
          </div>
        );
      })}
    </div>
  );
}

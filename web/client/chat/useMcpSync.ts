/**
 * Mirrors the server's view of this user's tool servers and skills into the
 * shared desktop slices, so the shared composer (server badges, /skill
 * mentions) works unchanged.
 */
import { useEffect } from 'react';
import { getPlatform } from '@/platform';
import { useAppDispatch } from '@/store';
import { rebuildAvailableTools, setServers, setServerState } from '@/store/slices/mcpSlice';
import { loadSkills, setSkills } from '@/store/slices/skillSlice';
import type { MCPServerConfig } from '@/types/mcp.types';
import type { McpServerView } from '@shared/mcp';
import { useMcpServersQuery } from '../api/rtk-api';

export function toServerConfig(s: McpServerView): MCPServerConfig {
  return {
    id: s.id,
    name: s.name,
    // An OpenAPI server is an HTTP tool server as far as the composer's badges go
    transport: s.transport === 'openapi' ? 'streamable-http' : s.transport,
    // Offered to this user; whether it's switched on shows as running/stopped
    enabled: true,
    builtin: s.scope === 'builtin',
    ...(s.description ? { metadata: { description: s.description } } : {}),
  };
}

/** The ids of the servers this user has switched on (sent with each message). */
export function enabledServerIds(servers: McpServerView[] | undefined): string[] {
  return (servers ?? []).filter((s) => s.enabled).map((s) => s.id);
}

export function useMcpSync(): void {
  const dispatch = useAppDispatch();
  // Global servers can change status at any time; a slow poll keeps badges honest
  const { data } = useMcpServersQuery(undefined, { pollingInterval: 30_000 });

  useEffect(() => {
    if (!data) return;
    const configs = Object.fromEntries(data.servers.map((s) => [s.id, toServerConfig(s)]));
    dispatch(setServers(configs));
    for (const s of data.servers) {
      dispatch(
        setServerState({
          id: s.id,
          state: {
            config: configs[s.id],
            status: s.enabled ? s.status : 'stopped',
            tools: s.enabled ? s.tools : [],
            resources: [],
            prompts: [],
            restartCount: 0,
            ...(s.error ? { error: s.error } : {}),
          },
        })
      );
    }
    dispatch(rebuildAvailableTools());
  }, [data, dispatch]);

  useEffect(() => {
    void dispatch(loadSkills());
    return getPlatform().events.on('skill.changed', (skills) => dispatch(setSkills(skills)));
  }, [dispatch]);
}

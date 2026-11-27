/**
 * A server's tools, each set to run without asking, ask first, or be blocked
 * (never offered to the model). Listed while the server runs.
 */
import { useAppDispatch, useAppSelector } from '../../store';
import { saveMCPServer } from '../../store/slices/mcpSlice';
import { toolPolicy, withToolPolicy, type ToolPolicy } from '../../services/mcp/tool-policy';
import { useT } from '../../i18n';

export function ToolPermissions({ serverId }: { serverId: string }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const config = useAppSelector((state) => state.mcp.servers[serverId]);
  const tools = useAppSelector((state) => state.mcp.serverStates[serverId]?.tools ?? []);
  if (!config || tools.length === 0) return null;

  const labels: Record<ToolPolicy, string> = {
    allow: t('mcp.policy.allow', 'Always allow'),
    ask: t('mcp.policy.ask', 'Ask first'),
    block: t('mcp.policy.block', 'Blocked'),
  };
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const asking = sorted.filter((tool) => toolPolicy(config, tool) === 'ask').length;

  return (
    <details className="mt-2 text-xs" data-testid={`tool-permissions-${serverId}`}>
      <summary className="cursor-pointer select-none text-text-secondary hover:text-text-primary">
        {t('mcp.toolPermissions', 'Tool permissions')} · {t('mcp.toolsAsking', '{{count}} of {{total}} ask first', { count: asking, total: sorted.length })}
      </summary>
      <ul className="mt-2 divide-y divide-border rounded border border-border">
        {sorted.map((tool) => {
          const policy = toolPolicy(config, tool);
          return (
            <li key={tool.name} className="flex items-center justify-between gap-3 px-2 py-1.5">
              <div className="min-w-0">
                <div className="truncate font-mono text-text-primary">{tool.name}</div>
                {tool.description && <div className="truncate text-text-secondary" title={tool.description}>{tool.description}</div>}
              </div>
              <select
                className="shrink-0 rounded border border-border bg-background px-1.5 py-0.5 text-xs text-text-primary"
                value={policy}
                aria-label={t('mcp.policyFor', 'Permission for {{tool}}', { tool: tool.name })}
                onChange={(e) => dispatch(saveMCPServer(withToolPolicy(config, tool, e.target.value as ToolPolicy)))}
              >
                {(['allow', 'ask', 'block'] as const).map((p) => (
                  <option key={p} value={p}>
                    {labels[p]}
                  </option>
                ))}
              </select>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

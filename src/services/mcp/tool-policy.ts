/**
 * Whether a tool may run without asking: allowed, asked about each time, or
 * blocked (never offered to the model). Set per tool on each server; tools
 * without a setting ask, except the built-in servers' read-only tools.
 */
import type { MCPServerConfig, MCPTool, ToolPolicy } from '../../types/mcp.types';

export type { ToolPolicy };

/** Built-in tools that only read: by their read-only hint, or else by name. */
function readsOnly(tool: Pick<MCPTool, 'name' | 'annotations'>): boolean {
  const hint = tool.annotations?.readOnlyHint;
  if (hint !== undefined) return hint;
  // (not search_*: search_and_replace writes)
  return /^(read|list|get)_/.test(tool.name) || tool.name === 'search_files';
}

/** The policy a tool has before the user sets one. */
export function defaultToolPolicy(
  server: Pick<MCPServerConfig, 'builtin'> | undefined,
  tool: Pick<MCPTool, 'name' | 'annotations'>
): ToolPolicy {
  return server?.builtin && readsOnly(tool) ? 'allow' : 'ask';
}

export function toolPolicy(
  server: Pick<MCPServerConfig, 'builtin' | 'toolPolicies'> | undefined,
  tool: Pick<MCPTool, 'name' | 'annotations'>
): ToolPolicy {
  return server?.toolPolicies?.[tool.name] ?? defaultToolPolicy(server, tool);
}

/** The server's config with one tool's policy changed (the default is not stored). */
export function withToolPolicy(server: MCPServerConfig, tool: Pick<MCPTool, 'name' | 'annotations'>, policy: ToolPolicy): MCPServerConfig {
  const policies = { ...server.toolPolicies };
  if (policy === defaultToolPolicy(server, tool)) delete policies[tool.name];
  else policies[tool.name] = policy;
  return { ...server, toolPolicies: Object.keys(policies).length ? policies : undefined };
}

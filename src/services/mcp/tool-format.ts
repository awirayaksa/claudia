/**
 * Pure helpers for presenting MCP tools to OpenAI-compatible models.
 *
 * No Electron, DOM or `@mcp-ui/client` imports: this module is shared by the
 * desktop renderer and the web server.
 */
import type { MCPTool, UIResourceContent } from '../../types/mcp.types';
import type { OpenAITool } from '../../types/api.types';

/** OpenAI's function-name rule. */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_TOOL_NAME = 64;
const HASH_LEN = 8;

/** A server whose tools are offered to the model. */
export interface ToolSource {
  id: string;
  name: string;
  tools: MCPTool[];
}

/** One model-facing tool name and where it really lives. */
export interface ToolAlias {
  alias: string;
  serverId: string;
  serverName: string;
  /** The tool's real MCP name, used for `tools/call`. */
  tool: string;
  definition: MCPTool;
}

/** FNV-1a 32-bit, as 8 hex chars. Deterministic and dependency-free. */
export function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(HASH_LEN, '0');
}

/** Replace characters OpenAI rejects and collapse runs of underscores. */
export function sanitizeToolName(name: string): string {
  const cleaned = name
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'tool';
}

/** Keep a name within 64 chars, replacing the tail with a hash of the full name. */
function fitLength(name: string, hashSource: string): string {
  if (name.length <= MAX_TOOL_NAME) return name;
  return `${name.slice(0, MAX_TOOL_NAME - HASH_LEN - 1)}_${shortHash(hashSource)}`;
}

/** Short, readable prefix for a server, e.g. "Office Tools" → "office_tools". */
function serverPrefix(server: ToolSource): string {
  return sanitizeToolName(server.name).toLowerCase().slice(0, 16).replace(/_+$/, '') || 'server';
}

/**
 * Build model-facing names for every tool of every server.
 *
 * - A tool keeps its sanitized bare name when no other server offers the same one.
 * - On a collision, each colliding tool is prefixed with a short server alias
 *   (`<server>__<tool>`); if two servers share that prefix too, the server id
 *   hash disambiguates.
 * - Anything over 64 characters is hash-truncated.
 *
 * The result is deterministic for the same input, so stored tool calls resolve
 * the same way when history is replayed.
 */
export function buildToolAliases(servers: ToolSource[]): ToolAlias[] {
  const bareCount = new Map<string, number>();
  for (const server of servers) {
    // A server listing the same tool twice still counts once for itself
    for (const bare of new Set(server.tools.map((t) => sanitizeToolName(t.name)))) {
      bareCount.set(bare, (bareCount.get(bare) ?? 0) + 1);
    }
  }

  const prefixCount = new Map<string, number>();
  for (const server of servers) {
    const p = serverPrefix(server);
    prefixCount.set(p, (prefixCount.get(p) ?? 0) + 1);
  }

  const used = new Set<string>();
  const aliases: ToolAlias[] = [];

  for (const server of servers) {
    const prefix =
      (prefixCount.get(serverPrefix(server)) ?? 0) > 1
        ? `${serverPrefix(server)}_${shortHash(server.id).slice(0, 4)}`
        : serverPrefix(server);

    for (const definition of server.tools) {
      const bare = sanitizeToolName(definition.name);
      let alias =
        (bareCount.get(bare) ?? 0) > 1
          ? fitLength(`${prefix}__${bare}`, `${server.id}/${definition.name}`)
          : fitLength(bare, `${server.id}/${definition.name}`);

      // Names that only collide after sanitizing (e.g. "a.b" and "a_b") get a hash suffix
      if (used.has(alias)) {
        alias = `${alias.slice(0, MAX_TOOL_NAME - HASH_LEN - 1)}_${shortHash(`${server.id}/${definition.name}`)}`;
      }
      // Still taken: the same server listed the same tool twice
      if (used.has(alias)) continue;

      used.add(alias);
      aliases.push({ alias, serverId: server.id, serverName: server.name, tool: definition.name, definition });
    }
  }

  return aliases;
}

/** Look up an alias. Returns null when no enabled server offers it. */
export function resolveToolAlias(alias: string, aliases: ToolAlias[]): ToolAlias | null {
  return aliases.find((a) => a.alias === alias) ?? null;
}

/**
 * Recursively strip non-standard JSON Schema fields that OpenAI-compatible
 * providers may reject (e.g. $schema, additionalProperties).
 */
export function cleanJsonSchema(schema: unknown): unknown {
  if (schema === null || typeof schema !== 'object') {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((item) => cleanJsonSchema(item));
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { $schema, additionalProperties, ...rest } = schema as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    cleaned[key] = cleanJsonSchema(value);
  }
  return cleaned;
}

/** One OpenAI function definition per tool, named by `nameOf` (default: the tool's own name). */
export function mcpToolsToOpenAI(
  tools: MCPTool[],
  nameOf: (tool: MCPTool, index: number) => string = (t) => t.name
): OpenAITool[] {
  return tools.map((tool, i) => ({
    type: 'function' as const,
    function: {
      name: nameOf(tool, i),
      description: tool.description || '',
      parameters: tool.inputSchema ? cleanJsonSchema(tool.inputSchema) : { type: 'object', properties: {} },
    },
  }));
}

// ─── Tool results ────────────────────────────────────────────────────────────

/** One item of an MCP `tools/call` result's `content` array. */
export interface MCPContentItem {
  type: string;
  text?: string;
  mimeType?: string;
  resource?: { uri?: string; mimeType?: string; text?: string; blob?: string };
  [key: string]: unknown;
}

/** A tool result reduced to what the model reads and what the user sees. */
export interface NormalizedToolResult {
  /** Text for the model. */
  content: string;
  isError: boolean;
  /** An MCP-UI resource to render, if the tool returned one. */
  uiResource?: UIResourceContent;
  /** Files the tool reports it wrote (`_meta["claudia/files"]`, set by the built-in servers). */
  files?: Array<{ path: string; name: string; size: number }>;
}

/** An embedded resource whose URI uses the MCP-UI `ui://` scheme (same rule as @mcp-ui/client). */
export function isUIResource(item: unknown): item is MCPContentItem & { resource: UIResourceContent } {
  const it = item as MCPContentItem | null;
  return !!it && it.type === 'resource' && typeof it.resource?.uri === 'string' && it.resource.uri.startsWith('ui://');
}

/** Text of one content item as the model should see it. */
function itemToText(c: MCPContentItem): string {
  if (c.type === 'text') return c.text ?? '';
  if (c.type === 'image') return `[Image: ${c.mimeType || 'unknown'}]`;
  if (c.type === 'resource') {
    if (c.resource?.text) return c.resource.text;
    return `[Resource: ${c.resource?.uri || c.mimeType || 'unknown'}]`;
  }
  return JSON.stringify(c);
}

/**
 * Normalize an MCP `tools/call` result.
 * - Errors: every item's text, joined.
 * - A UI resource: the text items for the model (or a placeholder) plus the resource.
 * - Otherwise: every item converted to text, joined with newlines.
 */
/** The `_meta` key built-in servers list written files under (see builtin-mcp/office-files.ts). */
const WRITTEN_FILES_META = 'claudia/files';

function writtenFiles(meta: unknown): NormalizedToolResult['files'] {
  const list = (meta as Record<string, unknown> | undefined)?.[WRITTEN_FILES_META];
  if (!Array.isArray(list)) return undefined;
  const files = list.filter(
    (f): f is { path: string; name: string; size: number } =>
      !!f && typeof f.path === 'string' && typeof f.name === 'string' && typeof f.size === 'number'
  );
  return files.length ? files.map(({ path, name, size }) => ({ path, name, size })) : undefined;
}

export function normalizeToolResult(result: { content?: MCPContentItem[]; isError?: boolean; _meta?: unknown }): NormalizedToolResult {
  const items = Array.isArray(result.content) ? result.content : [];

  if (result.isError) {
    return { content: items.map((c) => c.text || JSON.stringify(c)).join('\n'), isError: true };
  }

  const ui = items.find(isUIResource);
  if (ui) {
    const text = items
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    return { content: text || `[Interactive UI: ${ui.resource.uri}]`, isError: false, uiResource: ui.resource };
  }

  const files = writtenFiles(result._meta);
  return { content: items.map(itemToText).join('\n'), isError: false, ...(files ? { files } : {}) };
}

/** OpenAI function definitions for a set of aliases. */
export function aliasesToOpenAI(aliases: ToolAlias[]): OpenAITool[] {
  return mcpToolsToOpenAI(
    aliases.map((a) => a.definition),
    (_t, i) => aliases[i].alias
  );
}

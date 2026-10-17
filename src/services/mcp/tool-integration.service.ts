import { MCPTool } from '../../types/mcp.types';
import { ToolCall, ToolResult } from '../../types/message.types';
import { OpenAITool } from '../../types/api.types';
import { RootState } from '../../store';
import {
  ToolAlias,
  aliasesToOpenAI,
  buildToolAliases,
  cleanJsonSchema,
  mcpToolsToOpenAI,
  normalizeToolResult,
  resolveToolAlias,
} from './tool-format';
import { getPlatform } from '../../platform';

/** Where a model-facing tool name is executed. */
export interface ToolTarget {
  serverId: string;
  tool: string;
}

/**
 * Tool Integration Service
 *
 * Handles conversion between MCP tools and OpenAI function calling format,
 * and orchestrates tool execution through the Electron IPC layer.
 */
export class ToolIntegrationService {
  /**
   * Convert MCP tools to OpenAI function calling format, keeping their own names.
   * Strips non-standard fields (e.g. $schema, additionalProperties) from the
   * JSON Schema to avoid strict-proxy 400 errors.
   */
  static mcpToolsToOpenAI(mcpTools: MCPTool[]): OpenAITool[] {
    return mcpToolsToOpenAI(mcpTools);
  }

  static cleanJsonSchema(schema: unknown): unknown {
    return cleanJsonSchema(schema);
  }

  /**
   * Model-facing names for every tool on every ready server. Tools with the
   * same name on two servers both stay available, under server-prefixed aliases.
   */
  static getToolAliases(mcpState: RootState['mcp']): ToolAlias[] {
    return buildToolAliases(
      Object.entries(mcpState.serverStates)
        .filter(([, s]) => s.status === 'ready' && s.tools?.length)
        .map(([id, s]) => ({ id, name: s.config?.name || id, tools: s.tools }))
    );
  }

  /** OpenAI function definitions for every available tool, named by alias. */
  static getOpenAITools(mcpState: RootState['mcp']): OpenAITool[] {
    return aliasesToOpenAI(this.getToolAliases(mcpState));
  }

  /**
   * Resolve a model-facing tool name to the server and real tool name to call.
   * The name is first treated as an alias; a bare MCP tool name (older history,
   * UI actions) falls back to the first ready server that offers it.
   */
  static resolveTool(name: string, mcpState: RootState['mcp']): ToolTarget | null {
    const alias = resolveToolAlias(name, this.getToolAliases(mcpState));
    if (alias) return { serverId: alias.serverId, tool: alias.tool };

    const serverId = this.findServerForTool(name, mcpState);
    return serverId ? { serverId, tool: name } : null;
  }

  /**
   * Find which ready server has a tool with exactly this MCP name.
   * When `preferredServerId` offers it, that server wins.
   */
  static findServerForTool(
    toolName: string,
    mcpState: RootState['mcp'],
    preferredServerId?: string
  ): string | null {
    const offers = (serverId: string) => {
      const serverState = mcpState.serverStates[serverId];
      return (
        serverState?.status === 'ready' && !!serverState.tools?.some((tool) => tool.name === toolName)
      );
    };
    if (preferredServerId && offers(preferredServerId)) {
      return preferredServerId;
    }
    return Object.keys(mcpState.serverStates).find(offers) ?? null;
  }

  /**
   * Execute a single tool call with timeout
   */
  static async executeToolCall(
    toolCall: ToolCall,
    mcpState: RootState['mcp'],
    _traceId?: string,
    target: ToolTarget | null = this.resolveTool(toolCall.function.name, mcpState)
  ): Promise<ToolResult> {
    const result = await this.runToolCall(toolCall, target);
    // Remember which server produced the result, so UI actions go back to it
    return target ? { ...result, serverId: target.serverId } : result;
  }

  private static async runToolCall(toolCall: ToolCall, target: ToolTarget | null): Promise<ToolResult> {
    const toolName = target?.tool ?? toolCall.function.name;
    const TOOL_TIMEOUT_MS = 120000; // 120 seconds (Word COM launch can take 20+ seconds)

    if (!target) {
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name: toolName,
        content: JSON.stringify({
          error: `Tool "${toolName}" not found. Please ensure the MCP server providing this tool is running and ready.`,
        }),
        isError: true,
      };
    }

    try {
      // Parse arguments
      let args: Record<string, any>;
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch (parseError) {
        return {
          tool_call_id: toolCall.id,
          role: 'tool',
          name: toolName,
          content: JSON.stringify({
            error: `Invalid tool arguments: ${parseError instanceof Error ? parseError.message : 'Parse error'}. Expected valid JSON.`,
          }),
          isError: true,
        };
      }

      // Execute tool with timeout
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Tool execution timeout')), TOOL_TIMEOUT_MS)
      );

      const executionPromise = getPlatform().mcp.callTool(target.serverId, target.tool, args, undefined);

      const response = await Promise.race([executionPromise, timeoutPromise]);

      // Check if the IPC call itself failed
      if (!response.success) {
        const errorResult = {
          tool_call_id: toolCall.id,
          role: 'tool' as const,
          name: toolName,
          content: JSON.stringify({
            error: `Tool execution failed: ${response.error || 'Unknown error'}`,
          }),
          isError: true,
        };

        return errorResult;
      }

      // Text for the model, plus any UI resource to render
      const normalized = normalizeToolResult(response.result);
      return {
        tool_call_id: toolCall.id,
        role: 'tool' as const,
        name: toolName,
        content: normalized.content,
        isError: normalized.isError,
        ...(normalized.isError ? {} : { hasUI: !!normalized.uiResource }),
        ...(normalized.uiResource ? { uiResource: normalized.uiResource } : {}),
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'Tool execution timeout') {
        return {
          tool_call_id: toolCall.id,
          role: 'tool',
          name: toolName,
          content: JSON.stringify({
            error: `Tool execution timed out after ${TOOL_TIMEOUT_MS / 1000} seconds. The tool may be stuck or taking too long to respond.`,
          }),
          isError: true,
        };
      }

      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name: toolName,
        content: JSON.stringify({
          error: `Unexpected error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }),
        isError: true,
      };
    }
  }

  /**
   * Execute multiple tool calls in parallel
   */
  static async executeToolCalls(
    toolCalls: ToolCall[],
    mcpState: RootState['mcp'],
    _traceId?: string
  ): Promise<ToolResult[]> {
    const results = await Promise.all(
      toolCalls.map((toolCall) => this.executeToolCall(toolCall, mcpState, undefined))
    );

    return results;
  }

  /**
   * Get all available tools from ready MCP servers
   */
  static getAvailableTools(mcpState: RootState['mcp']): MCPTool[] {
    return mcpState.availableTools;
  }

  /**
   * Check if any MCP servers are ready and have tools
   */
  static hasAvailableTools(mcpState: RootState['mcp']): boolean {
    return mcpState.availableTools.length > 0;
  }

  /**
   * Format tool result for display
   */
  static formatToolResultForDisplay(result: ToolResult): string {
    // Don't format UI resources as strings
    if (result.hasUI) {
      return '[UI Component - Rendered Below]';
    }

    if (typeof result.content === 'string') {
      try {
        const content = JSON.parse(result.content);
        if (content.error) {
          return `Error: ${content.error}`;
        }
        return JSON.stringify(content, null, 2);
      } catch {
        return result.content;
      }
    }

    return JSON.stringify(result.content, null, 2);
  }

  /**
   * Validate tool arguments against schema
   * (Basic validation - can be enhanced later)
   */
  static validateToolArguments(
    toolName: string,
    args: Record<string, any>,
    mcpTools: MCPTool[]
  ): { valid: boolean; error?: string } {
    const tool = mcpTools.find((t) => t.name === toolName);
    if (!tool) {
      return { valid: false, error: 'Tool not found' };
    }

    const schema = tool.inputSchema;
    const required = schema.required || [];

    // Check required fields
    for (const field of required) {
      if (!(field in args)) {
        return { valid: false, error: `Missing required field: ${field}` };
      }
    }

    return { valid: true };
  }
}

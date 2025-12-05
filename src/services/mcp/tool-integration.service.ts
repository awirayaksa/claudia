import { MCPTool } from '../../types/mcp.types';
import { ToolCall, ToolResult } from '../../types/message.types';
import { OpenAITool } from '../../types/api.types';
import { RootState } from '../../store';

/**
 * Tool Integration Service
 *
 * Handles conversion between MCP tools and OpenAI function calling format,
 * and orchestrates tool execution through the Electron IPC layer.
 */
export class ToolIntegrationService {
  /**
   * Convert MCP tools to OpenAI function calling format
   */
  static mcpToolsToOpenAI(mcpTools: MCPTool[]): OpenAITool[] {
    return mcpTools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  /**
   * Find which server has a specific tool
   */
  private static findServerForTool(toolName: string, mcpState: RootState['mcp']): string | null {
    for (const [serverId, serverState] of Object.entries(mcpState.serverStates)) {
      if (serverState.status === 'ready' && serverState.tools) {
        const hasTool = serverState.tools.some((tool) => tool.name === toolName);
        if (hasTool) {
          return serverId;
        }
      }
    }
    return null;
  }

  /**
   * Execute a single tool call with timeout
   */
  static async executeToolCall(
    toolCall: ToolCall,
    mcpState: RootState['mcp']
  ): Promise<ToolResult> {
    const toolName = toolCall.function.name;
    const serverId = this.findServerForTool(toolName, mcpState);
    const TOOL_TIMEOUT_MS = 30000; // 30 seconds

    if (!serverId) {
      console.error(`[Tool Integration] Tool "${toolName}" not found in any ready server`);
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
        console.error(`[Tool Integration] Failed to parse arguments for ${toolName}:`, parseError);
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

      console.log(`[Tool Integration] Executing ${toolName} with args:`, args);

      // Execute tool with timeout
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Tool execution timeout')), TOOL_TIMEOUT_MS)
      );

      const executionPromise = window.electron.mcp.callTool(serverId, toolName, args);

      const response = await Promise.race([executionPromise, timeoutPromise]);

      if (!response.success) {
        console.error(`[Tool Integration] Tool ${toolName} execution failed:`, response.error);
        return {
          tool_call_id: toolCall.id,
          role: 'tool',
          name: toolName,
          content: JSON.stringify({
            error: `Tool execution failed: ${response.error || 'Unknown error'}`,
          }),
          isError: true,
        };
      }

      console.log(`[Tool Integration] Tool ${toolName} executed successfully`);

      // Return successful result
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name: toolName,
        content: JSON.stringify(response.result),
        isError: false,
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'Tool execution timeout') {
        console.error(`[Tool Integration] Tool ${toolName} timed out after ${TOOL_TIMEOUT_MS}ms`);
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

      console.error(`[Tool Integration] Unexpected error executing ${toolName}:`, error);
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
    mcpState: RootState['mcp']
  ): Promise<ToolResult[]> {
    const results = await Promise.all(
      toolCalls.map((toolCall) => this.executeToolCall(toolCall, mcpState))
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

import { MCPTool, UIResourceContent } from '../../types/mcp.types';
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
        description: tool.description || '', // Provide empty string as fallback
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
   * Check if content item is a UI resource
   * A resource is considered a UI resource if URI starts with 'ui://'
   */
  private static isUIResource(content: any): boolean {
    if (content.type !== 'resource') {
      return false;
    }

    const uri = content.resource?.uri || '';
    return uri.startsWith('ui://');
  }

  /**
   * Extract UI resource from content array
   */
  private static extractUIResource(contentArray: any[]): UIResourceContent | null {
    for (const item of contentArray) {
      if (this.isUIResource(item)) {
        return item.resource;
      }
    }
    return null;
  }

  /**
   * Extract text content from content array (ignoring UI resources)
   */
  private static extractTextContent(contentArray: any[]): string {
    const textItems = contentArray
      .filter((item: any) => item.type === 'text')
      .map((item: any) => item.text);

    return textItems.length > 0 ? textItems.join('\n') : '';
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

      // Execute tool with timeout
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Tool execution timeout')), TOOL_TIMEOUT_MS)
      );

      const executionPromise = window.electron.mcp.callTool(serverId, toolName, args);

      const response = await Promise.race([executionPromise, timeoutPromise]);

      // Check if the IPC call itself failed
      if (!response.success) {
        console.error(`[Tool Integration] Tool ${toolName} IPC call failed:`, response.error);
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

      // Check if the tool execution itself had an error
      const toolResult = response.result;
      if (toolResult.isError) {
        console.error(`[Tool Integration] Tool ${toolName} returned error:`, toolResult.content);
        return {
          tool_call_id: toolCall.id,
          role: 'tool',
          name: toolName,
          content: toolResult.content.map((c: any) => c.text || JSON.stringify(c)).join('\n'),
          isError: true,
        };
      }

      // Extract text content and UI resource separately
      const textContent = this.extractTextContent(toolResult.content);
      const uiResource = this.extractUIResource(toolResult.content);

      if (uiResource) {
        // Return BOTH text and UI resource
        return {
          tool_call_id: toolCall.id,
          role: 'tool',
          name: toolName,
          content: textContent || `[Interactive UI: ${uiResource.uri}]`,  // Text for LLM
          isError: false,
          hasUI: true,
          uiResource: uiResource,  // UI for rendering
        };
      } else {
        // Convert content array to string (existing behavior)
        const contentString = toolResult.content.map((c: any) => {
          if (c.type === 'text') {
            return c.text;
          } else if (c.type === 'image') {
            return `[Image: ${c.mimeType || 'unknown'}]`;
          } else if (c.type === 'resource') {
            // Extract text content from resource if available
            if (c.resource?.text) {
              return c.resource.text;
            }
            // Fallback to URI or mimeType
            return `[Resource: ${c.resource?.uri || c.mimeType || 'unknown'}]`;
          }
          return JSON.stringify(c);
        }).join('\n');

        return {
          tool_call_id: toolCall.id,
          role: 'tool',
          name: toolName,
          content: contentString,
          isError: false,
          hasUI: false,
        };
      }
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

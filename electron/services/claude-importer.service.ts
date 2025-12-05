import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import { MCPServerConfig } from '../../src/types/mcp.types';

// ============================================================================
// Claude Desktop Config Structure
// ============================================================================

interface ClaudeDesktopConfig {
  mcpServers?: Record<
    string,
    {
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  >;
}

// ============================================================================
// Platform-Specific Config Paths
// ============================================================================

function getClaudeDesktopConfigPath(): string {
  const platform = process.platform;

  switch (platform) {
    case 'darwin': // macOS
      return path.join(
        app.getPath('home'),
        'Library',
        'Application Support',
        'Claude',
        'claude_desktop_config.json'
      );

    case 'win32': // Windows
      return path.join(
        app.getPath('appData'),
        'Claude',
        'claude_desktop_config.json'
      );

    case 'linux': // Linux
      return path.join(
        app.getPath('home'),
        '.config',
        'Claude',
        'claude_desktop_config.json'
      );

    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

// ============================================================================
// Import Function
// ============================================================================

export async function importClaudeDesktopConfig(): Promise<MCPServerConfig[]> {
  const configPath = getClaudeDesktopConfigPath();

  // Check if config file exists
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Claude Desktop configuration file not found at: ${configPath}\n\n` +
        'Please ensure Claude Desktop is installed and configured with MCP servers.'
    );
  }

  try {
    // Read and parse config file
    const content = fs.readFileSync(configPath, 'utf-8');
    const config: ClaudeDesktopConfig = JSON.parse(content);

    if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) {
      throw new Error(
        'No MCP servers found in Claude Desktop configuration.\n\n' +
          'Please configure MCP servers in Claude Desktop first:\n' +
          'Settings > Developer > Edit Config'
      );
    }

    // Convert to Claudia format
    const servers: MCPServerConfig[] = [];

    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      try {
        servers.push({
          id: uuidv4(),
          name: name,
          command: serverConfig.command,
          args: serverConfig.args || [],
          env: serverConfig.env || {},
          transport: 'stdio', // Claude Desktop uses stdio
          enabled: true,
          metadata: {
            description: `Imported from Claude Desktop on ${new Date().toLocaleDateString()}`,
          },
        });
      } catch (error) {
        console.error(
          `[Claude Importer] Failed to import server "${name}":`,
          error
        );
        // Continue with other servers even if one fails
      }
    }

    if (servers.length === 0) {
      throw new Error('Failed to import any servers from Claude Desktop configuration.');
    }

    console.log(
      `[Claude Importer] Successfully imported ${servers.length} server(s):`,
      servers.map((s) => s.name).join(', ')
    );

    return servers;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Invalid JSON in Claude Desktop configuration file:\n${error.message}\n\n` +
          `File location: ${configPath}`
      );
    }
    throw error;
  }
}

// ============================================================================
// Config Validation
// ============================================================================

export function validateClaudeDesktopConfig(configPath?: string): {
  valid: boolean;
  exists: boolean;
  path: string;
  error?: string;
} {
  const path = configPath || getClaudeDesktopConfigPath();

  if (!fs.existsSync(path)) {
    return {
      valid: false,
      exists: false,
      path,
      error: 'Configuration file does not exist',
    };
  }

  try {
    const content = fs.readFileSync(path, 'utf-8');
    const config: ClaudeDesktopConfig = JSON.parse(content);

    if (!config.mcpServers) {
      return {
        valid: false,
        exists: true,
        path,
        error: 'No mcpServers section found in configuration',
      };
    }

    return {
      valid: true,
      exists: true,
      path,
    };
  } catch (error) {
    return {
      valid: false,
      exists: true,
      path,
      error: error instanceof Error ? error.message : 'Failed to parse configuration',
    };
  }
}

// ============================================================================
// Export Config Path (for display in UI)
// ============================================================================

export function getConfigPath(): string {
  return getClaudeDesktopConfigPath();
}

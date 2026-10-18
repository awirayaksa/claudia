import { useCallback } from 'react';
import { UIResourceRenderer, getUIResourceMetadata, basicComponentLibrary } from '@mcp-ui/client';
import type { UIActionResult } from '@mcp-ui/client';
import { UIResourceContent } from '../../types/mcp.types';
import { getPlatform } from '../../platform';

interface UIResourceDisplayProps {
  resource: UIResourceContent;
  toolCallId: string;
  toolName: string;
}

export function UIResourceDisplay({
  resource,
  toolCallId,
  toolName
}: UIResourceDisplayProps) {
  // iframe settings come from the host; the web app renders from a separate sandbox origin
  const { uiSandbox, tools } = getPlatform();

  // Extract MCP-UI specific metadata
  const metadata = getUIResourceMetadata(resource);
  const preferredSize = metadata?.['mcpui.dev/ui-preferred-frame-size'] as [string, string] | undefined;
  const initialRenderData = (metadata?.['mcpui.dev/ui-initial-render-data'] as Record<string, any>) || {};

  // Merge metadata with application-level context
  const iframeRenderData = {
    ...initialRenderData,  // Server-provided initialization data
    toolName,              // Tool context
    toolCallId,            // Unique identifier
    // Could add: theme, locale, user preferences, etc.
  };

  const handleUIAction = useCallback(async (result: UIActionResult) => {
    console.log('[UI Action]', { uri: resource.uri, result });

    // Handle all MCP-UI action types according to SDK specification
    switch (result.type) {
      case 'tool':
        // Run the tool through the host; the result replaces the original tool result
        tools
          .uiAction({
            uri: resource.uri,
            toolName: result.payload.toolName,
            params: result.payload.params,
            originalToolCallId: toolCallId,
          })
          .catch((error) => console.error('[UI Action] Tool call failed:', error));
        return { status: 'handled' };

      case 'link':
        // Open external link in new tab
        if (result.payload.url) {
          window.open(result.payload.url, '_blank', 'noopener,noreferrer');
          return { status: 'handled' };
        }
        return { status: 'unhandled', reason: 'No URL provided for link action' };

      case 'notify':
        // Show notification to user (using console for now, could integrate with toast system)
        if (result.payload.message) {
          console.info('[MCP-UI Notification]', result.payload.message);
          // TODO: Integrate with application notification system (e.g., toast)
          return { status: 'handled' };
        }
        return { status: 'unhandled', reason: 'No message provided for notify action' };

      case 'prompt':
        // Prompt actions - not yet implemented in application
        console.log('[UI Action] Prompt action received but not implemented:', result.payload);
        return { status: 'unhandled', reason: 'Prompt actions not yet implemented' };

      case 'intent':
        // Intent actions - not yet implemented in application
        console.log('[UI Action] Intent action received but not implemented:', result.payload);
        return { status: 'unhandled', reason: 'Intent actions not yet implemented' };

      default:
        console.warn('[UI Action] Unknown action type:', (result as any).type);
        return { status: 'unhandled', reason: 'Unknown action type' };
    }
  }, [resource.uri, toolCallId, tools]);

  return (
    <div className="w-full rounded-lg border border-border bg-surface overflow-hidden shadow-sm">
      <div className="px-3 py-2 text-xs font-medium text-text-secondary bg-surface border-b border-border">
        🎨 Interactive UI: {toolName}
      </div>
      <div className="w-full overflow-hidden">
        <UIResourceRenderer
          resource={resource}
          onUIAction={handleUIAction}
          htmlProps={{
            sandboxPermissions: uiSandbox.sandboxPermissions,
            proxy: uiSandbox.proxyUrl,
            // Metadata-driven frame sizing - server can specify preferred dimensions
            style: preferredSize ? {
              width: preferredSize[0],
              height: preferredSize[1]
            } : undefined,
            // Only auto-resize if server didn't specify size preferences
            autoResizeIframe: !preferredSize ? { height: true, width: false } : false,
            // Pass initialization data to iframe
            iframeRenderData,
          }}
          // Remote DOM support for application/vnd.mcp-ui.remote-dom resources
          remoteDomProps={{
            library: basicComponentLibrary,
          }}
        />
      </div>
    </div>
  );
}

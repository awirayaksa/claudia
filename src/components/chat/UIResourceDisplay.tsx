import { useCallback } from 'react';
import { UIResourceRenderer } from '@mcp-ui/client';
import type { UIActionResult } from '@mcp-ui/client';
import { UIResourceContent } from '../../types/mcp.types';
import { useAppDispatch } from '../../store';
import { executeUIAction } from '../../store/slices/chatSlice';

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
  const dispatch = useAppDispatch();

  const handleUIAction = useCallback(async (result: UIActionResult) => {
    console.log('[UI Action]', { uri: resource.uri, result });

    // Handle different action types
    if (result.type === 'tool') {
      dispatch(executeUIAction({
        uri: resource.uri,
        toolName: result.payload.toolName,
        action: result.payload.toolName,
        data: result.payload.params,
        originalToolCallId: toolCallId,
      }));
    } else {
      console.log('[UI Action] Non-tool action type:', result.type);
      // Could handle other action types (prompt, link, intent, notify) here
    }
  }, [resource.uri, toolCallId, dispatch]);

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
            sandboxPermissions: 'allow-scripts allow-forms allow-same-origin allow-popups',
            autoResizeIframe: { height: true, width: false },
          }}
        />
      </div>
    </div>
  );
}

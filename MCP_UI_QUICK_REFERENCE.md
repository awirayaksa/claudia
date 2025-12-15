# MCP-UI Quick Reference Guide

## What is MCP-UI?

MCP-UI allows MCP tool servers to return interactive HTML components that render in the chat interface. Think buttons, forms, charts, etc.

## Quick Start

### 1. Server Side (Creating UI Tools)

```typescript
import { createUIResource } from '@mcp-ui/server';

// Tool handler
case 'show_ui':
  return {
    content: [
      { type: 'text', text: 'Description for LLM' },
      createUIResource({
        uri: 'ui://my-app/component',  // Must start with ui://
        content: {
          type: 'rawHtml',
          htmlString: `
            <div>
              <button onclick="window.parent.postMessage({
                type: 'tool',
                payload: { toolName: 'handle_action', params: { action: 'click' } }
              }, '*')">Click Me</button>
            </div>
          `
        },
        encoding: 'text',
      })
    ]
  };
```

### 2. Client Side (Rendering)

UI resources are automatically detected and rendered when:
- Content has `type: 'resource'`
- Resource URI starts with `ui://`

## Architecture

```
MCP Server → Tool Result → Electron IPC → Tool Integration Service
    ↓
Detects ui:// URI
    ↓
Extracts:
├─ Text content → Sent to LLM
└─ UI resource → Rendered in iframe
    ↓
User interacts → postMessage → executeUIAction
    ↓
Updates UI with new result
```

## Key Files

| File | Purpose |
|------|---------|
| `tool-integration.service.ts` | Detects UI resources, extracts content |
| `chatSlice.ts` | Manages LLM context, handles UI actions |
| `ChatMessage.tsx` | Renders UI in separate full-width row |
| `UIResourceDisplay.tsx` | Wraps UIResourceRenderer |
| `ToolCallMessage.tsx` | Shows tool status, auto-expands for UI |

## Important Patterns

### 1. Button Actions

```html
<button onclick="window.parent.postMessage({
  type: 'tool',
  payload: {
    toolName: 'your_tool_name',
    params: { your: 'data' }
  }
}, '*')">Button Text</button>
```

### 2. Form Submission

```html
<form id="myForm">
  <input type="text" id="name">
  <button type="submit">Submit</button>
</form>
<script>
  document.getElementById('myForm').addEventListener('submit', (e) => {
    e.preventDefault();
    window.parent.postMessage({
      type: 'tool',
      payload: {
        toolName: 'form_handler',
        params: { name: document.getElementById('name').value }
      }
    }, '*');
  });
</script>
```

### 3. Dynamic Resizing

```javascript
function sendSizeUpdate() {
  window.parent.postMessage({
    type: 'ui-size-change',
    payload: {
      height: document.documentElement.scrollHeight,
      width: document.documentElement.scrollWidth
    }
  }, '*');
}

// On load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', sendSizeUpdate);
} else {
  sendSizeUpdate();
}

// On changes
new ResizeObserver(() => sendSizeUpdate())
  .observe(document.documentElement);
```

## Critical Implementation Details

### 1. Resource Text Extraction

```typescript
// ✅ CORRECT
if (c.resource?.text) {
  return c.resource.text;
}

// ❌ WRONG
return `[Resource: ${c.mimeType || 'unknown'}]`;
```

### 2. UI Resource Detection

```typescript
// ✅ CORRECT - Check URI only
return content.resource?.uri?.startsWith('ui://');

// ❌ WRONG - Don't check MIME types
return uri.startsWith('ui://') || mimeTypes.includes(mimeType);
```

### 3. LLM Context

```typescript
// ✅ CORRECT - Send confirmation
if (result.hasUI) {
  contentString = `Interactive UI component displayed successfully. The user can now interact with the ${result.name} interface.`;
}

// ❌ WRONG - Send HTML
contentString = result.uiResource.text;  // LLM doesn't understand HTML
```

### 4. Tool Call ID Matching

```typescript
// ✅ CORRECT - Override to match original
const updatedResult: ToolResult = {
  ...result,
  tool_call_id: originalToolCallId,  // Use original ID!
};

// ❌ WRONG - Keep new ID
return result;  // Won't update UI
```

## Security

### Sandbox Permissions

```typescript
sandboxPermissions: 'allow-scripts allow-forms allow-same-origin allow-popups'
```

**Risks**:
- `allow-same-origin` + `allow-scripts` = Full parent DOM access
- Only load trusted MCP servers!

## Debugging Checklist

- [ ] URI starts with `ui://`?
- [ ] ResizeObserver script included?
- [ ] Sandbox permissions set?
- [ ] Tool name in postMessage matches registered tool?
- [ ] Tool call ID preserved in executeUIAction?
- [ ] Text content extracted for LLM?
- [ ] UI resource stored in Redux?

## Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| Shows "[Resource: unknown]" | Text not extracted | Check `c.resource?.text` |
| Infinite tool loop | UI sent to LLM | Send confirmation text instead |
| "Executing..." stuck | ID mismatch | Override tool_call_id |
| Form blocked | Missing permission | Add `allow-forms` |
| Iframe too small | No resize script | Add ResizeObserver |
| Button doesn't work | Missing permission | Add `allow-scripts` |

## Testing Commands

```bash
# Start test server
cd test-mcp-server && npm start

# Configure in Claudia
# Name: test-ui-server
# Transport: HTTP
# URL: http://localhost:3000/mcp

# Test messages
"show me a counter"
"show me a contact form"
```

## Example: Complete Counter Implementation

**Server (`test-mcp-server/index.ts`)**:
```typescript
case 'show_counter':
  return {
    content: [
      { type: 'text', text: `Counter at ${state.counter}` },
      getCounterUI(state.counter)
    ]
  };

case 'counter_action':
  const { action } = args;
  if (action === 'increment') state.counter++;
  else if (action === 'decrement') state.counter--;
  else if (action === 'reset') state.counter = 0;

  return {
    content: [
      { type: 'text', text: `Counter ${action}ed to ${state.counter}` },
      getCounterUI(state.counter)
    ]
  };
```

**Template (`test-mcp-server/ui-templates.ts`)**:
```typescript
export function getCounterUI(count: number) {
  return createUIResource({
    uri: 'ui://counter/main',
    content: {
      type: 'rawHtml',
      htmlString: `
        <div style="padding: 20px;">
          <h2>Count: ${count}</h2>
          <button onclick="window.parent.postMessage({
            type: 'tool',
            payload: { toolName: 'counter_action', params: { action: 'increment' } }
          }, '*')">+</button>
          <button onclick="window.parent.postMessage({
            type: 'tool',
            payload: { toolName: 'counter_action', params: { action: 'decrement' } }
          }, '*')">-</button>
        </div>
        ${getResizeScript()}
      `
    },
    encoding: 'text'
  });
}
```

## Resources

- Full Documentation: `CHANGELOG_MCP_UI_IMPLEMENTATION.md`
- MCP-UI Docs: https://mcpui.dev/
- Example Server: `test-mcp-server/`

# MCP-UI Test Server

A simple MCP server demonstrating MCP-UI functionality for testing with Claudia.

## Features

1. **Interactive Counter** - Increment/decrement/reset counter with buttons
2. **Contact Form** - Fill out and submit a form with validation

## Installation

```bash
cd test-mcp-server
npm install
```

## Usage

### Start the Server

Start the TypeScript server using `tsx`:

```bash
cd test-mcp-server
npm start
```

Or use watch mode for development:

```bash
npm run dev
```

The server will run on `http://localhost:3000` by default. You should see:
```
MCP UI Test Server running on http://localhost:3000
MCP endpoint: http://localhost:3000/mcp
Health check: http://localhost:3000/health
MCP server connected to StreamableHTTP transport
```

> **Note**: This server is written in TypeScript and uses `tsx` to run directly without compilation.

### Add to Claudia's MCP Configuration

1. Open Claudia
2. Go to **Settings** > **MCP Servers**
3. Click **"Add Server"**
4. Configure:
   - **Name**: `MCP-UI Test`
   - **Transport**: `http` (Streamable HTTP)
   - **URL**: `http://localhost:3000/mcp`
5. Click **"Save"**
6. Ensure the HTTP server is running (see above)
7. Click **"Start"** to connect to the server

**Note**: This server uses the official `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk` for stateless HTTP communication.

### Test the Counter

In Claudia chat, type:
```
Show me a counter
```

Then click the **Increment**/**Decrement**/**Reset** buttons in the UI.

### Test the Form

In Claudia chat, type:
```
Show me a form
```

Fill out the form and click **Submit**.

## How It Works

1. User requests a UI component via chat
2. Claudia sends tool call request to server via HTTP POST to `/mcp`
3. Server processes request using `StreamableHTTPServerTransport`
4. Server returns a tool result with `ui://` resource
5. Claudia renders the HTML in a sandboxed iframe
6. User interacts with buttons/forms
7. Actions trigger new tool calls back to the server
8. Server returns updated UI

## Available Tools

### `show_counter`
Displays an interactive counter with increment/decrement/reset buttons.

**Parameters:** None

**Returns:** UI component with current counter value

### `counter_action`
Handles counter button clicks.

**Parameters:**
- `action` (string): One of `increment`, `decrement`, `reset`

**Returns:** Updated counter UI

### `show_form`
Displays a contact form with name, email, and message fields.

**Parameters:** None

**Returns:** Form UI component

### `form_submit`
Handles form submission.

**Parameters:**
- `name` (string): Contact name
- `email` (string): Contact email
- `message` (string): Message text

**Returns:** Confirmation UI

## Expected Behavior

### Counter Flow
```
User: "show me a counter"
  → Server returns counter UI (count: 0)
  → User sees counter with buttons
  → User clicks "Increment"
  → counter_action tool called with { action: 'increment' }
  → Server returns updated UI (count: 1)
  → UI re-renders showing new count
```

### Form Flow
```
User: "show me a form"
  → Server returns form UI
  → User fills name/email/message
  → User clicks Submit
  → form_submit tool called with form data
  → Server logs submission and returns confirmation UI
  → UI shows success message with "Submit Another" button
```

## Technical Details

### TypeScript Implementation

This server is written in **TypeScript** with proper type definitions:

- **Runtime**: Uses `tsx` to run TypeScript directly without compilation
- **Type Safety**: Full type definitions for all MCP server components
- **UI Resources**: Uses `createUIResource` from `@mcp-ui/server` for type-safe UI resource creation

Example UI resource creation:

```typescript
import { createUIResource } from '@mcp-ui/server';

export function getCounterUI(count: number = 0) {
  const html = `<div>Counter: ${count}</div>`;

  return createUIResource({
    uri: 'ui://counter/main',
    content: { type: 'inlineHtml', html },
    encoding: 'text',
  });
}
```

### Transport Implementation

This server uses `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk`:

```typescript
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined, // stateless server
});

await server.connect(transport);
await transport.handleRequest(req, res, req.body);
```

The transport handles all MCP protocol communication (initialize, tools/list, tools/call) via HTTP POST requests to `/mcp`.

### UI Resource Structure

The server returns UI resources with this structure:

```javascript
{
  type: 'resource',
  resource: {
    uri: 'ui://component-name/id',  // Must start with ui://
    mimeType: 'text/html',           // MIME type
    text: '<html>...</html>'         // HTML content
  }
}
```

### UI Actions

User interactions in the UI trigger tool calls via `window.parent.postMessage`:

```javascript
window.parent.postMessage({
  type: 'tool',
  payload: {
    toolName: 'counter_action',
    params: { action: 'increment' }
  }
}, '*');
```

Claudia intercepts these messages and sends them as tool calls back to the MCP server via HTTP POST.

## Troubleshooting

### Server won't start
- Check that `@modelcontextprotocol/sdk` is installed: `npm install`
- Verify Node.js version is 18 or higher: `node --version`

### UI doesn't display
- Check the chat for error messages
- Verify the server is in "Ready" state in MCP Settings
- Check that the tool call succeeded (should show green checkmark)

### Button clicks don't work
- Open browser DevTools (if supported) to check for console errors
- Verify that UI actions are triggering tool calls (check logs)
- Ensure sandboxed iframes allow postMessage

### Form submission fails
- Check that all required fields are filled
- Verify email format is valid
- Check server logs (console.error) for form data

## Next Steps

After testing this server, you can:
1. Modify the HTML templates to experiment with different UI designs
2. Add new tools with different UI components
3. Try other MIME types: `text/uri-list` or `application/vnd.mcp-ui.remote-dom`
4. Build a real application using MCP-UI patterns

## License

MIT

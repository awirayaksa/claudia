# MCP-UI Architecture Diagrams

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                          Claudia UI                              │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    Chat Interface                         │  │
│  │  ┌─────────────────────────────────────────────────────┐ │  │
│  │  │  Message Bubble (max-width: 70%)                    │ │  │
│  │  │  • User/Assistant text content                      │ │  │
│  │  │  • Tool call status (✓ Success / ⏳ Executing)     │ │  │
│  │  └─────────────────────────────────────────────────────┘ │  │
│  │                                                           │  │
│  │  ┌─────────────────────────────────────────────────────┐ │  │
│  │  │  UI Resources Row (full-width)                      │ │  │
│  │  │  ┌───────────────────────────────────────────────┐  │ │  │
│  │  │  │ UIResourceDisplay                             │  │ │  │
│  │  │  │  ┌─────────────────────────────────────────┐  │  │ │  │
│  │  │  │  │ <iframe sandbox="...">                  │  │  │ │  │
│  │  │  │  │   [Interactive HTML Content]            │  │  │ │  │
│  │  │  │  │   • Buttons, Forms, Charts, etc.        │  │  │ │  │
│  │  │  │  └─────────────────────────────────────────┘  │  │ │  │
│  │  │  └───────────────────────────────────────────────┘  │ │  │
│  │  └─────────────────────────────────────────────────────┘ │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Component Hierarchy

```
App
 └─ ChatInterface
     └─ MessageList
         └─ ChatMessage (for each message)
             ├─ Message Bubble
             │   ├─ Text Content
             │   └─ ToolCallMessage (for each tool call)
             │       ├─ Tool Name & Status
             │       ├─ Arguments (collapsed)
             │       └─ Result (text only, hideUIResource=true)
             │
             └─ UI Resources Row
                 └─ UIResourceDisplay (for each UI resource)
                     └─ UIResourceRenderer (@mcp-ui/client)
                         └─ <iframe> with HTML content
```

## Data Flow: Tool Call with UI

```
┌────────────┐
│    User    │
│  "show me  │
│ a counter" │
└─────┬──────┘
      │
      ▼
┌────────────────────┐
│  Chat Component    │
│  (sendMessage)     │
└─────┬──────────────┘
      │
      ▼
┌────────────────────────────┐
│     LLM (Claude API)       │
│  Analyzes: needs tool call │
└─────┬──────────────────────┘
      │
      ▼
┌────────────────────────────────┐
│ Tool Call Request              │
│ {                              │
│   name: "show_counter",        │
│   arguments: "{}"              │
│ }                              │
└─────┬──────────────────────────┘
      │
      ▼
┌─────────────────────────────────────┐
│  Tool Integration Service           │
│  executeToolCall()                  │
└─────┬───────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────┐
│  Electron IPC                       │
│  window.electron.mcp.callTool()     │
└─────┬───────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────┐
│  Main Process (Electron)            │
│  mcp.service.ts                     │
└─────┬───────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────┐
│  MCP Server (HTTP)                  │
│  http://localhost:3000/mcp          │
│                                     │
│  Tool Handler:                      │
│  case 'show_counter':               │
│    return {                         │
│      content: [                     │
│        {                            │
│          type: 'text',              │
│          text: 'Counter at 0'       │
│        },                           │
│        {                            │
│          type: 'resource',          │
│          resource: {                │
│            uri: 'ui://counter',     │
│            text: '<div>HTML</div>'  │
│          }                          │
│        }                            │
│      ]                              │
│    }                                │
└─────┬───────────────────────────────┘
      │
      │ Response
      ▼
┌─────────────────────────────────────┐
│  Electron IPC (Response)            │
│  Serializes result                  │
│  ✅ Includes resource field         │
└─────┬───────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────┐
│  Tool Integration Service           │
│  executeToolCall() returns:         │
│                                     │
│  Extracts:                          │
│  ├─ textContent ← extractText()     │
│  │   "Counter at 0"                 │
│  │                                  │
│  └─ uiResource ← extractUIResource()│
│      { uri: 'ui://counter', ... }   │
│                                     │
│  Returns ToolResult:                │
│  {                                  │
│    content: "Counter at 0",         │
│    hasUI: true,                     │
│    uiResource: { uri: '...' }       │
│  }                                  │
└─────┬───────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────┐
│  Chat Slice (Redux)                     │
│  sendStreamingMessageWithTools          │
│                                         │
│  For LLM context:                       │
│  ├─ Add to messages array:              │
│  │   {                                  │
│  │     role: 'tool',                    │
│  │     content: "Interactive UI         │
│  │               component displayed"   │
│  │   }                                  │
│  │                                      │
│  └─ Store in Redux:                     │
│      Message with toolResults containing│
│      full uiResource object             │
└─────┬───────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────┐
│  Chat Component Re-renders              │
│                                         │
│  ChatMessage receives message with:     │
│  • content: "Counter at 0"              │
│  • toolResults: [                       │
│      {                                  │
│        hasUI: true,                     │
│        uiResource: { uri: '...', ... }  │
│      }                                  │
│    ]                                    │
└─────┬───────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────┐
│  Message Bubble                         │
│  • Shows: "Counter at 0"                │
│  • Tool call: ✓ Success                 │
└─────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────┐
│  UI Resources Row                       │
│  UIResourceDisplay renders:             │
│                                         │
│  <UIResourceRenderer                    │
│    resource={uiResource}                │
│    onUIAction={handleUIAction}          │
│    htmlProps={{                         │
│      sandboxPermissions: "...",         │
│      autoResizeIframe: { height: true } │
│    }}                                   │
│  />                                     │
└─────┬───────────────────────────────────┘
      │
      ▼
┌────────────┐
│   <iframe> │
│            │
│  [Counter] │
│  Count: 0  │
│  [+] [-]   │
└────────────┘
```

## Data Flow: Button Click (UI Action)

```
┌────────────┐
│    User    │
│  clicks    │
│    [+]     │
└─────┬──────┘
      │
      ▼
┌────────────────────────────────────────┐
│  Button onclick handler (in iframe)    │
│                                        │
│  window.parent.postMessage({          │
│    type: 'tool',                      │
│    payload: {                         │
│      toolName: 'counter_action',      │
│      params: { action: 'increment' }  │
│    }                                  │
│  }, '*')                              │
└─────┬──────────────────────────────────┘
      │
      ▼
┌────────────────────────────────────────┐
│  UIResourceRenderer (@mcp-ui/client)   │
│  Listens for postMessage               │
│                                        │
│  onMessage(event) {                    │
│    if (event.data.type === 'tool') {   │
│      onUIAction(event.data)            │
│    }                                   │
│  }                                     │
└─────┬──────────────────────────────────┘
      │
      ▼
┌────────────────────────────────────────┐
│  UIResourceDisplay                     │
│  handleUIAction() callback             │
│                                        │
│  dispatch(executeUIAction({           │
│    toolName: 'counter_action',        │
│    data: { action: 'increment' },     │
│    originalToolCallId: 'abc123'       │
│  }))                                  │
└─────┬──────────────────────────────────┘
      │
      ▼
┌────────────────────────────────────────┐
│  Chat Slice (Redux Thunk)              │
│  executeUIAction                       │
│                                        │
│  1. Create tool call:                  │
│     {                                  │
│       id: uuidv4(),  // temporary      │
│       function: {                      │
│         name: 'counter_action',        │
│         arguments: '{"action": "..."}'  │
│       }                                │
│     }                                  │
│                                        │
│  2. Execute via Tool Integration       │
│                                        │
│  3. Get result with new ID             │
│                                        │
│  4. Override ID to match original:     │
│     result.tool_call_id = 'abc123'     │
│                                        │
│  5. Update message.toolResults         │
└─────┬──────────────────────────────────┘
      │
      ▼
┌────────────────────────────────────────┐
│  Component Re-renders                  │
│  UIResourceDisplay receives updated    │
│  resource with new count               │
└─────┬──────────────────────────────────┘
      │
      ▼
┌────────────┐
│   <iframe> │
│            │
│  [Counter] │
│  Count: 1  │ ← Updated!
│  [+] [-]   │
└────────────┘
```

## Key Components Deep Dive

### 1. Tool Integration Service

```typescript
┌──────────────────────────────────────────────────────┐
│         ToolIntegrationService                       │
├──────────────────────────────────────────────────────┤
│                                                      │
│  executeToolCall(toolCall, mcpState)                │
│    ├─ Find server                                   │
│    ├─ Execute via IPC                               │
│    ├─ Extract text: extractTextContent()            │
│    ├─ Extract UI: extractUIResource()               │
│    └─ Return:                                       │
│        {                                            │
│          content: string,      // For LLM          │
│          hasUI: boolean,                           │
│          uiResource?: object   // For rendering    │
│        }                                            │
│                                                      │
│  isUIResource(content)                              │
│    └─ Check: uri.startsWith('ui://')               │
│                                                      │
│  extractUIResource(contentArray)                    │
│    ├─ Loop through items                           │
│    ├─ Find first with type='resource'              │
│    └─ Return resource if uri starts with 'ui://'   │
│                                                      │
│  extractTextContent(contentArray)                   │
│    ├─ Filter items with type='text'                │
│    └─ Join text fields with '\n'                   │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### 2. Chat Slice State Management

```typescript
┌────────────────────────────────────────────────────┐
│              Chat Slice State                      │
├────────────────────────────────────────────────────┤
│                                                    │
│  messages: Message[]                               │
│    └─ Each message contains:                       │
│        {                                           │
│          id: string,                               │
│          role: 'user' | 'assistant' | 'tool',      │
│          content: string,                          │
│          toolCalls?: ToolCall[],                   │
│          toolResults?: ToolResult[],               │
│            └─ [{                                   │
│                 tool_call_id: string,              │
│                 content: string,      // For LLM   │
│                 hasUI?: boolean,                   │
│                 uiResource?: {        // For UI    │
│                   uri: string,                     │
│                   text: string,                    │
│                   mimeType: string                 │
│                 }                                  │
│               }]                                   │
│        }                                           │
│                                                    │
│  isExecutingTools: boolean                         │
│  pendingToolCalls: ToolCall[]                      │
│                                                    │
├────────────────────────────────────────────────────┤
│              Key Thunks                            │
├────────────────────────────────────────────────────┤
│                                                    │
│  sendStreamingMessageWithTools()                   │
│    ├─ Call LLM with tools                         │
│    ├─ Get tool calls from response                │
│    ├─ Execute tools                               │
│    ├─ For each result:                            │
│    │   ├─ If hasUI:                               │
│    │   │   └─ Send confirmation to LLM           │
│    │   └─ Else:                                   │
│    │       └─ Send full content to LLM           │
│    └─ Loop until no more tool calls               │
│                                                    │
│  executeUIAction()                                 │
│    ├─ Create tool call with temporary ID          │
│    ├─ Execute tool                                │
│    ├─ Override result.tool_call_id                │
│    └─ Update message.toolResults                  │
│                                                    │
└────────────────────────────────────────────────────┘
```

### 3. Message Rendering Flow

```
ChatMessage Component
├─ Props: message
│
├─ Render Message Bubble
│   ├─ User/Assistant label
│   ├─ Text content
│   └─ For each toolCall:
│       └─ ToolCallMessage
│           ├─ Props: toolCall, result, hideUIResource=true
│           ├─ Shows: Name, Status (✓/⏳/✗), Arguments
│           └─ Result: Text only (UI hidden)
│
└─ Render UI Resources Row (if any)
    └─ Filter: toolResults.filter(r => r.hasUI)
        └─ For each UI result:
            └─ UIResourceDisplay
                ├─ Props: resource, toolCallId, toolName
                └─ Renders: UIResourceRenderer
                    ├─ Props: resource, onUIAction, htmlProps
                    └─ Creates: <iframe> with HTML
```

## Security Model

```
┌─────────────────────────────────────────────────┐
│              Parent Window                      │
│              (Claudia App)                      │
│  ┌───────────────────────────────────────────┐  │
│  │                                           │  │
│  │  <iframe sandbox="                        │  │
│  │    allow-scripts                          │  │
│  │    allow-forms                            │  │
│  │    allow-same-origin    ⚠️  RISKY!       │  │
│  │    allow-popups                           │  │
│  │  ">                                       │  │
│  │    ┌──────────────────────────────────┐   │  │
│  │    │  MCP Server HTML Content        │   │  │
│  │    │                                 │   │  │
│  │    │  With allow-same-origin:        │   │  │
│  │    │  ✅ Can postMessage to parent   │   │  │
│  │    │  ⚠️  Can access parent DOM      │   │  │
│  │    │  ⚠️  Can steal tokens/cookies   │   │  │
│  │    │                                 │   │  │
│  │    │  Defense:                       │   │  │
│  │    │  • Only load trusted servers    │   │  │
│  │    │  • User must explicitly connect │   │  │
│  │    └──────────────────────────────────┘   │  │
│  │                                           │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘

Communication Flow:

  iframe (HTML)                      Parent (React)
       │                                   │
       │  window.parent.postMessage({      │
       │    type: 'tool',                  │
       │    payload: {...}                 │
       │  }, '*')                          │
       ├──────────────────────────────────>│
       │                                   │
       │                    UIResourceRenderer
       │                    receives event
       │                           │
       │                           ▼
       │                    onUIAction callback
       │                           │
       │                           ▼
       │                    executeUIAction()
       │                           │
       │  postMessage({            │
       │    type: 'ui-size-change',│
       │    payload: { height, width }
       │  })                       │
       ├──────────────────────────────────>│
       │                                   │
       │              Auto-handled by MCP-UI
       │              Resizes iframe
```

## Performance Characteristics

```
Operation                Time        Notes
─────────────────────────────────────────────────────
Initial tool call        200-500ms   Network dependent
UI resource parsing      < 10ms      Synchronous
Iframe creation          50-100ms    Browser dependent
ResizeObserver           ~16ms       60 FPS
UI action (button)       200-500ms   Full round-trip
State update             < 5ms       Redux + React
Re-render                < 20ms      Virtual DOM diff

Memory Usage:
─────────────────────────────────────────────────────
Per message with UI      ~50-100KB   Includes iframe
Per iframe               ~2-5MB      Browser overhead
Total for 10 messages    ~50MB       Reasonable
```

## Error Handling Flow

```
┌─────────────────┐
│  Tool Execution │
└────────┬────────┘
         │
    ┌────┴─────┐
    │          │
    ▼          ▼
Success      Error
    │          │
    │          ├─ Tool not found
    │          │   └─> Show: "Tool not found. Ensure server is running"
    │          │
    │          ├─ Parse error
    │          │   └─> Show: "Invalid tool arguments"
    │          │
    │          ├─ Timeout (30s)
    │          │   └─> Show: "Tool execution timed out"
    │          │
    │          ├─ IPC error
    │          │   └─> Show: "Tool execution failed"
    │          │
    │          └─ Tool returned isError
    │              └─> Show error content from tool
    │
    └─> Parse content
         │
         ├─ Has UI resource?
         │   ├─ Yes: Extract text + UI
         │   └─ No: Extract text only
         │
         └─> Return ToolResult
```

## File Dependencies

```
electron/
└─ services/
   └─ mcp.service.ts
       │
       │ IPC handlers
       ▼
src/
├─ types/
│  └─ mcp.types.ts ────┐
│                      │
├─ services/           │
│  └─ mcp/             │
│     └─ tool-integration.service.ts ◄──┐
│                                       │
├─ store/                               │
│  └─ slices/                           │
│     └─ chatSlice.ts ◄─────────────────┤
│                                       │
└─ components/                          │
   └─ chat/                             │
      ├─ ChatMessage.tsx ◄──────────────┤
      ├─ ToolCallMessage.tsx ◄──────────┤
      └─ UIResourceDisplay.tsx ◄────────┘

External Dependencies:
├─ @mcp-ui/client (UIResourceRenderer)
└─ @modelcontextprotocol/sdk
```

---

**Note**: Diagrams use ASCII art for compatibility. For actual deployment docs, consider using Mermaid, PlantUML, or draw.io for better visuals.

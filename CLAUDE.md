# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claudia is an Electron-based desktop application that serves as a Claude Desktop clone, connecting to Open WebUI or Open Router. It features real-time streaming chat, file uploads, conversation history, project management, and MCP (Model Context Protocol) server integration for extended AI capabilities.

## Common Commands

### Development
```bash
npm run dev              # Start Vite dev server (port 5173) with hot reload
npm run type-check       # Run TypeScript compiler without emitting files
npm run lint             # Run ESLint on src and electron directories
npm run format           # Format code with Prettier
```

### Building
```bash
npm run build            # Build React app (TypeScript compile + Vite build)
npm run build:electron   # Build full Electron app
npm run build:win        # Build Windows installer
npm run preview          # Preview production build
```

### Release
```bash
npm run release          # PowerShell release script
npm run release:bat      # Batch file release script
```

## Architecture

### Electron Process Model

**Main Process** (`electron/main.ts`):
- Creates BrowserWindow and manages app lifecycle
- Registers IPC handlers from `electron/handlers/`
- Initializes MCP servers and plugin manager on startup
- Handles menu creation with keyboard shortcuts (Cmd/Ctrl+N, Cmd/Ctrl+,, Cmd/Ctrl+B)
- Manages window state persistence via `electron-store`

**Preload Script** (`electron/preload.ts`):
- Exposes secure IPC bridge via `contextBridge`
- Provides typed API surface through `window.electron`
- Defines interfaces for config, file, conversation, project, MCP, and plugin operations

**Renderer Process** (`src/`):
- React 18 app with TypeScript
- Redux Toolkit for state management
- Vite for bundling and dev server

### IPC Communication Pattern

The app follows a handler-based IPC architecture:

1. **Handlers** (`electron/handlers/`):
   - `config.handler.ts` - Get/set app configuration
   - `conversation.handler.ts` - Save/load/delete conversations
   - `project.handler.ts` - Project CRUD operations
   - `mcp.handler.ts` - MCP server lifecycle and tool/resource/prompt operations
   - `plugin.handler.ts` - Plugin discovery, loading, and configuration

2. **Services** (`electron/services/`):
   - `store.service.ts` - Electron-store wrapper for persistent config
   - `mcp.service.ts` - MCP server manager using `@modelcontextprotocol/sdk`
   - `plugin-manager.service.ts` - Plugin lifecycle management
   - `claude-importer.service.ts` - Import MCP configs from Claude Desktop

3. **Renderer Services** (`src/services/`):
   - `api/provider.factory.ts` - Creates API provider instances
   - `api/providers/` - OpenWebUI and OpenRouter provider implementations
   - `api/streaming.service.ts` - Server-Sent Events streaming for chat
   - `mcp/tool-integration.service.ts` - Integrates MCP tools with chat

### State Management (Redux)

Store configured in `src/store/index.ts` with the following slices:

- **settingsSlice**: API config (provider, models, keys), appearance, preferences
- **uiSlice**: Sidebar/settings visibility, modal state, loading/error states
- **chatSlice**: Current chat state, messages, streaming status, abort controller
- **conversationSlice**: Conversation list, active conversation ID
- **projectSlice**: Project list, active project
- **mcpSlice**: MCP server configs, tools, resources, prompts, server status
- **pluginSlice**: Plugin configs, enabled plugins, active extensions

**Important Redux Config**:
- `serializableCheck` is configured to ignore `chat/setAbortController` actions and `chat.abortController` paths because AbortController is non-serializable

### MCP (Model Context Protocol) Integration

**Two Transport Types**:
1. **stdio**: Spawns local process (e.g., Node scripts, Python servers)
   - Requires: `command`, optional `args`, `env`
2. **streamable-http**: Connects to HTTP-based MCP servers
   - Requires: `url`
   - Note: Old configs may use `sse` transport, which gets auto-migrated to `streamable-http`

**MCP Workflow**:
1. Configs stored in electron-store under `mcp.servers`
2. `mcp.handler.ts` validates configs and starts/stops servers via `MCPServerManager`
3. `MCPClientWrapper` (`electron/services/mcp.service.ts`) manages individual server connections using official SDK
4. Tools/resources/prompts are fetched and cached in Redux (`mcpSlice`)
5. Renderer integrates MCP tools into chat messages via `tool-integration.service.ts`
6. Tool calls stream back results that get rendered in chat UI

### Plugin System

Plugins extend Claudia's functionality through two modes:
- **Extension plugins**: Add features (e.g., custom UI, commands)
- **Replacement plugins**: Replace core chat provider (e.g., custom LLM backends)

**Plugin Discovery**:
- Local plugins directory: `%APPDATA%/claudia/plugins` (Windows)
- Each plugin has `manifest.json` defining metadata, entry point, and capabilities

### API Provider Pattern

**Multi-Provider Support**:
- Abstract `APIProvider` interface in `provider.interface.ts`
- Factory pattern in `provider.factory.ts` creates provider instances
- Current providers: `OpenWebUIProvider`, `OpenRouterProvider`

**Provider Responsibilities**:
- Fetch available models from backend
- Stream chat completions with tool calling support
- Handle authentication (API keys)
- Format requests/responses per provider's API spec

**Streaming Architecture**:
- Uses `eventsource-parser` to parse Server-Sent Events
- `streaming.service.ts` accumulates chunks and tool call deltas
- Callbacks: `onChunk`, `onComplete`, `onError`, `onToolCalls`
- AbortController stored in Redux for cancellation

### UI Component Structure

**Layout**:
- `MainLayout`: Top-level layout with sidebar, chat window, settings panel
- Settings open/close controlled by `uiSlice.settingsOpen`

**Chat Components** (`src/components/chat/`):
- `ChatWindow`: Main chat container
- `ChatInput`: Textarea with file attachment support
- `ChatMessage`: Individual message rendering
- `StreamingMessage`: Real-time message display during streaming
- `ToolCallMessage`: Displays MCP tool calls and results
- `MarkdownRenderer`: Renders markdown with syntax highlighting (react-markdown + react-syntax-highlighter)

**Settings Components** (`src/components/settings/`):
- `SettingsPanel`: Tabbed settings interface
- `ApiSettings`: Configure provider (OpenWebUI/OpenRouter), API keys, models
- `MCPSettings`: Manage MCP server configs, view logs, import from Claude Desktop
- `PluginSettings`: Enable/disable plugins, configure settings
- `PreferencesSettings`: UI preferences (streaming, auto-scroll, etc.)
- `ThemeSettings`: Appearance customization

### File Handling

**Upload Flow**:
1. `react-dropzone` in `ChatInput` captures files
2. Files read as base64 via FileReader
3. Attached to message in Redux chat state
4. Sent to API provider as part of chat completion request
5. Supported: images (PNG, JPG, etc.), documents (PDF, DOCX, TXT, CSV)

### Data Persistence

**Electron Store** (`electron-store`):
- Stores configuration in JSON file (AppData on Windows)
- Schema: `{ api, appearance, preferences, windowState, mcp: { servers } }`
- API keys encrypted using electron-store's encryption

**Conversations**:
- Stored as separate JSON files in AppData
- Managed by `conversation.handler.ts`
- Supports bulk operations (deleteMultiple, deleteAll)
- Can be organized by projects

### Build Configuration

**Vite Config** (`vite.config.ts`):
- Two electron entry points: `main.ts` and `preload.ts`
- Output: `dist/` (renderer), `dist-electron/` (main/preload)
- Path aliases: `@/` → `src/`, `@electron/` → `electron/`
- External dependencies: `electron`, `electron-store`

**Electron Builder**:
- Package config in `package.json`
- Icon path: `build/icon.ico`
- Windows-specific builds via `--win` flag

## Important Patterns

### Adding New IPC Channels

1. Define handler in `electron/handlers/[feature].handler.ts`
2. Register handler in `electron/main.ts` `whenReady()`
3. Expose in `electron/preload.ts` via `contextBridge`
4. Call from renderer via `window.electron.[feature].[method]()`

### Adding MCP Tool Support

1. Ensure server config is saved via `mcp.handler.ts`
2. Server auto-discovers tools on connection
3. Tools populate in Redux via `mcpSlice`
4. Use `tool-integration.service.ts` to format tools for API requests
5. Render tool calls/results via `ToolCallMessage` component

### Streaming Chat Messages

1. Provider calls `streaming.service.ts` `streamChatCompletion()`
2. Callbacks update Redux chat state with chunks
3. `StreamingMessage` component subscribes to Redux and re-renders
4. On `[DONE]`, message marked complete
5. AbortController in Redux allows cancellation

### Multi-Select Delete Pattern

Implemented in conversation management:
- UI allows selecting multiple conversations via checkboxes
- Calls `window.electron.conversation.deleteMultiple(conversations)`
- Handler batches delete operations
- Redux state updated to remove deleted items

## Development Notes

- Dev server runs on port 5173
- DevTools auto-open in development mode
- Window state (size, position) persists across restarts
- Menu shortcuts work cross-platform (CmdOrCtrl for macOS/Windows compatibility)
- TypeScript strict mode enabled with unused variable checks
- Redux DevTools integration available in development

import { configureStore } from '@reduxjs/toolkit';
import { vi } from 'vitest';
import chatReducer from '../store/slices/chatSlice';
import settingsReducer, { setPreferences } from '../store/slices/settingsSlice';
import mcpReducer from '../store/slices/mcpSlice';
import composerReducer from '../store/slices/composerSlice';
import type { StreamCallbacks } from '../services/api/streaming.service';
import type { ChatCompletionRequest } from '../types/api.types';
import type { ToolCall } from '../types/message.types';
import type { MCPServerState, MCPTool } from '../types/mcp.types';
import type { MessageUsage } from '../types/statistics.types';
import { setPlatform, type ClaudiaPlatform } from '../platform';

/** What one scripted model turn emits. */
export interface ScriptedTurn {
  text?: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  usage?: MessageUsage;
  error?: Error;
  /** Called before the turn streams; lets a test abort mid-run. */
  before?: () => void;
}

/**
 * A fake IAPIProvider that replays scripted turns and records every request.
 * Turns emit the same callback sequence the real parsers do.
 */
export function scriptedProvider(turns: ScriptedTurn[], capabilities: Record<string, unknown> = {}) {
  const requests: ChatCompletionRequest[] = [];
  const queue = [...turns];
  const provider = {
    getModels: vi.fn(async () => []),
    chatCompletion: vi.fn(),
    testConnection: vi.fn(async () => true),
    updateConfig: vi.fn(),
    getProviderType: () => 'custom' as const,
    getCapabilities: () => ({
      supportsFileUpload: false,
      supportsToolCalling: true,
      supportsStreaming: true,
      requiresCustomHeaders: false,
      ...capabilities,
    }),
    streamChatCompletion: vi.fn(
      async (request: ChatCompletionRequest, cb: StreamCallbacks, signal?: AbortSignal) => {
        // Deep-copy so later mutation of the shared messages array doesn't rewrite history
        requests.push(JSON.parse(JSON.stringify(request)));
        const turn = queue.shift() ?? { text: '' };
        turn.before?.();
        if (signal?.aborted) {
          cb.onComplete();
          return;
        }
        if (turn.error) {
          cb.onError(turn.error);
          return;
        }
        if (turn.reasoning) cb.onReasoning?.(turn.reasoning);
        if (turn.text) cb.onChunk(turn.text);
        if (turn.usage) cb.onUsage?.(turn.usage);
        if (turn.toolCalls?.length) cb.onToolCalls?.(turn.toolCalls);
        cb.onComplete();
      }
    ),
  };
  return { provider, requests };
}

export function readyServer(id: string, name: string, tools: MCPTool[]): MCPServerState {
  return {
    config: { id, name, transport: 'stdio', command: 'x', enabled: true },
    status: 'ready',
    tools,
    resources: [],
    prompts: [],
    restartCount: 0,
  };
}

export function tool(name: string, description = ''): MCPTool {
  return { name, description, inputSchema: { type: 'object', properties: {} } };
}

export function makeChatStore(servers: MCPServerState[] = []) {
  const serverStates = Object.fromEntries(servers.map((s) => [s.config.id, s]));
  // Same first-wins de-duplication mcpSlice applies when it rebuilds the list
  const seen = new Set<string>();
  const availableTools: MCPTool[] = [];
  for (const s of servers) {
    for (const t of s.tools) {
      if (!seen.has(t.name)) {
        seen.add(t.name);
        availableTools.push(t);
      }
    }
  }
  const mcpInitial = mcpReducer(undefined, { type: '@@init' });
  const store = configureStore({
    reducer: { chat: chatReducer, settings: settingsReducer, mcp: mcpReducer, composer: composerReducer },
    preloadedState: {
      mcp: {
        ...mcpInitial,
        servers: Object.fromEntries(servers.map((s) => [s.config.id, s.config])),
        serverStates,
        availableTools,
      },
    },
    middleware: (gdm) => gdm({ serializableCheck: false }),
  });
  // Requests are compared exactly: no diagram guidance unless a test turns it on
  store.dispatch(setPreferences({ visualExplanations: false }));
  return store;
}

/**
 * Install a test platform. Only what chat code touches is real; anything else
 * throws so a test notices when new host calls appear.
 */
export function stubPlatform(callTool: (...args: any[]) => Promise<any>) {
  const mcp = { callTool: vi.fn(callTool) };
  const unexpected = (name: string) =>
    new Proxy({}, { get: (_t, prop) => () => { throw new Error(`Unexpected platform call: ${name}.${String(prop)}`); } });
  const platform = {
    capabilities: {
      kind: 'electron', windowControls: false, nativeMenu: false, autoUpdate: false, appIcon: false,
      localFilesystem: false, stdioMcp: false, diskPlugins: false, auth: false, profiles: false,
    },
    config: unexpected('config'),
    mcp: new Proxy(mcp, { get: (t: any, prop) => t[prop] ?? (() => { throw new Error(`Unexpected platform call: mcp.${String(prop)}`); }) }),
    plugins: unexpected('plugins'),
    skills: unexpected('skills'),
    tools: unexpected('tools'),
    llm: unexpected('llm'),
    files: unexpected('files'),
    events: { on: () => () => {} },
    uiSandbox: { sandboxPermissions: 'allow-scripts' },
  } as unknown as ClaudiaPlatform;
  setPlatform(platform);
  return { mcp };
}

export function textResult(text: string) {
  return { success: true, result: { content: [{ type: 'text', text }], isError: false } };
}

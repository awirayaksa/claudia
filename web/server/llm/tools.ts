/**
 * Tools offered to the model during a run. Phase 1b fills this from the MCP
 * pools; in Phase 1a a run has no tools, but the loop already handles calls.
 */
import type { OpenAITool } from '../../../src/types/api.types';
import type { ToolCall } from '../../../src/types/message.types';
import type { MessagePart, PartOf } from '../../../src/types/turn.types';

export interface ToolExecution {
  /** Where the call ran, stored in the tool_call part. */
  serverId: string;
  tool: string;
  result: PartOf<'tool_result'>;
  /** Parts shown after the result (e.g. generated images as files). */
  extraParts?: MessagePart[];
  /** Images the tool returned; the run stores them and links them in `result.images`. */
  images?: Array<{ mime: string; data: Buffer }>;
}

/** Where in the conversation a call is made (set by the server, never by the model). */
export interface ToolCallContext {
  /**
   * One key per chat (and per model answering side by side): tools that keep
   * state between calls, like the browser, keep one session per key.
   */
  sessionKey?: string;
}

export interface RunToolset {
  /** OpenAI function definitions, named by alias. */
  definitions: OpenAITool[];
  /** Offer tools only on the first request (connection quirk). */
  firstTurnOnly: boolean;
  /** Where an alias lives, without running it. */
  locate(alias: string): { serverId: string; tool: string } | null;
  /** The user approves this call before it runs (default: never). */
  needsApproval?(alias: string): boolean;
  execute(call: ToolCall, signal: AbortSignal, context?: ToolCallContext): Promise<ToolExecution>;
}

export const NO_TOOLS: RunToolset = {
  definitions: [],
  firstTurnOnly: false,
  locate: () => null,
  async execute(call) {
    return {
      serverId: '',
      tool: call.function.name,
      result: {
        type: 'tool_result',
        callId: call.id,
        content: JSON.stringify({ error: `Tool "${call.function.name}" is not available.` }),
        isError: true,
      },
    };
  },
};

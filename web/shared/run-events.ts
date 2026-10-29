/**
 * Events of one completion run, streamed over SSE from
 * GET /api/runs/:id/events. Every event has a sequence number, so a client
 * that reconnects (or a second tab) resumes with `?after=<seq>`.
 */
import type { MessageNode, MessagePart, PartOf, ToolApproval } from '../../src/types/turn.types';
import type { MessageUsage } from '../../src/types/statistics.types';
import type { CitationSource } from '../../src/types/turn.types';

export type RunStatus = 'completed' | 'stopped' | 'error';

export type RunEvent =
  | { type: 'run.started'; runId: string; chatId: string; userMessageId: string; assistantMessageIds: string[] }
  /** A node was created: the user turn, then one assistant node per model. */
  | { type: 'message.created'; message: MessageNode }
  | { type: 'message.delta'; messageId: string; text: string }
  | { type: 'message.reasoning'; messageId: string; text: string }
  | { type: 'message.tool_call'; messageId: string; part: PartOf<'tool_call'> }
  | { type: 'tool.started'; messageId: string; callId: string }
  | { type: 'tool.result'; messageId: string; part: PartOf<'tool_result'> }
  /**
   * A tool that runs in the browser (Phase 5: code interpreter). The client
   * answers with POST /api/runs/:id/tool-results; without an answer the
   * server records an error result after a timeout.
   */
  | { type: 'tool.client_request'; runId: string; messageId: string; callId: string; name: string; args: string }
  /**
   * A tool call that changes data elsewhere waits for the user. The client
   * answers with POST /api/runs/:id/approvals; without an answer the call is
   * skipped after a timeout.
   */
  | { type: 'tool.approval_request'; runId: string; messageId: string; callId: string }
  | { type: 'tool.approval_resolved'; messageId: string; callId: string; decision: Exclude<ToolApproval, 'pending'> }
  | { type: 'message.usage'; messageId: string; usage: MessageUsage }
  /** A part added to a reply outside text and tools (generated images). */
  | { type: 'message.part'; messageId: string; part: MessagePart }
  | { type: 'message.citations'; messageId: string; citations: Array<{ index: number; source: CitationSource }> }
  /** Suggested next questions, after the reply is complete. */
  | { type: 'message.followups'; messageId: string; followUps: string[] }
  | { type: 'message.completed'; messageId: string; status: RunStatus; error?: string; parts: MessagePart[] }
  /** Something the user should know about the request, e.g. history trimmed to fit. */
  | {
      type: 'run.notice';
      /** sources: a knowledge, reference or web search note; sources_failed: they couldn't be loaded. */
      code: 'history_trimmed' | 'context_trimmed' | 'context_overflow' | 'sources' | 'sources_failed';
      message: string;
    }
  | { type: 'chat.updated'; chatId: string; title?: string }
  | { type: 'run.completed'; runId: string; status: RunStatus };

export type RunEventType = RunEvent['type'];

export interface RunEventEnvelope {
  seq: number;
  event: RunEvent;
}

/**
 * Live state of runs, keyed by chat. Run events update a copy of the nodes
 * being written; when the run ends the chat is refetched and the live copy
 * dropped.
 */
import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { MessageNode, MessagePart } from '@/types/turn.types';
import type { RunEventEnvelope } from '@shared/run-events';

export interface LiveRun {
  runId: string;
  lastSeq: number;
  done: boolean;
  /** Nodes created or changed by this run. */
  nodes: Record<string, MessageNode>;
  /** First assistant node: the leaf to show while the run is going. */
  leafId: string | null;
  notices: string[];
  title?: string;
}

export type RunState = Record<string, LiveRun>;

function appendText(node: MessageNode, type: 'text' | 'reasoning', text: string): void {
  const last = node.parts[node.parts.length - 1] as MessagePart | undefined;
  if (last && last.type === type) last.text += text;
  else node.parts.push({ type, text });
}

const runSlice = createSlice({
  name: 'runs',
  initialState: {} as RunState,
  reducers: {
    runFollowed(state, action: PayloadAction<{ chatId: string; runId: string }>) {
      const { chatId, runId } = action.payload;
      if (state[chatId]?.runId === runId) return;
      state[chatId] = { runId, lastSeq: 0, done: false, nodes: {}, leafId: null, notices: [] };
    },
    runEvent(state, action: PayloadAction<{ chatId: string; envelope: RunEventEnvelope }>) {
      const { chatId, envelope } = action.payload;
      const live = state[chatId];
      if (!live || envelope.seq <= live.lastSeq) return; // duplicate after a reconnect
      live.lastSeq = envelope.seq;
      const e = envelope.event;
      switch (e.type) {
        case 'run.started':
          live.leafId = e.assistantMessageIds[0] ?? null;
          break;
        case 'message.created':
          live.nodes[e.message.id] = e.message;
          break;
        case 'message.delta': {
          const n = live.nodes[e.messageId];
          if (n) appendText(n, 'text', e.text);
          break;
        }
        case 'message.reasoning': {
          const n = live.nodes[e.messageId];
          if (n) appendText(n, 'reasoning', e.text);
          break;
        }
        case 'message.tool_call':
        case 'tool.result': {
          const n = live.nodes[e.messageId];
          if (n) n.parts.push(e.part);
          break;
        }
        case 'message.usage': {
          const n = live.nodes[e.messageId];
          if (n) n.usage = e.usage;
          break;
        }
        case 'message.completed': {
          const n = live.nodes[e.messageId];
          if (n) {
            n.parts = e.parts;
            n.status = e.status;
            if (e.error) n.error = e.error;
          }
          break;
        }
        case 'message.citations': {
          const n = live.nodes[e.messageId];
          if (n) n.parts = [...e.citations.map((c) => ({ type: 'citation' as const, ...c })), ...n.parts.filter((p) => p.type !== 'citation')];
          break;
        }
        case 'message.followups': {
          const n = live.nodes[e.messageId];
          if (n) n.followUps = e.followUps;
          break;
        }
        case 'run.notice':
          live.notices.push(e.message);
          break;
        case 'chat.updated':
          if (e.title) live.title = e.title;
          break;
        case 'run.completed':
          live.done = true;
          break;
        default:
          break;
      }
    },
    runCleared(state, action: PayloadAction<{ chatId: string; runId: string }>) {
      if (state[action.payload.chatId]?.runId === action.payload.runId) delete state[action.payload.chatId];
    },
  },
});

export const { runFollowed, runEvent, runCleared } = runSlice.actions;
export default runSlice.reducer;

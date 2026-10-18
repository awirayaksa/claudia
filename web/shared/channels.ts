import { z } from 'zod';

export const ChannelInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(''),
  archived: z.boolean().default(false),
});
export type ChannelInput = z.input<typeof ChannelInput>;

export const ChannelPost = z.object({ content: z.string().trim().min(1).max(20_000) });

/** "@<connection prefix>/<model>" (or "@custom/<id>") anywhere in a message asks that model. */
export const MENTION_RE = /(?:^|\s)@((?:custom|[@a-z0-9][\w.-]*)\/[\w.:\-/]+)/i;

export interface ChannelView {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  /** Rename, archive, delete, choose members (admins). */
  canManage: boolean;
  lastMessageAt: string | null;
}

export interface ChannelMessageView {
  id: string;
  channelId: string;
  author: { kind: 'user' | 'model'; id: string; name: string };
  replyToId: string | null;
  content: string;
  status: 'done' | 'streaming' | 'error';
  deleted: boolean;
  createdAt: string;
  editedAt: string | null;
}

/** What WebSocket subscribers of "channel:<id>" receive. */
export type ChannelEvent =
  | { type: 'channel.message'; message: ChannelMessageView }
  | { type: 'channel.message.updated'; message: ChannelMessageView }
  | { type: 'channel.delta'; messageId: string; text: string };

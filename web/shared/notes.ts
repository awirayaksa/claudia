import { z } from 'zod';

export const NoteInput = z.object({
  title: z.string().trim().max(200).default(''),
  content: z.string().max(500_000).default(''),
  pinned: z.boolean().default(false),
});
export type NoteInput = z.input<typeof NoteInput>;

export interface NoteSummary {
  id: string;
  title: string;
  /** The start of the text, without Markdown marks. */
  snippet: string;
  pinned: boolean;
  mine: boolean;
  /** The owner's name (shared notes). */
  ownerName: string | null;
  canEdit: boolean;
  updatedAt: string;
}

export interface NoteDetail extends NoteSummary {
  content: string;
  /** Share and delete (the owner). */
  canManage: boolean;
  createdAt: string;
}

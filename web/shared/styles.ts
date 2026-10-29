import { z } from 'zod';

/**
 * Writing styles: how replies are written (Normal, Concise, Explanatory,
 * Formal, or one of your own). A style's instructions go to the model in a
 * <style> block, apart from the system prompts.
 */

export interface BuiltinStyle {
  id: 'normal' | 'concise' | 'explanatory' | 'formal';
  name: string;
  description: string;
  /** Empty for Normal: no style block at all. */
  instructions: string;
}

export const BUILTIN_STYLES: BuiltinStyle[] = [
  { id: 'normal', name: 'Normal', description: 'The default way of writing', instructions: '' },
  {
    id: 'concise',
    name: 'Concise',
    description: 'Shorter, more direct replies',
    instructions:
      'Be brief. Give the answer directly, in as few words as it needs: no preamble, no restating the question, no closing summary or offers of more help. ' +
      'Prefer short sentences and short lists. Include code, steps or details only when they are needed to answer.',
  },
  {
    id: 'explanatory',
    name: 'Explanatory',
    description: 'Teaches, with examples and the reasoning behind things',
    instructions:
      'Explain like a patient teacher. Build understanding step by step: give the intuition first, define the terms you use, work through a concrete example, ' +
      'and point out common misunderstandings. Say why, not only what. Longer replies are fine when they help the reader understand.',
  },
  {
    id: 'formal',
    name: 'Formal',
    description: 'Clear, polished and professional',
    instructions:
      'Write in a formal, professional register: complete sentences, precise wording, and no slang, contractions or emoji. ' +
      'Organise longer replies with clear headings or numbered points, and keep a courteous, neutral tone.',
  },
];

export const isBuiltinStyle = (id: string): id is BuiltinStyle['id'] => BUILTIN_STYLES.some((s) => s.id === id);

export const StyleInput = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200).default(''),
  instructions: z.string().trim().min(1).max(4000),
  /** Admins: a style for everyone (no owner). */
  everyone: z.boolean().optional(),
});
export type StyleInput = z.input<typeof StyleInput>;

/** "Write it for me": from writing samples, a description, or both. */
export const GenerateStyleInput = z
  .object({
    samples: z.string().trim().max(30_000).optional(),
    description: z.string().trim().max(2000).optional(),
  })
  .refine((v) => !!(v.samples || v.description), { message: 'Give a sample of the writing, a description, or both.' });

export interface StyleView {
  id: string;
  name: string;
  description: string;
  instructions: string;
  /** builtin: Normal, Concise…; everyone: an admin's for all users; mine; shared: someone shared it with you. */
  scope: 'builtin' | 'everyone' | 'mine' | 'shared';
  ownerName: string | null;
  canEdit: boolean;
  /** Share or delete it. */
  canManage: boolean;
}

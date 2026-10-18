import { z } from 'zod';

export const FileView = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  status: z.enum(['processing', 'ready', 'failed']),
  /** Why processing failed, for the user. */
  error: z.string().nullable(),
  /** Text was extracted (documents); images and unsupported files have none. */
  hasText: z.boolean(),
  textTruncated: z.boolean(),
  createdAt: z.string(),
});
export type FileView = z.infer<typeof FileView>;

/** Largest upload accepted. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * HTTP contract between the web client and server: zod schemas for request
 * and response bodies. Domain types come from ../src/types.
 */
import { z } from 'zod';

export const HealthResponse = z.object({
  status: z.literal('ok'),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const ReadyResponse = z.object({
  status: z.enum(['ready', 'not_ready']),
  database: z.enum(['postgres', 'pglite']),
  migrations: z.object({ applied: z.number().int(), pending: z.number().int() }),
  /** Redis, when configured (several instances): it must answer too. */
  redis: z.enum(['ok', 'off', 'error']).optional(),
  storage: z.enum(['local', 's3']).optional(),
  error: z.string().optional(),
});
export type ReadyResponse = z.infer<typeof ReadyResponse>;

/** Unauthenticated: what the client needs before anything else. */
export const PublicConfig = z.object({
  version: z.string(),
  /** Origin of the sandbox pages (MCP-UI proxy, artifacts, previews); null when not configured. */
  sandboxOrigin: z.string().nullable(),
});
export type PublicConfig = z.infer<typeof PublicConfig>;

/** Every error response has this shape. */
export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

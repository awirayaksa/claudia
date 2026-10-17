import type { z } from 'zod';

/**
 * Parse a PATCH body against an object schema, keeping only the fields the
 * request sent. (zod 4's `.partial()` still fills in `.default()` values, so
 * an omitted field would otherwise come back as its default and overwrite
 * the stored value.)
 */
export function parsePatch<T extends z.ZodObject>(schema: T, body: unknown): Partial<z.output<T>> {
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const parsed = schema.partial().parse(raw) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => k in raw)) as Partial<z.output<T>>;
}

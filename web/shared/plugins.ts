import { z } from 'zod';

/**
 * The import map in index.html (byte for byte; the server allows it in the
 * CSP by its hash, and a test checks the two match). Plugins import these
 * names and get the app's own copies through the shims.
 */
export const PLUGIN_IMPORT_MAP =
  '{"imports":{"react":"/plugin-shims/react.js","react/jsx-runtime":"/plugin-shims/jsx-runtime.js","unified":"/plugin-shims/unified.js"}}';

export const PluginManifestInput = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'Use lowercase letters, digits, ".", "_" and "-" for the id'),
  name: z.string().trim().min(1).max(100),
  version: z
    .string()
    .trim()
    .regex(/^\d+\.\d+\.\d+([.+-][0-9A-Za-z.+-]*)?$/, 'Use a version like 1.2.3'),
  description: z.string().max(500).optional(),
  author: z.string().max(200).optional(),
  type: z.enum(['renderer-extension', 'renderer-replacement']),
  renderer: z.object({ priority: z.number().int().min(0).max(10_000).optional(), allowFallback: z.boolean().optional() }).optional(),
  settingsSchema: z.record(z.string(), z.unknown()).optional(),
});
export type PluginManifestInput = z.infer<typeof PluginManifestInput>;

export interface PluginView {
  id: string;
  version: string;
  manifest: PluginManifestInput;
  enabled: boolean;
  settings: Record<string, unknown>;
  /** Where the browser imports it from. */
  url: string;
}

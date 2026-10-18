/** Google Drive and OneDrive (cloud file pickers). */
import { z } from 'zod';

export const CLOUD_PROVIDERS = ['google', 'microsoft'] as const;
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

export const CloudSettings = z.object({
  google: z.object({ enabled: z.boolean(), clientId: z.string().trim().max(500) }),
  microsoft: z.object({
    enabled: z.boolean(),
    clientId: z.string().trim().max(500),
    /** "common", "organizations", or a tenant id / domain (one organisation only). */
    tenant: z.string().trim().max(200),
  }),
});
export type CloudSettings = z.infer<typeof CloudSettings>;

export const CloudSettingsUpdate = z.object({
  google: CloudSettings.shape.google.partial().optional(),
  microsoft: CloudSettings.shape.microsoft.partial().optional(),
  /** Empty keeps the stored secret; null removes it. */
  googleSecret: z.string().max(2000).nullable().optional(),
  microsoftSecret: z.string().max(2000).nullable().optional(),
});
export type CloudSettingsUpdate = z.infer<typeof CloudSettingsUpdate>;

export interface CloudSettingsResponse {
  settings: CloudSettings;
  hasSecret: { google: boolean; microsoft: boolean };
}

export interface CloudAccountView {
  provider: CloudProvider;
  connected: boolean;
  accountEmail: string | null;
}

export interface CloudItem {
  id: string;
  name: string;
  folder: boolean;
  mime: string;
  size: number | null;
  modifiedAt: string | null;
}

export interface CloudListing {
  items: CloudItem[];
  /** Pass back as `page` for more; null at the end. */
  next: string | null;
}

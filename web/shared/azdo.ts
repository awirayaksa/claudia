/** Azure DevOps Server / TFS (on-premises): the admin's collections and each user's connection. */
import { z } from 'zod';

/** REST API versions by server release: TFS 2018 = 4.1, Server 2019 = 5.0, 2020 = 6.0, 2022 = 7.0 / 7.1. */
export const AZDO_API_VERSIONS = ['4.1', '5.0', '6.0', '7.0', '7.1'] as const;
export type AzdoApiVersion = (typeof AZDO_API_VERSIONS)[number];

export const AzdoServer = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(100),
  /** The collection URL, e.g. https://tfs.example.com/tfs/DefaultCollection. */
  url: z
    .url({ protocol: /^https?$/ })
    .max(1000)
    .transform((u) => u.replace(/\/+$/, '')),
  apiVersion: z.enum(AZDO_API_VERSIONS),
});
export type AzdoServer = z.infer<typeof AzdoServer>;

export const AzdoServersSetting = z.object({ servers: z.array(AzdoServer).max(20) });

/** A user's connection to one of the admin's collections (the token is never sent back). */
export interface AzdoConnectionView {
  serverId: string;
  serverName: string;
  url: string;
  connected: boolean;
  /** Who the token signs in as. */
  displayName: string | null;
  defaultProject: string | null;
}

export const AzdoConnectInput = z.object({
  /** Empty keeps the stored token (to change only the default project). */
  pat: z.string().trim().max(500).optional(),
  defaultProject: z.string().trim().max(256).nullable().optional(),
});
export type AzdoConnectInput = z.infer<typeof AzdoConnectInput>;

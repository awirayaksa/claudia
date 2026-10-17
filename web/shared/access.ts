import { z } from 'zod';

/**
 * Permission keys. A user's permissions are the defaults (Admin → Settings)
 * plus those of every group they belong to; admins have all of them.
 */
export const PERMISSION_KEYS = [
  'chat.share',
  'chat.export',
  'chat.temporary',
  'workspace.models',
  'workspace.prompts',
  'workspace.share_public',
  'mcp.user_servers',
  'connections.own',
  'api.keys',
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];
export type Permissions = Record<PermissionKey, boolean>;

/** Defaults: chat features on, everything that adds resources or spends keys off. */
export const DEFAULT_PERMISSIONS: Permissions = {
  'chat.share': true,
  'chat.export': true,
  'chat.temporary': true,
  'workspace.models': false,
  'workspace.prompts': true,
  'workspace.share_public': false,
  'mcp.user_servers': false,
  'connections.own': false,
  'api.keys': false,
};

export const PermissionsSchema = z.object(
  Object.fromEntries(PERMISSION_KEYS.map((k) => [k, z.boolean()])) as Record<PermissionKey, z.ZodBoolean>
);
/** A group's permissions: only the keys it grants matter. */
export const PartialPermissionsSchema = PermissionsSchema.partial();

// ─── Usage caps ──────────────────────────────────────────────────────────────

export const CAP_KEYS = ['tokensPerDay', 'tokensPerMonth', 'costPerDay', 'costPerMonth'] as const;
export type CapKey = (typeof CAP_KEYS)[number];

const capValue = z.number().min(0).max(1e12);

/** Defaults for everyone: a number, or null for no limit. */
export const DefaultCapsSchema = z.object({
  tokensPerDay: capValue.nullable(),
  tokensPerMonth: capValue.nullable(),
  costPerDay: capValue.nullable(),
  costPerMonth: capValue.nullable(),
});
export type DefaultCaps = z.infer<typeof DefaultCapsSchema>;

/** A group's caps: the keys it sets raise the default (the most generous one wins). */
export const GroupCapsSchema = z.object({
  tokensPerDay: capValue.optional(),
  tokensPerMonth: capValue.optional(),
  costPerDay: capValue.optional(),
  costPerMonth: capValue.optional(),
});
export type GroupCaps = z.infer<typeof GroupCapsSchema>;

/** One user's override: each key set wins over defaults and groups (null = no limit). */
export const UserCapsSchema = DefaultCapsSchema.partial();
export type UserCaps = z.infer<typeof UserCapsSchema>;

export interface UsageSummary {
  /** Tokens and known cost (USD) since 00:00 UTC today and since the 1st of this month. */
  day: { tokens: number; cost: number };
  month: { tokens: number; cost: number };
  caps: DefaultCaps;
}

// ─── Groups ──────────────────────────────────────────────────────────────────

export const GroupInput = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).default(''),
  permissions: PartialPermissionsSchema.default({}),
  /** Models members may use on top of their role's allowlist. */
  modelIds: z.array(z.string().min(1).max(500)).max(500).default([]),
  caps: GroupCapsSchema.default({}),
  /** Directory group whose members are synced into this group at sign-in. */
  ldapDn: z.string().trim().max(500).nullable().default(null),
});
export type GroupInput = z.infer<typeof GroupInput>;

export interface GroupView {
  id: string;
  name: string;
  description: string;
  permissions: Partial<Permissions>;
  modelIds: string[];
  caps: GroupCaps;
  ldapDn: string | null;
  memberCount: number;
}

export interface GroupMemberView {
  userId: string;
  email: string;
  name: string;
  /** 'ldap' members are managed by the directory sync. */
  source: 'manual' | 'ldap';
}

/** A group as non-admins see it (for sharing). */
export interface GroupRef {
  id: string;
  name: string;
}

// ─── Access grants ───────────────────────────────────────────────────────────

export const GrantInput = z.discriminatedUnion('principalType', [
  z.object({ principalType: z.literal('public'), perm: z.literal('read') }),
  z.object({ principalType: z.literal('group'), principalId: z.uuid(), perm: z.enum(['read', 'write']) }),
  z.object({ principalType: z.literal('user'), principalId: z.uuid(), perm: z.enum(['read', 'write']) }),
]);
export type GrantInput = z.infer<typeof GrantInput>;

export const SetGrantsRequest = z.object({ grants: z.array(GrantInput).max(200) });

export interface GrantView {
  principalType: 'public' | 'group' | 'user';
  principalId: string | null;
  /** Group name or user name / email, for display. */
  label: string;
  perm: 'read' | 'write';
}

/** What the signed-in user may do with a workspace item. */
export interface ItemAccess {
  /** Owner (or admin): may change who has access and delete it. */
  manage: boolean;
  write: boolean;
}

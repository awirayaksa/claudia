/**
 * Who may do what, beyond roles.
 *
 * - Permissions: the defaults (Admin → Settings) plus every group's, so a
 *   group can only add. Admins have all of them; pending users none.
 * - Models: a group adds models to its members' role allowlist.
 * - Caps: per metric, a user override wins; otherwise the most generous of
 *   the default and the user's groups (no limit beats any number).
 * - Workspace items (custom models, prompts) are private to their owner;
 *   anyone else needs an `access_grants` row for themselves, one of their
 *   groups, or the public. Every list query goes through `visibleSql`.
 */
import { and, eq, inArray, or, sql, type SQL, type AnyColumn } from 'drizzle-orm';
import type { Database } from '../db/client';
import { accessGrants, groupMembers, groups, users, type PrincipalType, type ResourceType, type UserRole } from '../db/schema';
import { badRequest, forbidden } from '../lib/errors';
import { uuidv7 } from '../lib/ids';
import type { AppSettings } from '../modules/settings/app-settings';
import {
  CAP_KEYS,
  PERMISSION_KEYS,
  type DefaultCaps,
  type GrantInput,
  type GrantView,
  type PermissionKey,
  type Permissions,
} from '../../shared/access';

export interface Principal {
  id: string;
  role: UserRole;
}

export interface ItemRights {
  read: boolean;
  write: boolean;
  /** Change access, delete. */
  manage: boolean;
}

const PERMISSION_MESSAGES: Partial<Record<PermissionKey, string>> = {
  'chat.share': 'You are not allowed to share chats.',
  'chat.export': 'You are not allowed to export chats.',
  'chat.temporary': 'You are not allowed to start temporary chats.',
  'workspace.models': 'You are not allowed to create models.',
  'workspace.prompts': 'You are not allowed to create prompts.',
  'workspace.share_public': 'You are not allowed to share with everyone.',
  'mcp.user_servers': 'You are not allowed to add your own tool servers.',
  'connections.own': 'Your administrator does not allow personal connections.',
  'api.keys': 'You are not allowed to use API keys.',
  'workspace.knowledge': 'You are not allowed to create knowledge bases.',
  'features.web_search': 'You are not allowed to search the web.',
};

export class AccessService {
  constructor(private readonly deps: { db: Database; settings: AppSettings }) {}

  async groupsOf(userId: string): Promise<Array<typeof groups.$inferSelect>> {
    return this.deps.db
      .select({ group: groups })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .where(eq(groupMembers.userId, userId))
      .then((rows) => rows.map((r) => r.group));
  }

  async permissionsFor(user: Principal): Promise<Permissions> {
    const all = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, user.role === 'admin'])) as Permissions;
    if (user.role !== 'user') return all;
    const defaults = await this.deps.settings.get('permissions.default');
    const out = { ...defaults };
    for (const g of await this.groupsOf(user.id)) {
      for (const k of PERMISSION_KEYS) if (g.permissions[k]) out[k] = true;
    }
    return out;
  }

  async can(user: Principal, key: PermissionKey): Promise<boolean> {
    return (await this.permissionsFor(user))[key];
  }

  async require(user: Principal, key: PermissionKey): Promise<void> {
    if (!(await this.can(user, key))) throw forbidden(PERMISSION_MESSAGES[key], 'permission_denied');
  }

  /** Models the user's groups add to the role allowlist. */
  async groupModels(userId: string): Promise<string[]> {
    return [...new Set((await this.groupsOf(userId)).flatMap((g) => g.modelIds))];
  }

  async capsFor(user: Principal): Promise<DefaultCaps> {
    const defaults = await this.deps.settings.get('caps.default');
    const out: DefaultCaps = { ...defaults };
    const groupRows = await this.groupsOf(user.id);
    for (const k of CAP_KEYS) {
      for (const g of groupRows) {
        const v = g.caps[k];
        if (v === undefined || out[k] === null) continue;
        out[k] = Math.max(out[k] as number, v);
      }
    }
    const [row] = await this.deps.db.select({ caps: users.caps }).from(users).where(eq(users.id, user.id));
    for (const k of CAP_KEYS) {
      if (row?.caps && k in row.caps) out[k] = row.caps[k] ?? null;
    }
    return out;
  }

  // ─── Workspace items ───────────────────────────────────────────────────────

  /** SQL true when the grant row in `accessGrants` names this user, one of their groups, or the public. */
  private principalSql(user: Principal): SQL {
    return sql`(
      ${accessGrants.principalType} = 'public'
      or (${accessGrants.principalType} = 'user' and ${accessGrants.principalId} = ${user.id})
      or (${accessGrants.principalType} = 'group' and ${accessGrants.principalId} in (
        select ${groupMembers.groupId} from ${groupMembers} where ${groupMembers.userId} = ${user.id}
      ))
    )`;
  }

  /**
   * SQL true when the user holds a grant on the row whose id is `idColumn`
   * (read: a read or write grant; write: a write grant).
   */
  grantedSql(user: Principal, type: ResourceType, idColumn: AnyColumn, perm: 'read' | 'write'): SQL {
    const perms = perm === 'read' ? sql`('read', 'write')` : sql`('write')`;
    return sql`exists (
      select 1 from ${accessGrants} as ag
      where ag.resource_type = ${type}
        and ag.resource_id = ${idColumn}
        and ag.perm in ${perms}
        and (
          ag.principal_type = 'public'
          or (ag.principal_type = 'user' and ag.principal_id = ${user.id})
          or (ag.principal_type = 'group' and ag.principal_id in (
            select ${groupMembers.groupId} from ${groupMembers} where ${groupMembers.userId} = ${user.id}
          ))
        )
    )`;
  }

  /**
   * Rows the user may see: own, granted, or all of them for admins (unless
   * `adminSeesAll` is false, e.g. for the composer's prompt menu).
   */
  visibleSql(
    user: Principal,
    type: ResourceType,
    idColumn: AnyColumn,
    ownerColumn: AnyColumn,
    opts: { adminSeesAll?: boolean } = {}
  ): SQL | undefined {
    if (user.role === 'admin' && opts.adminSeesAll !== false) return undefined;
    return or(eq(ownerColumn, user.id), this.grantedSql(user, type, idColumn, 'read'));
  }

  async rights(user: Principal, type: ResourceType, item: { id: string; ownerId: string }): Promise<ItemRights> {
    if (user.role === 'pending') return { read: false, write: false, manage: false };
    if (user.role === 'admin' || item.ownerId === user.id) return { read: true, write: true, manage: true };
    const rows = await this.deps.db
      .select({ perm: accessGrants.perm })
      .from(accessGrants)
      .where(and(eq(accessGrants.resourceType, type), eq(accessGrants.resourceId, item.id), this.principalSql(user)));
    return { read: rows.length > 0, write: rows.some((r) => r.perm === 'write'), manage: false };
  }

  /** Rights for many items at once (list views). */
  async rightsMany(user: Principal, type: ResourceType, items: Array<{ id: string; ownerId: string }>): Promise<Map<string, ItemRights>> {
    const out = new Map<string, ItemRights>();
    const others = items.filter((i) => !(user.role === 'admin' || i.ownerId === user.id)).map((i) => i.id);
    let writable = new Set<string>();
    if (others.length > 0 && user.role === 'user') {
      const rows = await this.deps.db
        .select({ id: accessGrants.resourceId })
        .from(accessGrants)
        .where(
          and(
            eq(accessGrants.resourceType, type),
            inArray(accessGrants.resourceId, others),
            eq(accessGrants.perm, 'write'),
            this.principalSql(user)
          )
        );
      writable = new Set(rows.map((r) => r.id));
    }
    for (const i of items) {
      const mine = user.role === 'admin' || i.ownerId === user.id;
      out.set(i.id, { read: true, write: mine || writable.has(i.id), manage: mine });
    }
    return out;
  }

  async grants(type: ResourceType, resourceId: string): Promise<GrantView[]> {
    const rows = await this.deps.db
      .select({
        principalType: accessGrants.principalType,
        principalId: accessGrants.principalId,
        perm: accessGrants.perm,
        groupName: groups.name,
        userName: users.name,
        userEmail: users.email,
      })
      .from(accessGrants)
      .leftJoin(groups, and(eq(accessGrants.principalType, 'group'), eq(groups.id, accessGrants.principalId)))
      .leftJoin(users, and(eq(accessGrants.principalType, 'user'), eq(users.id, accessGrants.principalId)))
      .where(and(eq(accessGrants.resourceType, type), eq(accessGrants.resourceId, resourceId)));
    return rows.map((r) => ({
      principalType: r.principalType,
      principalId: r.principalId,
      perm: r.perm,
      label:
        r.principalType === 'public'
          ? 'Everyone'
          : r.principalType === 'group'
            ? (r.groupName ?? 'Deleted group')
            : r.userName
              ? `${r.userName} (${r.userEmail})`
              : 'Deleted user',
    }));
  }

  /**
   * Replace who else may use an item. Everyone with `manage` may share with
   * groups and people; sharing with everyone needs workspace.share_public.
   */
  async setGrants(actor: Principal, type: ResourceType, resourceId: string, input: GrantInput[]): Promise<GrantView[]> {
    if (input.some((g) => g.principalType === 'public')) await this.require(actor, 'workspace.share_public');
    const groupIds = input.flatMap((g) => (g.principalType === 'group' ? [g.principalId] : []));
    const userIds = input.flatMap((g) => (g.principalType === 'user' ? [g.principalId] : []));
    if (groupIds.length > 0) {
      const found = await this.deps.db.select({ id: groups.id }).from(groups).where(inArray(groups.id, groupIds));
      if (found.length !== new Set(groupIds).size) throw badRequest('A group to share with was not found.', 'invalid_principal');
    }
    if (userIds.length > 0) {
      const found = await this.deps.db.select({ id: users.id }).from(users).where(inArray(users.id, userIds));
      if (found.length !== new Set(userIds).size) throw badRequest('A person to share with was not found.', 'invalid_principal');
    }
    // One grant per principal; write includes read
    const byPrincipal = new Map<string, { principalType: PrincipalType; principalId: string | null; perm: 'read' | 'write' }>();
    for (const g of input) {
      const principalId = g.principalType === 'public' ? null : g.principalId;
      const key = `${g.principalType}:${principalId}`;
      const prev = byPrincipal.get(key);
      if (!prev || g.perm === 'write') byPrincipal.set(key, { principalType: g.principalType, principalId, perm: g.perm });
    }
    await this.deps.db.transaction(async (tx) => {
      await tx.delete(accessGrants).where(and(eq(accessGrants.resourceType, type), eq(accessGrants.resourceId, resourceId)));
      if (byPrincipal.size > 0) {
        await tx
          .insert(accessGrants)
          .values([...byPrincipal.values()].map((g) => ({ id: uuidv7(), resourceType: type, resourceId, ...g })));
      }
    });
    return this.grants(type, resourceId);
  }

  async removeResource(type: ResourceType, resourceId: string): Promise<void> {
    await this.deps.db.delete(accessGrants).where(and(eq(accessGrants.resourceType, type), eq(accessGrants.resourceId, resourceId)));
  }

  async removePrincipal(type: 'user' | 'group', id: string): Promise<void> {
    await this.deps.db.delete(accessGrants).where(and(eq(accessGrants.principalType, type), eq(accessGrants.principalId, id)));
  }
}

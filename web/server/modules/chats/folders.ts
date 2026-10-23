/**
 * Folders (projects) and who may use them. A folder is its owner's; shared
 * with people or groups (access grants, like workspace items) it reaches
 * them with its subfolders:
 * - viewers see its instructions and knowledge and can keep their own chats
 *   in it, which only they see;
 * - editors can also change its name, instructions and knowledge;
 * - only the owner shares, moves or deletes it (admins have no special access).
 */
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { accessGrants, folders, users } from '../../db/schema';
import type { AccessService, Principal } from '../../auth/access';
import { notFound } from '../../lib/errors';

export type FolderRow = typeof folders.$inferSelect;

export interface FolderRights {
  read: boolean;
  write: boolean;
  /** The owner: shares, moves and deletes. */
  manage: boolean;
}

export interface VisibleFolder {
  row: FolderRow;
  rights: FolderRights;
  /** Someone else's folder: whose. */
  ownerName: string | null;
}

const OWNER: FolderRights = { read: true, write: true, manage: true };

export class FolderService {
  constructor(private readonly deps: { db: Database; access: AccessService }) {}

  /** Of these folder ids, the ones the user holds a grant on (read: any grant; write: a write grant). */
  private async granted(user: Principal, ids: string[], perm: 'read' | 'write'): Promise<Set<string>> {
    if (ids.length === 0 || user.role === 'pending') return new Set();
    const rows = await this.deps.db
      .select({ id: folders.id })
      .from(folders)
      .where(and(inArray(folders.id, ids), this.deps.access.grantedSql(user, 'folder', folders.id, perm)));
    return new Set(rows.map((r) => r.id));
  }

  /** The folder and the ones above it, top-down, whoever owns them. */
  private async ancestry(folderId: string): Promise<FolderRow[]> {
    const chain: FolderRow[] = [];
    const seen = new Set<string>();
    let id: string | null = folderId;
    while (id && !seen.has(id)) {
      seen.add(id);
      const [row] = await this.deps.db.select().from(folders).where(eq(folders.id, id));
      if (!row) break;
      chain.unshift(row);
      id = row.parentId;
    }
    return chain;
  }

  /** What the user may do with a folder: a grant on it or on a folder above it counts. */
  async rights(user: Principal, folderId: string): Promise<{ row: FolderRow; rights: FolderRights } | null> {
    const chain = await this.ancestry(folderId);
    const row = chain[chain.length - 1];
    if (!row || row.id !== folderId) return null;
    if (row.userId === user.id) return { row, rights: OWNER };
    const ids = chain.map((f) => f.id);
    const read = await this.granted(user, ids, 'read');
    if (read.size === 0) return null;
    const write = await this.granted(user, ids, 'write');
    return { row, rights: { read: true, write: write.size > 0, manage: false } };
  }

  /** A folder the user may at least use, else 404. */
  async get(user: Principal, folderId: string): Promise<{ row: FolderRow; rights: FolderRights }> {
    const found = await this.rights(user, folderId);
    if (!found) throw notFound('Folder');
    return found;
  }

  /**
   * The folders whose instructions and knowledge apply to a chat in
   * `folderId`, top-down: the whole chain for the owner; for someone it was
   * shared with, from the highest folder shared with them down.
   */
  async chain(user: Principal, folderId: string | null): Promise<FolderRow[]> {
    if (!folderId) return [];
    const chain = await this.ancestry(folderId);
    if (chain.length === 0) return [];
    if (chain[chain.length - 1].userId === user.id) return chain;
    const read = await this.granted(user, chain.map((f) => f.id), 'read');
    const top = chain.findIndex((f) => read.has(f.id));
    return top < 0 ? [] : chain.slice(top);
  }

  /** Every folder below this one. */
  async descendants(folderId: string): Promise<string[]> {
    const out: string[] = [];
    let frontier = [folderId];
    while (frontier.length > 0 && out.length < 10_000) {
      const rows = await this.deps.db.select({ id: folders.id }).from(folders).where(inArray(folders.parentId, frontier));
      frontier = rows.map((r) => r.id).filter((id) => !out.includes(id) && id !== folderId);
      out.push(...frontier);
    }
    return out;
  }

  /** Of the owner's folders, those shared with anyone. */
  async withGrants(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.deps.db
      .select({ id: accessGrants.resourceId })
      .from(accessGrants)
      .where(and(eq(accessGrants.resourceType, 'folder'), inArray(accessGrants.resourceId, ids)));
    return new Set(rows.map((r) => r.id));
  }

  /** The user's own folders and those shared with them (with their subfolders). */
  async visible(user: Principal): Promise<VisibleFolder[]> {
    const own = await this.deps.db.select().from(folders).where(eq(folders.userId, user.id)).orderBy(asc(folders.name));
    const out: VisibleFolder[] = own.map((row) => ({ row, rights: OWNER, ownerName: null }));
    if (user.role === 'pending') return out;

    const roots = await this.deps.db
      .select()
      .from(folders)
      .where(and(ne(folders.userId, user.id), this.deps.access.grantedSql(user, 'folder', folders.id, 'read')));
    if (roots.length === 0) return out;
    const writable = await this.granted(user, roots.map((r) => r.id), 'write');

    // Each shared folder brings its subfolders, with its rights (a write grant lower down adds to them)
    const shared = new Map<string, { row: FolderRow; write: boolean }>();
    let frontier = roots.map((row) => ({ row, write: writable.has(row.id) }));
    while (frontier.length > 0) {
      const next: typeof frontier = [];
      for (const f of frontier) {
        const prev = shared.get(f.row.id);
        if (prev && (prev.write || !f.write)) continue;
        shared.set(f.row.id, f);
        next.push(f);
      }
      if (next.length === 0) break;
      const children = await this.deps.db
        .select()
        .from(folders)
        .where(inArray(folders.parentId, next.map((f) => f.row.id)));
      const byParent = new Map(next.map((f) => [f.row.id, f.write]));
      frontier = children.map((row) => ({ row, write: (byParent.get(row.parentId!) ?? false) || writable.has(row.id) }));
    }

    const ownerIds = [...new Set([...shared.values()].map((f) => f.row.userId))];
    const owners = new Map(
      (await this.deps.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ownerIds))).map((u) => [u.id, u.name])
    );
    const sharedList = [...shared.values()].sort((a, b) => a.row.name.localeCompare(b.row.name));
    for (const f of sharedList) {
      out.push({ row: f.row, rights: { read: true, write: f.write, manage: false }, ownerName: owners.get(f.row.userId) ?? null });
    }
    return out;
  }
}

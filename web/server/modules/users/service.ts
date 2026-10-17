import { and, eq, ne, sql } from 'drizzle-orm';
import type { ServerContext } from '../../context';
import { authIdentities, users, type UserRole } from '../../db/schema';
import { uuidv7 } from '../../lib/ids';
import { conflict } from '../../lib/errors';
import { hashPassword } from '../../auth/passwords';
import type { PublicUser } from '../../../shared/auth';

export type UserRow = typeof users.$inferSelect;

export function toPublicUser(u: Pick<UserRow, 'id' | 'email' | 'name' | 'role' | 'passwordHash'>): PublicUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role, hasPassword: !!u.passwordHash };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(ctx: ServerContext, email: string): Promise<UserRow | undefined> {
  const [row] = await ctx.db.select().from(users).where(eq(users.email, normalizeEmail(email)));
  return row;
}

export async function countAdmins(ctx: ServerContext, excludeUserId?: string): Promise<number> {
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.role, 'admin'), excludeUserId ? ne(users.id, excludeUserId) : undefined));
  return Number(row?.n ?? 0);
}

export async function countUsers(ctx: ServerContext): Promise<number> {
  const [row] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(users);
  return Number(row?.n ?? 0);
}

export interface CreateLocalUserInput {
  email: string;
  name: string;
  password: string;
  role: UserRole;
}

export async function createLocalUser(ctx: ServerContext, input: CreateLocalUserInput): Promise<UserRow> {
  const email = normalizeEmail(input.email);
  if (await findUserByEmail(ctx, email)) {
    throw conflict('An account with this email already exists.', 'email_taken');
  }
  const id = uuidv7();
  const [row] = await ctx.db
    .insert(users)
    .values({ id, email, name: input.name.trim(), passwordHash: await hashPassword(input.password), role: input.role })
    .returning();
  await ctx.db.insert(authIdentities).values({ userId: id, provider: 'local', subject: id });
  return row;
}

/**
 * Sign-up: the very first account becomes the admin. Runs under a
 * transaction-scoped advisory lock so two simultaneous first sign-ups can't
 * both become admin.
 */
export async function signupLocalUser(
  ctx: ServerContext,
  input: Omit<CreateLocalUserInput, 'role'>,
  defaultRole: UserRole
): Promise<UserRow> {
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(7421001)`);
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(users);
    const role: UserRole = Number(n) === 0 ? 'admin' : defaultRole;
    const email = normalizeEmail(input.email);
    const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing) throw conflict('An account with this email already exists.', 'email_taken');
    const id = uuidv7();
    const [row] = await tx
      .insert(users)
      .values({ id, email, name: input.name.trim(), passwordHash: await hashPassword(input.password), role })
      .returning();
    await tx.insert(authIdentities).values({ userId: id, provider: 'local', subject: id });
    return row;
  });
}

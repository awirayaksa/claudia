/**
 * Two-factor sign-in with an authenticator app (TOTP). Setting up stores a
 * pending secret; the user proves it with a code, then gets ten single-use
 * recovery codes (shown once). Signing in with a password, the directory or
 * SSO then also asks for a code (see signin.ts).
 */
import { eq } from 'drizzle-orm';
import QRCode from 'qrcode';
import type { ServerContext } from '../context';
import { userMfa } from '../db/schema';
import { badRequest } from '../lib/errors';
import { hashRecoveryCode, newRecoveryCodes, newTotpSecret, otpauthUri, verifyTotp } from './totp';
import type { MfaSetup, MfaStatus } from '../../shared/auth';

type Ctx = Pick<ServerContext, 'db' | 'secrets'>;

export async function mfaStatus(ctx: Ctx, userId: string): Promise<MfaStatus> {
  const [row] = await ctx.db.select().from(userMfa).where(eq(userMfa.userId, userId));
  return { enabled: !!row?.enabledAt, recoveryCodesLeft: row?.enabledAt ? row.recoveryHashes.length : 0 };
}

export async function isMfaEnabled(ctx: Ctx, userId: string): Promise<boolean> {
  return (await mfaStatus(ctx, userId)).enabled;
}

/** A new secret to scan; it takes effect once a code from it is confirmed. */
export async function startMfaSetup(ctx: Ctx, user: { id: string; email: string }, issuer: string): Promise<MfaSetup> {
  const secret = newTotpSecret();
  await ctx.db
    .insert(userMfa)
    .values({ userId: user.id, pendingSecretCipher: ctx.secrets.encrypt(secret) })
    .onConflictDoUpdate({ target: userMfa.userId, set: { pendingSecretCipher: ctx.secrets.encrypt(secret), updatedAt: new Date() } });
  const uri = otpauthUri(issuer, user.email, secret);
  return { secret, uri, qrSvg: await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) };
}

/** Confirm the pending secret with a code from it; returns the recovery codes. */
export async function confirmMfaSetup(ctx: Ctx, userId: string, code: string): Promise<string[]> {
  const [row] = await ctx.db.select().from(userMfa).where(eq(userMfa.userId, userId));
  if (!row?.pendingSecretCipher) throw badRequest('Start the setup first.', 'mfa_not_started');
  const secret = ctx.secrets.decrypt(row.pendingSecretCipher);
  const step = verifyTotp(secret, code);
  if (step === null) throw badRequest("That code doesn't match. Check the time on your phone and try the newest code.", 'mfa_invalid_code');
  const { codes, hashes } = newRecoveryCodes();
  await ctx.db
    .update(userMfa)
    .set({
      secretCipher: row.pendingSecretCipher,
      pendingSecretCipher: null,
      enabledAt: new Date(),
      lastUsedStep: step,
      recoveryHashes: hashes,
      updatedAt: new Date(),
    })
    .where(eq(userMfa.userId, userId));
  return codes;
}

export async function disableMfa(ctx: Ctx, userId: string): Promise<void> {
  await ctx.db.delete(userMfa).where(eq(userMfa.userId, userId));
}

/** New recovery codes (the old ones stop working). */
export async function regenerateRecoveryCodes(ctx: Ctx, userId: string): Promise<string[]> {
  const { codes, hashes } = newRecoveryCodes();
  await ctx.db.update(userMfa).set({ recoveryHashes: hashes, updatedAt: new Date() }).where(eq(userMfa.userId, userId));
  return codes;
}

/**
 * Check a code from the app (each works once) or a recovery code (used up).
 * Returns how it was checked, or null when it doesn't match.
 */
export async function verifyMfaCode(ctx: Ctx, userId: string, code: string): Promise<'totp' | 'recovery' | null> {
  const [row] = await ctx.db.select().from(userMfa).where(eq(userMfa.userId, userId));
  if (!row?.enabledAt || !row.secretCipher) return null;
  const step = verifyTotp(ctx.secrets.decrypt(row.secretCipher), code, { lastUsedStep: row.lastUsedStep });
  if (step !== null) {
    await ctx.db.update(userMfa).set({ lastUsedStep: step, updatedAt: new Date() }).where(eq(userMfa.userId, userId));
    return 'totp';
  }
  const hash = hashRecoveryCode(code);
  if (row.recoveryHashes.includes(hash)) {
    await ctx.db
      .update(userMfa)
      .set({ recoveryHashes: row.recoveryHashes.filter((h) => h !== hash), updatedAt: new Date() })
      .where(eq(userMfa.userId, userId));
    return 'recovery';
  }
  return null;
}

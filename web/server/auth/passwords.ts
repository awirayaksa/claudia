import { hash, verify } from '@node-rs/argon2';

// argon2id with OWASP's recommended minimum (19 MiB, 2 iterations)
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/**
 * Verify against a throwaway hash, so a login for an unknown email takes as
 * long as one for a real account.
 */
export async function burnPasswordCheck(password: string): Promise<false> {
  dummyHash ??= hashPassword('claudia-timing-equalizer');
  await verifyPassword(await dummyHash, password);
  return false;
}

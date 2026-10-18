/**
 * Keys derived from CLAUDIA_SECRET_KEY with HKDF, so one root secret yields
 * independent keys for each purpose.
 */
import { createHash, hkdfSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface DerivedKey {
  /** Short id stored with ciphertexts, so rotation knows which key to use. */
  id: string;
  key: Buffer;
}

export interface Keyring {
  /** Signs session JWTs. */
  jwt: Uint8Array;
  /** Encrypts secrets at rest (API keys, tokens). */
  secrets: DerivedKey;
  /** Old secret keys still accepted for decryption (rotation in progress). */
  previousSecrets: DerivedKey[];
}

function derive(root: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(root, 'utf8'), Buffer.from('claudia'), Buffer.from(purpose), 32));
}

function secretsKey(root: string): DerivedKey {
  const key = derive(root, 'claudia/secrets/v1');
  return { id: createHash('sha256').update(key).digest('hex').slice(0, 8), key };
}

export function createKeyring(rootSecret: string, previousRootSecrets: string[] = []): Keyring {
  return {
    jwt: new Uint8Array(derive(rootSecret, 'claudia/jwt/v1')),
    secrets: secretsKey(rootSecret),
    previousSecrets: previousRootSecrets.map(secretsKey),
  };
}

export interface ResolvedSecret {
  secret: string;
  /** Where it came from, for the startup log. */
  source: 'env' | 'file-existing' | 'file-generated';
  file?: string;
}

/**
 * The root secret from CLAUDIA_SECRET_KEY, or — for trials only — a key file
 * in DATA_DIR, generated on first start. Every backup of DATA_DIR then
 * contains the key next to the data it protects, so the caller logs a warning.
 */
export function resolveRootSecret(envSecret: string | undefined, dataDir: string): ResolvedSecret {
  if (envSecret) return { secret: envSecret, source: 'env' };
  const file = path.join(dataDir, 'secret.key');
  if (fs.existsSync(file)) {
    return { secret: fs.readFileSync(file, 'utf8').trim(), source: 'file-existing', file };
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(48).toString('base64url');
  fs.writeFileSync(file, secret + '\n', { mode: 0o600 });
  return { secret, source: 'file-generated', file };
}

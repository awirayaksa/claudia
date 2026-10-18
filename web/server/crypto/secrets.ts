/**
 * Secrets at rest: AES-256-GCM, stored as `v1:<keyId>:<iv>:<tag>:<ciphertext>`
 * (base64url parts). The key id lets old ciphertexts decrypt during rotation.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { DerivedKey, Keyring } from './keys';

const VERSION = 'v1';

export class SecretBox {
  constructor(private readonly keyring: Keyring) {}

  /** Id of the current key; rows encrypted with another need re-encryption. */
  get currentKeyId(): string {
    return this.keyring.secrets.id;
  }

  encrypt(plaintext: string): string {
    const { id, key } = this.keyring.secrets;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, id, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(':');
  }

  decrypt(value: string): string {
    const [version, keyId, iv, tag, ct] = value.split(':');
    if (version !== VERSION || !keyId || !iv || !tag || ct === undefined) {
      throw new Error('Unrecognized secret format');
    }
    const key = this.findKey(keyId);
    const decipher = createDecipheriv('aes-256-gcm', key.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }

  /** The key id a stored value was encrypted with. */
  keyIdOf(value: string): string | undefined {
    return value.split(':')[1];
  }

  private findKey(id: string): DerivedKey {
    const all = [this.keyring.secrets, ...this.keyring.previousSecrets];
    const found = all.find((k) => k.id === id);
    if (!found) throw new Error(`No key ${id} to decrypt this secret (was CLAUDIA_SECRET_KEY changed?)`);
    return found;
  }
}

/** What the API shows instead of a secret: whether one is set and its last 4 characters. */
export function maskSecret(plaintext: string | null | undefined): { hasKey: boolean; last4?: string } {
  if (!plaintext) return { hasKey: false };
  return { hasKey: true, last4: plaintext.length >= 8 ? plaintext.slice(-4) : undefined };
}

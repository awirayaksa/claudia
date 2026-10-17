/**
 * A way to sign in. Every provider ends in the same session; only how the
 * credentials are checked (and the account found or created) differs.
 */
export type AuthResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'invalid_credentials' | 'disabled' | 'unavailable'; message?: string };

export interface AuthProvider {
  readonly id: 'local' | 'ldap';
  authenticate(identifier: string, password: string): Promise<AuthResult>;
}

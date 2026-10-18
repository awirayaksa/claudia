import type { ServerContext } from '../../context';
import { findUserByEmail } from '../../modules/users/service';
import { burnPasswordCheck, verifyPassword } from '../passwords';
import type { AuthProvider, AuthResult } from './types';

/** Email + password accounts stored in Claudia. */
export class LocalAuthProvider implements AuthProvider {
  readonly id = 'local' as const;

  constructor(private readonly ctx: ServerContext) {}

  async authenticate(email: string, password: string): Promise<AuthResult> {
    if (!this.ctx.config.ENABLE_PASSWORD_AUTH) return { ok: false, reason: 'disabled' };
    const user = await findUserByEmail(this.ctx, email);
    if (!user || !user.passwordHash) {
      await burnPasswordCheck(password);
      return { ok: false, reason: 'invalid_credentials' };
    }
    if (!(await verifyPassword(user.passwordHash, password))) {
      return { ok: false, reason: 'invalid_credentials' };
    }
    return { ok: true, userId: user.id };
  }
}

/**
 * Maintenance commands.
 *
 *   claudia admin create --email a@b.c --password '…' [--name 'Ada']
 *   claudia rotate-keys
 *
 * Production: `node dist/server/cli.cjs <command>`; development: `npm run cli -- <command>`.
 * rotate-keys: set CLAUDIA_SECRET_KEY to the new key and CLAUDIA_SECRET_KEY_PREVIOUS
 * to the old one(s); every stored secret is re-encrypted with the new key.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import { loadConfig } from './config';
import { openDatabase } from './db/client';
import { defaultMigrationsDir } from './paths';
import { createKeyring, resolveRootSecret } from './crypto/keys';
import { SecretBox } from './crypto/secrets';
import { providerConnections, users } from './db/schema';
import { hashPassword } from './auth/passwords';
import { createLocalUser, findUserByEmail } from './modules/users/service';
import type { ServerContext } from './context';

function usage(): never {
  console.error(
    'Usage:\n  claudia admin create --email <email> --password <password> [--name <name>]\n  claudia rotate-keys'
  );
  process.exit(2);
}

async function main() {
  const [command, sub, ...rest] = process.argv.slice(2);
  const config = loadConfig();
  const db = await openDatabase({
    url: config.DATABASE_URL,
    dataDir: config.DATABASE_URL ? undefined : path.join(config.dataDir, 'pglite'),
  });
  try {
    await db.migrate(defaultMigrationsDir());
    const secret = resolveRootSecret(config.CLAUDIA_SECRET_KEY, config.dataDir);
    const secrets = new SecretBox(createKeyring(secret.secret, config.previousSecretKeys));

    if (command === 'admin' && sub === 'create') {
      const { values } = parseArgs({
        args: rest,
        options: { email: { type: 'string' }, password: { type: 'string' }, name: { type: 'string' } },
      });
      if (!values.email || !values.password) usage();
      if (values.password.length < 8) throw new Error('The password needs at least 8 characters.');
      const existing = await findUserByEmail({ db: db.db } as ServerContext, values.email);
      if (existing) {
        await db.db
          .update(users)
          .set({ role: 'admin', passwordHash: await hashPassword(values.password), updatedAt: new Date() })
          .where(eq(users.id, existing.id));
        console.log(`${existing.email} is now an admin, with the new password.`);
      } else {
        const user = await createLocalUser({ db: db.db } as ServerContext, {
          email: values.email,
          password: values.password,
          name: values.name ?? 'Administrator',
          role: 'admin',
        });
        console.log(`Created admin ${user.email}.`);
      }
      return;
    }

    if (command === 'rotate-keys') {
      const rows = await db.db.select().from(providerConnections);
      let changed = 0;
      for (const row of rows) {
        if (!row.keyCipher || secrets.keyIdOf(row.keyCipher) === secrets.currentKeyId) continue;
        const plain = secrets.decrypt(row.keyCipher);
        await db.db
          .update(providerConnections)
          .set({ keyCipher: secrets.encrypt(plain), keyVersion: secrets.currentKeyId })
          .where(eq(providerConnections.id, row.id));
        changed++;
      }
      console.log(`Re-encrypted ${changed} secret(s) with key ${secrets.currentKeyId}.`);
      return;
    }

    usage();
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

/**
 * Skills, stored as `prompts` rows with mode 'system'. Built-ins are global
 * rows seeded from skill-core at startup; users add their own.
 */
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { prompts } from '../../db/schema';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { uuidv7 } from '../../lib/ids';
import {
  builtinSkills,
  isBuiltinSkillId,
  resolveSkillInvocation,
  validateSkillId,
} from '../../../../electron/services/skill-core';
import type { Skill, SkillWritePayload } from '../../../../src/types/skill.types';

type PromptRow = typeof prompts.$inferSelect;

function toSkill(row: PromptRow): Skill {
  return {
    id: row.command,
    name: row.title,
    description: row.description,
    body: row.body,
    builtin: row.builtin,
    filePath: null,
  };
}

export class SkillService {
  constructor(private readonly db: Database) {}

  /** Insert or refresh the built-in skills (idempotent). */
  async seedBuiltins(): Promise<void> {
    for (const s of builtinSkills()) {
      await this.db
        .insert(prompts)
        .values({ id: uuidv7(), ownerId: null, command: s.id, title: s.name, description: s.description, body: s.body, builtin: true })
        .onConflictDoUpdate({
          target: [prompts.ownerId, prompts.command],
          set: { title: s.name, description: s.description, body: s.body, builtin: true, updatedAt: new Date() },
        });
    }
  }

  /** Built-ins, then the user's own. */
  async list(userId: string): Promise<Skill[]> {
    const rows = await this.db
      .select()
      .from(prompts)
      .where(and(eq(prompts.mode, 'system'), or(isNull(prompts.ownerId), eq(prompts.ownerId, userId))))
      .orderBy(asc(prompts.builtin), asc(prompts.command));
    return rows.sort((a, b) => Number(b.builtin) - Number(a.builtin)).map(toSkill);
  }

  /** A skill the user may run: their own, else the built-in with that command. */
  async find(userId: string, command: string): Promise<Skill | null> {
    const rows = await this.db
      .select()
      .from(prompts)
      .where(and(eq(prompts.command, command), eq(prompts.mode, 'system'), or(isNull(prompts.ownerId), eq(prompts.ownerId, userId))));
    const own = rows.find((r) => r.ownerId === userId);
    const row = own ?? rows.find((r) => r.ownerId === null);
    return row ? toSkill(row) : null;
  }

  /** The system prompt for `/command args`, or null when there's no such skill. */
  async resolve(userId: string, command: string, args: string): Promise<string | null> {
    const skill = await this.find(userId, command);
    return skill ? resolveSkillInvocation(skill.body, args) : null;
  }

  async create(userId: string, payload: SkillWritePayload): Promise<Skill> {
    try {
      validateSkillId(payload.id);
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err), 'invalid_skill_id');
    }
    if (isBuiltinSkillId(payload.id)) {
      throw conflict(`"${payload.id}" is a built-in skill. Choose another name.`, 'skill_builtin');
    }
    const [existing] = await this.db
      .select({ id: prompts.id })
      .from(prompts)
      .where(and(eq(prompts.ownerId, userId), eq(prompts.command, payload.id)));
    if (existing) throw conflict(`You already have a skill called /${payload.id}.`, 'skill_exists');
    const [row] = await this.db
      .insert(prompts)
      .values({
        id: uuidv7(),
        ownerId: userId,
        command: payload.id,
        title: payload.name,
        description: payload.description,
        body: payload.body,
        mode: 'system',
      })
      .returning();
    return toSkill(row);
  }

  async update(userId: string, payload: SkillWritePayload): Promise<Skill> {
    const [row] = await this.db
      .update(prompts)
      .set({ title: payload.name, description: payload.description, body: payload.body, updatedAt: new Date() })
      .where(and(eq(prompts.ownerId, userId), eq(prompts.command, payload.id)))
      .returning();
    if (!row) throw notFound('Skill');
    return toSkill(row);
  }

  async delete(userId: string, command: string): Promise<void> {
    const deleted = await this.db
      .delete(prompts)
      .where(and(eq(prompts.ownerId, userId), eq(prompts.command, command)))
      .returning({ id: prompts.id });
    if (deleted.length === 0) {
      throw isBuiltinSkillId(command) ? conflict('Built-in skills cannot be deleted.', 'skill_builtin') : notFound('Skill');
    }
  }
}

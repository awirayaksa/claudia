/**
 * The models users can pick, aggregated across enabled global connections,
 * the user's own (with the connections.own permission; ids
 * "@<prefix>/<model>", requests through the SSRF guard) and the custom
 * models they can see ("custom/<uuid>").
 * Listing an endpoint is slow, so results are cached briefly; a connection
 * whose listing fails keeps its last good list and reports the error.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { IAPIProvider } from '../../../src/services/api/provider.interface';
import type { Database } from '../db/client';
import { customModels, providerConnections, users, type UserRole } from '../db/schema';
import type { SecretBox } from '../crypto/secrets';
import type { AppSettings } from '../modules/settings/app-settings';
import type { Cluster } from '../cluster/cluster';
import { forbidden, notFound } from '../lib/errors';
import type { ModelInfo } from '../../shared/models';
import { createProvider } from './provider-registry';
import { guardedTransport, type GuardedTransport } from '../net/safe-fetch';
import type { AccessService, Principal } from '../auth/access';
import { CUSTOM_MODEL_PREFIX, customModelKey } from '../../shared/workspace';

export type ConnectionRow = typeof providerConnections.$inferSelect;
export type CustomModelRow = typeof customModels.$inferSelect;

const CACHE_MS = 60_000;
const LIST_TIMEOUT_MS = 15_000;

export interface ResolvedModel {
  model: ModelInfo;
  /** The model id the provider expects. */
  providerModelId: string;
  connection: ConnectionRow;
  provider: IAPIProvider;
  /** Set when `model` is a custom model (its base model is what gets called). */
  custom?: CustomModelRow;
}

interface ConnectionState {
  models: ModelInfo[];
  error: string | null;
  fetchedAt: number;
}

export function splitModelKey(key: string): { prefix: string; modelId: string } | null {
  const slash = key.indexOf('/');
  if (slash <= 0 || slash === key.length - 1) return null;
  return { prefix: key.slice(0, slash), modelId: key.slice(slash + 1) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The id in a custom model key, or null for any other key. */
export function customModelId(key: string): string | null {
  const split = splitModelKey(key);
  return split && split.prefix === CUSTOM_MODEL_PREFIX && UUID.test(split.modelId) ? split.modelId : null;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms).unref?.()),
  ]);
}

export class ModelRegistry {
  private states = new Map<string, ConnectionState>();
  private providers = new Map<string, { stamp: number; provider: IAPIProvider }>();
  private inflight: Promise<void> | null = null;
  /** Transport of user-owned connections. */
  private readonly guarded: GuardedTransport;

  constructor(
    private readonly deps: {
      db: Database;
      secrets: SecretBox;
      settings: AppSettings;
      access: AccessService;
      log: FastifyBaseLogger;
      cluster?: Cluster;
    }
  ) {
    this.guarded = guardedTransport(() => ({ allow: deps.settings.peek('net.allowlist').hosts }));
    deps.cluster?.on('models', ({ connectionId }) => this.forget(connectionId as string | undefined));
  }

  /** Enabled global connections, in display order. */
  async connections(): Promise<ConnectionRow[]> {
    return this.deps.db
      .select()
      .from(providerConnections)
      .where(isNull(providerConnections.ownerId))
      .orderBy(asc(providerConnections.position), asc(providerConnections.createdAt));
  }

  /** A user's own connections, in display order. */
  async ownConnections(userId: string): Promise<ConnectionRow[]> {
    return this.deps.db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.ownerId, userId))
      .orderBy(asc(providerConnections.position), asc(providerConnections.createdAt));
  }

  /** Models of the user's own enabled connections (none without the connections.own permission). */
  async own(user: Principal, opts: { refresh?: boolean } = {}): Promise<ModelInfo[]> {
    if (!(await this.deps.access.can(user, 'connections.own'))) return [];
    const conns = (await this.ownConnections(user.id)).filter((c) => c.enabled);
    const stale = conns.filter((c) => {
      const s = this.states.get(c.id);
      return opts.refresh || !s || Date.now() - s.fetchedAt > CACHE_MS;
    });
    await Promise.all(stale.map((c) => this.refresh(c)));
    return conns.flatMap((c) => this.states.get(c.id)?.models ?? []);
  }

  /** What this user may pick: global models, their own, then custom models. */
  async forUser(user: Principal): Promise<ModelInfo[]> {
    if (user.role === 'pending') return [];
    return [...(await this.allowedGlobal(user)), ...(await this.own(user)), ...(await this.customFor(user))];
  }

  /** Global models the user may use: admins all, users the role allowlist plus their groups' models. */
  async allowedGlobal(user: Principal): Promise<ModelInfo[]> {
    if (user.role !== 'user') return this.forRole(user.role);
    const models = await this.all();
    const { user: list } = await this.deps.settings.get('models.allowlist');
    if (list === null) return models;
    const allowed = new Set([...list, ...(await this.deps.access.groupModels(user.id))]);
    return models.filter((m) => allowed.has(m.id));
  }

  /**
   * Active custom models the user can see whose base model their owner may
   * still use: a shared model runs with its owner's model access.
   */
  async customFor(user: Principal): Promise<ModelInfo[]> {
    const rows = await this.deps.db
      .select()
      .from(customModels)
      .where(and(eq(customModels.active, true), this.deps.access.visibleSql(user, 'model', customModels.id, customModels.ownerId)))
      .orderBy(asc(customModels.name));
    if (rows.length === 0) return [];
    const bases = await this.baseModelsByOwner([...new Set(rows.map((r) => r.ownerId))]);
    return rows.flatMap((r) => {
      const base = bases.get(r.ownerId)?.find((m) => m.id === r.baseModelId);
      return base ? [this.customInfo(r, base)] : [];
    });
  }

  /** For each owner, the global models they may use (what their custom models can run on). */
  async baseModelsByOwner(ownerIds: string[]): Promise<Map<string, ModelInfo[]>> {
    const owners = ownerIds.length
      ? await this.deps.db.select({ id: users.id, role: users.role }).from(users).where(inArray(users.id, ownerIds))
      : [];
    const out = new Map<string, ModelInfo[]>();
    for (const o of owners) out.set(o.id, await this.allowedGlobal(o));
    return out;
  }

  private customInfo(row: CustomModelRow, base: ModelInfo): ModelInfo {
    return {
      id: customModelKey(row.id),
      name: row.name,
      connectionId: base.connectionId,
      connectionName: base.connectionName,
      contextLength: base.contextLength,
      custom: true,
      ...(row.description ? { description: row.description } : {}),
      ...(row.suggestions.length ? { suggestions: row.suggestions } : {}),
    };
  }

  /** The provider instance for a connection (rebuilt when the row changes). */
  providerFor(conn: ConnectionRow): IAPIProvider {
    const stamp = conn.updatedAt.getTime();
    const cached = this.providers.get(conn.id);
    if (cached && cached.stamp === stamp) return cached.provider;
    const provider = createProvider({
      type: conn.type,
      baseUrl: conn.baseUrl,
      apiKey: conn.keyCipher ? this.deps.secrets.decrypt(conn.keyCipher) : '',
      quirks: conn.quirks,
      ...(conn.ownerId ? { http: this.guarded } : {}),
    });
    this.providers.set(conn.id, { stamp, provider });
    return provider;
  }

  /** Forget cached lists (after a connection changes), here and on the other instances. */
  invalidate(connectionId?: string): void {
    this.forget(connectionId);
    this.deps.cluster?.signal('models', connectionId ? { connectionId } : {});
  }

  private forget(connectionId?: string): void {
    if (connectionId) {
      this.states.delete(connectionId);
      this.providers.delete(connectionId);
    } else {
      this.states.clear();
      this.providers.clear();
    }
  }

  status(connectionId: string): { modelCount: number; error: string | null } {
    const s = this.states.get(connectionId);
    return { modelCount: s?.models.length ?? 0, error: s?.error ?? null };
  }

  /** Every model of every enabled connection. */
  async all(opts: { refresh?: boolean } = {}): Promise<ModelInfo[]> {
    const conns = (await this.connections()).filter((c) => c.enabled);
    const stale = conns.filter((c) => {
      const s = this.states.get(c.id);
      return opts.refresh || !s || Date.now() - s.fetchedAt > CACHE_MS;
    });
    if (stale.length > 0) {
      this.inflight ??= Promise.all(stale.map((c) => this.refresh(c))).then(() => {
        this.inflight = null;
      });
      await this.inflight;
    }
    return conns.flatMap((c) => this.states.get(c.id)?.models ?? []);
  }

  /** What one role may use: admins everything, users the allowlist, pending nothing. */
  async forRole(role: UserRole): Promise<ModelInfo[]> {
    if (role === 'pending') return [];
    const models = await this.all();
    if (role === 'admin') return models;
    const { user } = await this.deps.settings.get('models.allowlist');
    if (user === null) return models;
    const allowed = new Set(user);
    return models.filter((m) => allowed.has(m.id));
  }

  /**
   * Find a model the role may use, with a provider ready to call. With a user
   * id, that user's own connections, groups and custom models count too.
   */
  async resolve(key: string, role: UserRole, userId?: string): Promise<ResolvedModel> {
    const customId = customModelId(key);
    if (customId) return this.resolveCustom(customId, { id: userId ?? '', role });
    const split = splitModelKey(key);
    if (!split) throw notFound('Model');
    const available = userId ? await this.forUser({ id: userId, role }) : await this.forRole(role);
    const model = available.find((m) => m.id === key);
    if (!model) {
      const exists = (await this.all()).some((m) => m.id === key);
      throw exists ? forbidden('You are not allowed to use this model.', 'model_not_allowed') : notFound('Model');
    }
    const [connection] = await this.deps.db
      .select()
      .from(providerConnections)
      .where(
        model.own && userId
          ? and(eq(providerConnections.id, model.connectionId), eq(providerConnections.ownerId, userId))
          : and(eq(providerConnections.id, model.connectionId), isNull(providerConnections.ownerId))
      );
    if (!connection || !connection.enabled) throw notFound('Model');
    return { model, providerModelId: split.modelId, connection, provider: this.providerFor(connection) };
  }

  /** A custom model the user can see, on its base model resolved with the owner's access. */
  private async resolveCustom(id: string, user: Principal): Promise<ResolvedModel> {
    const [row] = await this.deps.db.select().from(customModels).where(eq(customModels.id, id));
    if (!row || !(await this.deps.access.rights(user, 'model', row)).read) throw notFound('Model');
    if (!row.active) throw forbidden('This model is turned off.', 'model_inactive');
    const [owner] = await this.deps.db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, row.ownerId));
    const base = owner ? (await this.allowedGlobal(owner)).find((m) => m.id === row.baseModelId) : undefined;
    if (!base) throw forbidden('The model this one is built on is no longer available.', 'base_model_unavailable');
    const resolved = await this.resolve(base.id, 'admin');
    return { ...resolved, model: this.customInfo(row, base), custom: row };
  }

  /** The admin-set default if usable, else the first model the role may use. */
  async defaultFor(role: UserRole): Promise<string | null> {
    const models = await this.forRole(role);
    const { model } = await this.deps.settings.get('models.default');
    if (model && models.some((m) => m.id === model)) return model;
    return models[0]?.id ?? null;
  }

  private async refresh(conn: ConnectionRow): Promise<void> {
    const prev = this.states.get(conn.id);
    const filter = conn.modelFilter;
    try {
      const listed = await withTimeout(this.providerFor(conn).getModels(), LIST_TIMEOUT_MS, 'Listing models');
      let ids = listed.map((m) => ({ id: m.id, name: m.name || m.id, contextLength: m.context_length ?? null }));
      if (filter && filter.length > 0) {
        const wanted = new Set(filter);
        const kept = ids.filter((m) => wanted.has(m.id));
        // Endpoints without /models: offer the configured ids as they are
        ids = kept.length > 0 ? kept : filter.map((id) => ({ id, name: id, contextLength: null }));
      }
      this.states.set(conn.id, { models: ids.map((m) => this.toInfo(conn, m)), error: null, fetchedAt: Date.now() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log.warn({ connection: conn.name, err: message }, 'listing models failed');
      const fallback = filter?.map((id) => this.toInfo(conn, { id, name: id, contextLength: null })) ?? [];
      this.states.set(conn.id, {
        models: prev?.models.length ? prev.models : fallback,
        error: message,
        fetchedAt: Date.now(),
      });
    }
  }

  private toInfo(conn: ConnectionRow, m: { id: string; name: string; contextLength: number | null }): ModelInfo {
    return {
      // Own connections live in their own namespace, so they never shadow global ones
      id: `${conn.ownerId ? '@' : ''}${conn.prefix}/${m.id}`,
      name: m.name,
      connectionId: conn.id,
      connectionName: conn.name,
      contextLength: m.contextLength,
      ...(conn.ownerId ? { own: true } : {}),
    };
  }
}

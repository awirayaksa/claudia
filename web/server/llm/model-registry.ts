/**
 * The models users can pick, aggregated across enabled global connections.
 * Listing an endpoint is slow, so results are cached briefly; a connection
 * whose listing fails keeps its last good list and reports the error.
 */
import { asc, eq, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { IAPIProvider } from '../../../src/services/api/provider.interface';
import type { Database } from '../db/client';
import { providerConnections, type UserRole } from '../db/schema';
import type { SecretBox } from '../crypto/secrets';
import type { AppSettings } from '../modules/settings/app-settings';
import { forbidden, notFound } from '../lib/errors';
import type { ModelInfo } from '../../shared/models';
import { createProvider } from './provider-registry';

export type ConnectionRow = typeof providerConnections.$inferSelect;

const CACHE_MS = 60_000;
const LIST_TIMEOUT_MS = 15_000;

export interface ResolvedModel {
  model: ModelInfo;
  /** The model id the provider expects. */
  providerModelId: string;
  connection: ConnectionRow;
  provider: IAPIProvider;
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

  constructor(
    private readonly deps: { db: Database; secrets: SecretBox; settings: AppSettings; log: FastifyBaseLogger }
  ) {}

  /** Enabled global connections, in display order. */
  async connections(): Promise<ConnectionRow[]> {
    return this.deps.db
      .select()
      .from(providerConnections)
      .where(isNull(providerConnections.ownerId))
      .orderBy(asc(providerConnections.position), asc(providerConnections.createdAt));
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
    });
    this.providers.set(conn.id, { stamp, provider });
    return provider;
  }

  /** Forget cached lists (after a connection changes). */
  invalidate(connectionId?: string): void {
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

  /** Find a model the role may use, with a provider ready to call. */
  async resolve(key: string, role: UserRole): Promise<ResolvedModel> {
    const split = splitModelKey(key);
    if (!split) throw notFound('Model');
    const available = await this.forRole(role);
    const model = available.find((m) => m.id === key);
    if (!model) {
      const exists = (await this.all()).some((m) => m.id === key);
      throw exists ? forbidden('You are not allowed to use this model.', 'model_not_allowed') : notFound('Model');
    }
    const [connection] = await this.deps.db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.id, model.connectionId));
    if (!connection || !connection.enabled) throw notFound('Model');
    return { model, providerModelId: split.modelId, connection, provider: this.providerFor(connection) };
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
      id: `${conn.prefix}/${m.id}`,
      name: m.name,
      connectionId: conn.id,
      connectionName: conn.name,
      contextLength: m.contextLength,
    };
  }
}

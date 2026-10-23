/**
 * GitHub repositories as knowledge: a sync job reads the repository's tree
 * at a branch, tag or commit, keeps the files under the chosen paths that
 * Claudia can read, and brings each new or changed one in as a file of the
 * knowledge base (indexed like an upload). Files that are gone from the
 * repository leave the knowledge base. A sync at an unchanged commit does
 * nothing. Every request goes through the SSRF guard.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../db/client';
import { files, kbFiles, kbSources, knowledgeBases, type GitHubSourceConfig, type GitHubSourceState } from '../db/schema';
import type { SecretBox } from '../crypto/secrets';
import type { JobQueue } from '../jobs/queue';
import type { FileService } from '../modules/files/service';
import { readBodyLimited, safeFetch, type SafeFetchPolicy } from '../net/safe-fetch';
import { detectDocumentFormat } from '../../../electron/services/builtin-mcp/document-extractor';
import { workspaceMime } from '../../shared/workspace-files';
import type { KbSourceView } from '../../shared/knowledge';
import type { KnowledgeService } from './knowledge';

/** At most this many files from one repository. */
export const MAX_SOURCE_FILES = 500;
/** Larger files are skipped. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const API = 'https://api.github.com';

type SourceRow = typeof kbSources.$inferSelect;

export function toSourceView(row: SourceRow): KbSourceView {
  return {
    id: row.id,
    kind: row.kind,
    repo: row.config.repo,
    ref: row.config.ref,
    paths: row.config.paths,
    apiUrl: row.config.apiUrl,
    hasToken: !!row.tokenCipher,
    status: row.status,
    error: row.error,
    commit: row.state.commit ?? null,
    fileCount: Object.keys(row.state.files ?? {}).length,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
  };
}

/** Whether a path is under one of the chosen folders or files (none chosen: everything). */
export function pathWanted(path: string, paths: string[]): boolean {
  if (paths.length === 0) return true;
  return paths.some((p) => {
    const clean = p.replace(/^\/+/, '');
    if (clean === '' || clean === '/') return true;
    return path === clean.replace(/\/+$/, '') || path.startsWith(clean.endsWith('/') ? clean : `${clean}/`);
  });
}

/** Files Claudia can read: documents, text and code (HTML too). */
export function readablePath(path: string): boolean {
  return /\.html?$/i.test(path) || detectDocumentFormat(path) !== null;
}

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

export class GitHubSources {
  constructor(
    private readonly deps: {
      db: Database;
      secrets: SecretBox;
      files: FileService;
      knowledge: KnowledgeService;
      jobs: JobQueue;
      policy: () => SafeFetchPolicy;
      log: FastifyBaseLogger;
    }
  ) {
    deps.jobs.register('kb.source-sync', (p) => this.sync(String(p.sourceId)));
  }

  async queue(sourceId: string): Promise<void> {
    await this.deps.db.update(kbSources).set({ status: 'queued', error: null }).where(eq(kbSources.id, sourceId));
    await this.deps.jobs.enqueue('kb.source-sync', { sourceId });
  }

  private async api<T>(config: GitHubSourceConfig, token: string | null, path: string, accept = 'application/vnd.github+json'): Promise<{ status: number; body: T; raw: Buffer }> {
    const base = (config.apiUrl ?? API).replace(/\/+$/, '');
    const res = await safeFetch(`${base}${path}`, {
      policy: this.deps.policy(),
      timeoutMs: 60_000,
      headers: {
        Accept: accept,
        'User-Agent': 'Claudia',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    const raw = await readBodyLimited(res, MAX_FILE_BYTES + 1024 * 1024);
    let body: T = undefined as T;
    if (accept.includes('json')) {
      try {
        body = JSON.parse(raw.toString('utf-8')) as T;
      } catch {
        /* not JSON */
      }
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(token ? 'GitHub refused the token (it may be expired, or lack read access to the contents).' : 'GitHub refused: for a private repository, add a token.');
    }
    if (res.status === 404) throw new Error(`Not found on GitHub: ${config.repo}${config.ref ? `@${config.ref}` : ''}. Check the name, the branch, and the token for private repositories.`);
    if (res.status >= 400) throw new Error(`GitHub answered ${res.status}: ${(body as { message?: string })?.message ?? raw.toString('utf-8').slice(0, 200)}`);
    return { status: res.status, body, raw };
  }

  /** Bring the knowledge base up to date with the repository. */
  async sync(sourceId: string): Promise<void> {
    const [source] = await this.deps.db.select().from(kbSources).where(eq(kbSources.id, sourceId));
    if (!source) return;
    const [kb] = await this.deps.db.select().from(knowledgeBases).where(eq(knowledgeBases.id, source.kbId));
    if (!kb) return;
    await this.deps.db.update(kbSources).set({ status: 'syncing', error: null }).where(eq(kbSources.id, sourceId));
    try {
      const state = await this.pull(source, kb.ownerId);
      await this.deps.db
        .update(kbSources)
        .set({ state, status: 'ready', error: null, lastSyncedAt: new Date() })
        .where(eq(kbSources.id, sourceId));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log.warn({ sourceId, repo: source.config.repo, err: message }, 'syncing a GitHub source failed');
      await this.deps.db.update(kbSources).set({ status: 'failed', error: message }).where(eq(kbSources.id, sourceId));
    }
  }

  private async pull(source: SourceRow, ownerId: string): Promise<GitHubSourceState> {
    const { config } = source;
    const token = source.tokenCipher ? this.deps.secrets.decrypt(source.tokenCipher) : null;
    const repo = config.repo.split('/').map(encodeURIComponent).join('/');

    const ref = config.ref || (await this.api<{ default_branch: string }>(config, token, `/repos/${repo}`)).body.default_branch;
    const commit = (await this.api<{ sha: string }>(config, token, `/repos/${repo}/commits/${encodeURIComponent(ref)}`)).body.sha;
    if (!commit) throw new Error(`GitHub gave no commit for ${ref}.`);
    const previous = source.state.files ?? {};
    if (commit === source.state.commit) return source.state;

    const tree = (await this.api<{ tree: TreeEntry[]; truncated?: boolean }>(config, token, `/repos/${repo}/git/trees/${commit}?recursive=1`)).body;
    const wanted = (tree.tree ?? [])
      .filter((e) => e.type === 'blob' && pathWanted(e.path, config.paths) && readablePath(e.path) && (e.size ?? 0) <= MAX_FILE_BYTES)
      .slice(0, MAX_SOURCE_FILES);

    const next: Record<string, { sha: string; fileId: string }> = {};
    for (const entry of wanted) {
      const before = previous[entry.path];
      if (before && before.sha === entry.sha) {
        next[entry.path] = before;
        continue;
      }
      const blob = await this.api<never>(config, token, `/repos/${repo}/git/blobs/${entry.sha}`, 'application/vnd.github.raw');
      // Named by its path, so citations say where it came from
      const row = await this.deps.files.ingest(ownerId, { name: entry.path, mime: workspaceMime(entry.path) === 'application/octet-stream' ? 'text/plain' : workspaceMime(entry.path), data: blob.raw });
      await this.deps.db.insert(kbFiles).values({ kbId: source.kbId, fileId: row.id, addedBy: source.createdBy }).onConflictDoNothing();
      await this.deps.knowledge.queue(source.kbId, row.id);
      next[entry.path] = { sha: entry.sha, fileId: row.id };
      if (before) await this.dropFile(source.kbId, ownerId, before.fileId);
    }
    // Gone from the repository (or no longer chosen)
    for (const [path, old] of Object.entries(previous)) {
      if (!next[path]) await this.dropFile(source.kbId, ownerId, old.fileId);
    }
    return { commit, files: next };
  }

  /** Take one of a source's files out of the knowledge base, and delete it. */
  async dropFile(kbId: string, ownerId: string, fileId: string): Promise<void> {
    await this.deps.db.delete(kbFiles).where(and(eq(kbFiles.kbId, kbId), eq(kbFiles.fileId, fileId)));
    await this.deps.db.execute(sql`delete from chunks where kb_id = ${kbId}::uuid and file_id = ${fileId}::uuid`);
    // Only if nothing else uses it (another knowledge base, a chat attachment)
    const [{ n }] = await this.deps.db.select({ n: sql<number>`count(*)::int` }).from(kbFiles).where(eq(kbFiles.fileId, fileId));
    if (Number(n) === 0) {
      const [file] = await this.deps.db.select({ id: files.id }).from(files).where(and(eq(files.id, fileId), eq(files.userId, ownerId)));
      if (file) await this.deps.files.delete(ownerId, fileId).catch(() => {});
    }
  }

  /** Remove a source and the files it brought in. */
  async remove(source: SourceRow, ownerId: string): Promise<void> {
    for (const f of Object.values(source.state.files ?? {})) await this.dropFile(source.kbId, ownerId, f.fileId);
    await this.deps.db.delete(kbSources).where(eq(kbSources.id, source.id));
  }
}

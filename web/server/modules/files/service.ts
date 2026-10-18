import { createHash } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../../db/client';
import { files } from '../../db/schema';
import { notFound } from '../../lib/errors';
import { uuidv7 } from '../../lib/ids';
import type { Storage } from '../../storage/local';
import type { ExtractPool } from '../../extract/pool';
import type { FileView } from '../../../shared/files';

export type FileRow = typeof files.$inferSelect;

/** Images the model may see, recognised by their first bytes (not the claimed type). */
const IMAGE_SIGNATURES: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
  { mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', test: (b) => b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a' },
  { mime: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

export function sniffImage(data: Buffer): string | null {
  return IMAGE_SIGNATURES.find((s) => s.test(data))?.mime ?? null;
}

/** Images sent to the model inline are capped at this size. */
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

export class FileService {
  constructor(
    private readonly deps: { db: Database; storage: Storage; extract: ExtractPool; log: FastifyBaseLogger }
  ) {}

  toView(f: FileRow): FileView {
    return {
      id: f.id,
      name: f.name,
      mime: f.mime,
      size: f.size,
      status: f.status,
      error: f.error,
      hasText: !!f.extractedTextKey,
      textTruncated: f.textTruncated,
      createdAt: f.createdAt.toISOString(),
    };
  }

  /** Store an upload and extract its text (documents) before returning. */
  async ingest(userId: string, input: { name: string; mime: string; data: Buffer }): Promise<FileRow> {
    const { db, storage, extract } = this.deps;
    const id = uuidv7();
    const storageKey = `files/${userId}/${id}`;
    const image = sniffImage(input.data);
    const mime = image ?? (input.mime || 'application/octet-stream');
    await storage.put(storageKey, input.data);
    await db.insert(files).values({
      id,
      userId,
      name: input.name.slice(0, 255) || 'file',
      mime,
      size: input.data.byteLength,
      sha256: createHash('sha256').update(input.data).digest('hex'),
      storageKey,
      status: image ? 'ready' : 'processing',
    });

    if (!image) {
      try {
        const doc = await extract.documentText(input.data, input.name, mime);
        if (!doc) {
          await this.update(id, {
            status: 'failed',
            error: "This file type can't be read. Attach PDF, Word, Excel, PowerPoint, text or image files.",
          });
        } else {
          const textKey = `${storageKey}.txt`;
          await storage.put(textKey, Buffer.from(doc.text, 'utf-8'));
          await this.update(id, { status: 'ready', extractedTextKey: textKey, textTruncated: doc.truncated });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.log.warn({ fileId: id, err: message }, 'extraction failed');
        await this.update(id, { status: 'failed', error: message });
      }
    }
    const [row] = await db.select().from(files).where(eq(files.id, id));
    return row;
  }

  private async update(id: string, patch: Partial<FileRow>): Promise<void> {
    await this.deps.db.update(files).set(patch).where(eq(files.id, id));
  }

  async getOwned(userId: string, id: string): Promise<FileRow> {
    const [row] = await this.deps.db.select().from(files).where(and(eq(files.id, id), eq(files.userId, userId)));
    if (!row) throw notFound('File');
    return row;
  }

  async listOwned(userId: string, limit = 100): Promise<FileRow[]> {
    return this.deps.db.select().from(files).where(eq(files.userId, userId)).orderBy(desc(files.createdAt)).limit(limit);
  }

  /** The user's files among `ids` (others are silently left out). */
  async ownedByIds(userId: string, ids: string[]): Promise<FileRow[]> {
    if (ids.length === 0) return [];
    return this.deps.db.select().from(files).where(and(eq(files.userId, userId), inArray(files.id, ids)));
  }

  async delete(userId: string, id: string): Promise<void> {
    const row = await this.getOwned(userId, id);
    await this.deps.db.delete(files).where(eq(files.id, id));
    await this.deps.storage.delete(row.storageKey);
    if (row.extractedTextKey) await this.deps.storage.delete(row.extractedTextKey);
  }

  /** What the model gets for a file: extracted text, or an image as a data URL. */
  async forModel(row: FileRow): Promise<{ kind: 'text'; text: string; truncated?: boolean } | { kind: 'image'; url: string } | null> {
    if (row.status !== 'ready') return null;
    if (row.extractedTextKey) {
      const text = (await this.deps.storage.get(row.extractedTextKey)).toString('utf-8');
      return { kind: 'text', text, truncated: row.textTruncated };
    }
    if (row.mime.startsWith('image/') && row.size <= MAX_INLINE_IMAGE_BYTES) {
      const data = await this.deps.storage.get(row.storageKey);
      return { kind: 'image', url: `data:${row.mime};base64,${data.toString('base64')}` };
    }
    return null;
  }
}

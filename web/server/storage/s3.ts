/**
 * File storage in an S3 bucket (AWS, or a compatible server such as MinIO,
 * Ceph or Garage with S3_ENDPOINT and usually S3_FORCE_PATH_STYLE). Every
 * instance sees the same files, unlike DATA_DIR on one machine's disk.
 */
import { PassThrough, Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import type { Storage } from './local';

const KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/;

export interface S3StorageOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  /** Prepended to every key, e.g. "claudia/". */
  prefix?: string;
}

const isMissing = (err: unknown) => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
};

/** Same shape as the local disk's error, so callers treat a missing file the same way. */
function missing(key: string): Error {
  return Object.assign(new Error(`No stored file at ${key}`), { code: 'ENOENT' });
}

export class S3Storage implements Storage {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(opts: S3StorageOptions) {
    const config: S3ClientConfig = {
      region: opts.region,
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      forcePathStyle: opts.forcePathStyle ?? false,
      ...(opts.accessKeyId && opts.secretAccessKey
        ? { credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey } }
        : {}),
    };
    this.client = new S3Client(config);
    this.bucket = opts.bucket;
    this.prefix = opts.prefix ?? '';
  }

  private key(key: string): string {
    if (!KEY_RE.test(key) || key.includes('..')) throw new Error(`Invalid storage key: ${key}`);
    return this.prefix + key;
  }

  async put(key: string, data: Buffer): Promise<void> {
    // A single PUT is atomic: readers see the old object or the new one
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.key(key), Body: data, ContentLength: data.length }));
  }

  async get(key: string): Promise<Buffer> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
      return Buffer.from(await res.Body!.transformToByteArray());
    } catch (err) {
      throw isMissing(err) ? missing(key) : err;
    }
  }

  stream(key: string): Readable {
    const out = new PassThrough();
    const objectKey = this.key(key);
    this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey })).then(
      (res) => {
        const body = res.Body as Readable;
        body.on('error', (err) => out.destroy(err));
        body.pipe(out);
      },
      (err) => out.destroy(isMissing(err) ? missing(key) : err)
    );
    return out;
  }

  async delete(key: string): Promise<void> {
    // S3 deletes are idempotent: a missing key is not an error
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
      return true;
    } catch (err) {
      if (isMissing(err)) return false;
      throw err;
    }
  }

  /** Throws when the bucket can't be reached (readiness). */
  async ping(): Promise<void> {
    await this.exists('.claudia-ping');
  }
}

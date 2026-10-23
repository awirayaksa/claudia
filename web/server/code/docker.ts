/**
 * A small Docker Engine API client (no CLI needed): over the unix socket
 * (unix:///var/run/docker.sock) or TCP (tcp://host:2375, http(s)://…).
 * Only what the code sandbox uses.
 */
import http from 'node:http';
import https from 'node:https';

export interface DockerResponse {
  status: number;
  body: Buffer;
}

export class DockerEngine {
  private readonly base: { socketPath?: string; host?: string; port?: number; protocol: 'http:' | 'https:' };

  constructor(endpoint: string) {
    if (endpoint.startsWith('unix://')) {
      this.base = { socketPath: endpoint.slice('unix://'.length), protocol: 'http:' };
    } else {
      const url = new URL(endpoint.replace(/^tcp:\/\//, 'http://'));
      this.base = { host: url.hostname, port: Number(url.port) || (url.protocol === 'https:' ? 2376 : 2375), protocol: url.protocol === 'https:' ? 'https:' : 'http:' };
    }
  }

  /** One request; the whole answer is read. */
  request(method: string, path: string, opts: { json?: unknown; body?: Buffer; contentType?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<DockerResponse> {
    return new Promise((resolve, reject) => {
      const req = this.open(method, path, opts, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('error', reject);
    });
  }

  /** A request whose answer is streamed (logs, image pulls). Resolves when the stream ends. */
  stream(method: string, path: string, onData: (chunk: Buffer) => void, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = this.open(method, path, opts, (res) => {
        res.on('data', onData);
        res.on('end', () => resolve(res.statusCode ?? 0));
        res.on('error', reject);
      });
      req.on('error', reject);
    });
  }

  private open(
    method: string,
    path: string,
    opts: { json?: unknown; body?: Buffer; contentType?: string; timeoutMs?: number; signal?: AbortSignal },
    onResponse: (res: http.IncomingMessage) => void
  ): http.ClientRequest {
    const body = opts.json !== undefined ? Buffer.from(JSON.stringify(opts.json)) : opts.body;
    const lib = this.base.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        ...(this.base.socketPath ? { socketPath: this.base.socketPath } : { host: this.base.host, port: this.base.port }),
        method,
        path,
        headers: {
          Host: 'docker',
          ...(body ? { 'Content-Type': opts.json !== undefined ? 'application/json' : (opts.contentType ?? 'application/x-tar'), 'Content-Length': body.byteLength } : {}),
        },
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      onResponse
    );
    if (opts.timeoutMs) req.setTimeout(opts.timeoutMs, () => req.destroy(new Error('The Docker API did not answer in time.')));
    if (body) req.end(body);
    else req.end();
    return req;
  }
}

/**
 * Split a non-TTY container's log stream into stdout and stderr: frames of
 * an 8-byte header (stream, 0, 0, 0, big-endian length) and the payload.
 */
export class LogDemuxer {
  private pending = Buffer.alloc(0);

  constructor(private readonly onFrame: (stream: 'stdout' | 'stderr', text: string) => void) {}

  push(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= 8) {
      const size = this.pending.readUInt32BE(4);
      if (this.pending.length < 8 + size) break;
      const stream = this.pending[0] === 2 ? 'stderr' : 'stdout';
      this.onFrame(stream, this.pending.subarray(8, 8 + size).toString('utf-8'));
      this.pending = this.pending.subarray(8 + size);
    }
  }
}

/** A log frame, as the Engine API sends one (for tests). */
export function logFrame(stream: 'stdout' | 'stderr', text: string): Buffer {
  const payload = Buffer.from(text, 'utf-8');
  const head = Buffer.alloc(8);
  head[0] = stream === 'stderr' ? 2 : 1;
  head.writeUInt32BE(payload.byteLength, 4);
  return Buffer.concat([head, payload]);
}

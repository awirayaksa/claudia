/**
 * The Docker Engine API endpoints the code sandbox uses, on localhost, with
 * scripted runs instead of containers: what a run prints, which files it
 * writes, its exit code, or that it hangs until killed.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { logFrame } from '../code/docker';
import { packTar, unpackTar } from '../code/tar';

export interface ScriptedRun {
  stdout?: string[];
  stderr?: string[];
  /** Files the "code" writes in /workspace. */
  writes?: Record<string, string>;
  exitCode?: number;
  /** Never exits on its own (until killed). */
  hang?: boolean;
}

export interface MockDocker {
  endpoint: string;
  /** Bodies of POST /containers/create. */
  created: any[];
  /** Files copied in, per container. */
  uploads: Array<Array<{ path: string; data: Buffer }>>;
  killed: string[];
  removed: string[];
  push(run: ScriptedRun): void;
  close(): Promise<void>;
}

export async function startMockDocker(): Promise<MockDocker> {
  const created: any[] = [];
  const uploads: MockDocker['uploads'] = [];
  const killed: string[] = [];
  const removed: string[] = [];
  const queue: ScriptedRun[] = [];
  const containers = new Map<string, { run: ScriptedRun; files: Array<{ path: string; data: Buffer }>; done: Promise<void>; exit: () => void; code: number }>();
  let n = 0;

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? '/', 'http://docker');
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/version') return json(200, { Version: 'mock' });
    if (/^\/images\/.+\/json$/.test(url.pathname)) return json(200, { Id: 'sha256:mock' });
    if (url.pathname === '/containers/create' && req.method === 'POST') {
      created.push(JSON.parse(body.toString('utf-8')));
      const id = `c${++n}`;
      let exit!: () => void;
      const done = new Promise<void>((r) => (exit = r));
      containers.set(id, { run: queue.shift() ?? { stdout: [''] }, files: [], done, exit, code: 0 });
      return json(201, { Id: id });
    }
    const m = /^\/containers\/([^/]+)(\/\w+)?$/.exec(url.pathname);
    const c = m ? containers.get(m[1]) : undefined;
    if (!m || !c) return json(404, { message: 'No such container' });
    const action = m[2] ?? '';
    if (action === '/archive' && req.method === 'PUT') {
      c.files = unpackTar(body);
      uploads.push(c.files);
      res.writeHead(200);
      return res.end();
    }
    if (action === '/start') {
      c.code = c.run.exitCode ?? 0;
      if (!c.run.hang) setTimeout(() => c.exit(), 50);
      res.writeHead(204);
      return res.end();
    }
    if (action === '/logs') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.docker.multiplexed-stream' });
      for (const line of c.run.stdout ?? []) res.write(logFrame('stdout', line));
      for (const line of c.run.stderr ?? []) res.write(logFrame('stderr', line));
      await c.done;
      return res.end();
    }
    if (action === '/wait') {
      await c.done;
      return json(200, { StatusCode: c.code });
    }
    if (action === '/kill') {
      killed.push(m[1]);
      c.code = 137;
      c.exit();
      res.writeHead(204);
      return res.end();
    }
    if (action === '/json') return json(200, { State: { OOMKilled: false } });
    if (action === '/archive' && req.method === 'GET') {
      const written = Object.entries(c.run.writes ?? {}).map(([p, d]) => ({ path: `workspace/${p}`, data: Buffer.from(d) }));
      res.writeHead(200, { 'Content-Type': 'application/x-tar' });
      return res.end(packTar([{ path: 'workspace/' }, ...c.files, ...written]));
    }
    if (action === '' && req.method === 'DELETE') {
      removed.push(m[1]);
      containers.delete(m[1]);
      res.writeHead(204);
      return res.end();
    }
    json(404, { message: 'not mocked' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `tcp://127.0.0.1:${(server.address() as AddressInfo).port}`,
    created,
    uploads,
    killed,
    removed,
    push: (run) => queue.push(run),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

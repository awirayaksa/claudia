/**
 * The parts of GitHub's REST API a knowledge source uses, on localhost:
 * repository (default branch), commit of a ref, recursive tree, raw blobs.
 * `commit(files)` makes a new commit on main; a private repository wants
 * the bearer token.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockGitHub {
  /** For a source's apiUrl. */
  apiUrl: string;
  /** Requests received ("GET /repos/…"), to check what was fetched. */
  requests: string[];
  /** Replace the repository's files with a new commit on main. */
  commit(files: Record<string, string>): string;
  close(): Promise<void>;
}

const sha = (s: string) => crypto.createHash('sha1').update(s).digest('hex');

export async function startMockGitHub(opts: { repo?: string; token?: string } = {}): Promise<MockGitHub> {
  const repo = opts.repo ?? 'acme/handbook';
  const requests: string[] = [];
  let head = '';
  let tree: Array<{ path: string; sha: string; size: number }> = [];
  const blobs = new Map<string, string>();

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    requests.push(`${req.method} ${url.pathname}`);
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) return json(res, 404, { message: 'Not Found' });
    const prefix = `/repos/${repo}`;
    if (!url.pathname.startsWith(prefix)) return json(res, 404, { message: 'Not Found' });
    const rest = url.pathname.slice(prefix.length);
    if (rest === '') return json(res, 200, { full_name: repo, default_branch: 'main' });
    const commit = /^\/commits\/(.+)$/.exec(rest);
    if (commit) return decodeURIComponent(commit[1]) === 'main' ? json(res, 200, { sha: head }) : json(res, 404, { message: 'No commit found' });
    const treeMatch = /^\/git\/trees\/([0-9a-f]+)$/.exec(rest);
    if (treeMatch) {
      if (treeMatch[1] !== head) return json(res, 404, { message: 'Not Found' });
      // A folder entry, as GitHub lists them
      const dirs = [...new Set(tree.flatMap((t) => (t.path.includes('/') ? [t.path.slice(0, t.path.lastIndexOf('/'))] : [])))];
      return json(res, 200, {
        sha: head,
        tree: [...dirs.map((d) => ({ path: d, type: 'tree', sha: sha(d) })), ...tree.map((t) => ({ ...t, type: 'blob', mode: '100644' }))],
        truncated: false,
      });
    }
    const blob = /^\/git\/blobs\/([0-9a-f]+)$/.exec(rest);
    if (blob && blobs.has(blob[1])) {
      if (req.headers.accept !== 'application/vnd.github.raw') return json(res, 415, { message: 'Ask for raw' });
      res.writeHead(200, { 'Content-Type': 'application/vnd.github.raw' });
      return res.end(blobs.get(blob[1]));
    }
    json(res, 404, { message: 'Not Found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    apiUrl: `http://127.0.0.1:${port}`,
    requests,
    commit(files) {
      tree = Object.entries(files).map(([path, content]) => {
        const s = sha(`blob ${content}`);
        blobs.set(s, content);
        return { path, sha: s, size: Buffer.byteLength(content) };
      });
      head = sha(`commit ${JSON.stringify(tree)} ${Date.now()} ${Math.random()}`);
      return head;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

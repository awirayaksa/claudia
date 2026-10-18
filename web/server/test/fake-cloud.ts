/**
 * Google (OAuth, userinfo, Drive v3) and Microsoft (OAuth, Graph) for tests,
 * on one local server. The authorize endpoints sign in at once and send the
 * browser back with a code.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CloudEndpoints } from '../cloud/cloud-files';

export interface FakeCloud {
  endpoints: CloudEndpoints;
  /** Tokens handed out so far (refresh grants included). */
  tokenGrants: Array<Record<string, string>>;
  /** Access tokens expire at once when false (to test refreshing). */
  longLivedTokens: boolean;
  close(): Promise<void>;
}

const DRIVE = [
  { id: 'folder-1', name: 'Projects', mimeType: 'application/vnd.google-apps.folder' },
  { id: 'doc-1', name: 'Roadmap', mimeType: 'application/vnd.google-apps.document', parent: 'root' },
  { id: 'txt-1', name: 'notes.txt', mimeType: 'text/plain', size: '22', parent: 'root' },
  { id: 'txt-2', name: 'plan.txt', mimeType: 'text/plain', size: '15', parent: 'folder-1' },
];
const ONEDRIVE = [
  { id: 'od-folder', name: 'Documents', folder: { childCount: 1 } },
  { id: 'od-1', name: 'budget.csv', size: 18, file: { mimeType: 'text/csv' } },
];

export async function startFakeCloud(): Promise<FakeCloud> {
  const fake = { tokenGrants: [], longLivedTokens: true } as unknown as FakeCloud;
  let counter = 0;
  const valid = new Set<string>();

  const server = http.createServer(async (req, res) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = new URL(req.url ?? '/', base);
    let body = '';
    for await (const c of req) body += c;
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    const authed = () => valid.has((req.headers.authorization ?? '').replace(/^Bearer /, ''));

    // OAuth (both providers)
    if (url.pathname === '/google/authorize' || url.pathname.endsWith('/oauth2/v2.0/authorize')) {
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', 'code-ok');
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if ((url.pathname === '/google/token' || url.pathname.endsWith('/oauth2/v2.0/token')) && req.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(body));
      fake.tokenGrants.push(form);
      if (form.client_secret !== 'cloud-secret') return json(401, { error: 'invalid_client' });
      if (form.grant_type === 'authorization_code' && form.code !== 'code-ok') return json(400, { error: 'invalid_grant' });
      if (form.grant_type === 'refresh_token' && !String(form.refresh_token).startsWith('rt-')) return json(400, { error: 'invalid_grant' });
      const token = `at-${++counter}`;
      valid.add(token);
      return json(200, { access_token: token, refresh_token: `rt-${counter}`, expires_in: fake.longLivedTokens ? 3600 : 1, token_type: 'Bearer' });
    }

    if (!authed()) return json(401, { error: 'unauthorized' });

    // Google
    if (url.pathname === '/google/userinfo') return json(200, { email: 'drive.user@example.com' });
    if (url.pathname === '/google/api/drive/v3/files') {
      const q = url.searchParams.get('q') ?? '';
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const name = /name contains '([^']+)'/.exec(q)?.[1];
      const files = DRIVE.filter((f) => (name ? f.name.toLowerCase().includes(name.toLowerCase()) : (f.parent ?? 'root') === parent));
      return json(200, { files });
    }
    const gFile = /^\/google\/api\/drive\/v3\/files\/([^/]+)(\/export)?$/.exec(url.pathname);
    if (gFile) {
      const f = DRIVE.find((d) => d.id === gFile[1]);
      if (!f) return json(404, { error: 'notFound' });
      if (gFile[2]) {
        res.writeHead(200, { 'content-type': url.searchParams.get('mimeType') ?? '' });
        return res.end(`exported ${f.name} as ${url.searchParams.get('mimeType')}`);
      }
      if (url.searchParams.get('alt') === 'media') {
        res.writeHead(200, { 'content-type': f.mimeType });
        return res.end(f.id === 'txt-1' ? 'Notes from Google Drive' : 'Plan text here');
      }
      return json(200, f);
    }

    // Microsoft Graph
    if (url.pathname === '/graph/me') return json(200, { mail: 'od.user@example.com' });
    if (url.pathname === '/graph/me/drive/root/children') return json(200, { value: ONEDRIVE });
    const mItem = /^\/graph\/me\/drive\/items\/([^/]+)(\/content)?$/.exec(url.pathname);
    if (mItem) {
      const f = ONEDRIVE.find((d) => d.id === mItem[1]);
      if (!f) return json(404, { error: 'itemNotFound' });
      if (mItem[2]) {
        res.writeHead(200, { 'content-type': 'text/csv' });
        return res.end('item,amount\nrent,10');
      }
      return json(200, f);
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.endpoints = {
    google: { authorize: `${base}/google/authorize`, token: `${base}/google/token`, api: `${base}/google/api`, userinfo: `${base}/google/userinfo` },
    microsoft: { login: `${base}/ms`, graph: `${base}/graph` },
  };
  fake.close = () => new Promise((resolve) => server.close(() => resolve()));
  return fake;
}

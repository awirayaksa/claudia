import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Response as InjectResponse } from 'light-my-request';

/**
 * A browser-like test client over app.inject: keeps cookies between requests
 * and sends the CSRF header, like the real client does.
 */
export class TestClient {
  readonly cookies = new Map<string, string>();
  /** Send the CSRF header (turn off to test the check). */
  csrf = true;

  constructor(private readonly app: FastifyInstance) {}

  async request(opts: InjectOptions & { url: string }): Promise<InjectResponse> {
    const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const method = (opts.method ?? 'GET').toUpperCase();
    if (this.csrf && method !== 'GET' && this.cookies.has('claudia_csrf')) {
      headers['x-claudia-csrf'] = this.cookies.get('claudia_csrf')!;
    }
    const res = await this.app.inject({ ...opts, headers });
    for (const c of res.cookies as Array<{ name: string; value: string; expires?: Date; maxAge?: number }>) {
      const expired = (c.maxAge !== undefined && c.maxAge <= 0) || (c.expires && c.expires.getTime() <= Date.now());
      if (expired || c.value === '') this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return res;
  }

  get(url: string) {
    return this.request({ method: 'GET', url });
  }
  post(url: string, payload?: unknown) {
    return this.request({ method: 'POST', url, payload: payload as any });
  }
  patch(url: string, payload?: unknown) {
    return this.request({ method: 'PATCH', url, payload: payload as any });
  }
  put(url: string, payload?: unknown) {
    return this.request({ method: 'PUT', url, payload: payload as any });
  }
  delete(url: string) {
    return this.request({ method: 'DELETE', url });
  }

  /** Upload one file as multipart/form-data, like the browser does. */
  async upload(name: string, data: Buffer | string, mime = 'application/octet-stream', url = '/api/files') {
    const form = new FormData();
    form.append('file', new Blob([typeof data === 'string' ? Buffer.from(data) : new Uint8Array(data)], { type: mime }), name);
    const encoded = new Request('http://localhost/', { method: 'POST', body: form });
    return this.request({
      method: 'POST',
      url,
      headers: { 'content-type': encoded.headers.get('content-type')! },
      payload: Buffer.from(await encoded.arrayBuffer()),
    });
  }

  /** Fetch the session first (hands out the CSRF cookie), then sign up. */
  async signup(email: string, password = 'correct-horse-battery', name = email.split('@')[0]) {
    await this.get('/api/auth/session');
    return this.post('/api/auth/signup', { email, password, name });
  }

  async login(email: string, password = 'correct-horse-battery') {
    await this.get('/api/auth/session');
    return this.post('/api/auth/login', { email, password });
  }
}

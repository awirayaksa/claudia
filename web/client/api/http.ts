/**
 * Small fetch wrapper for the Claudia Web API. Cookies carry the session;
 * every state-changing request sends the CSRF header.
 */

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

const CSRF_COOKIE = 'claudia_csrf';
const CSRF_HEADER = 'X-Claudia-CSRF';

function csrfToken(): string | undefined {
  return document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${CSRF_COOKIE}=`))
    ?.slice(CSRF_COOKIE.length + 1);
}

export async function apiFetch<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const method = (rest.method ?? 'GET').toUpperCase();
  const h = new Headers(headers);
  if (json !== undefined) h.set('Content-Type', 'application/json');
  if (method !== 'GET' && method !== 'HEAD') {
    const token = csrfToken();
    if (token) h.set(CSRF_HEADER, decodeURIComponent(token));
  }

  const res = await fetch(path, {
    ...rest,
    method,
    headers: h,
    credentials: 'same-origin',
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });

  if (!res.ok) {
    let code = 'http_error';
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      code = body?.error?.code ?? code;
      message = body?.error?.message ?? message;
    } catch {
      /* not JSON */
    }
    throw new ApiRequestError(res.status, code, message);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}


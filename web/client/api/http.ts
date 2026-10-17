/**
 * fetch for the Claudia Web API. Cookies carry the session; state-changing
 * requests send the CSRF header; an expired session is refreshed once
 * (shared by every request that hit it) and the request retried.
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

export function csrfToken(): string | undefined {
  const raw = document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${CSRF_COOKIE}=`))
    ?.slice(CSRF_COOKIE.length + 1);
  return raw ? decodeURIComponent(raw) : undefined;
}

type SessionListener = () => void;
const sessionLostListeners = new Set<SessionListener>();

/** Called when the session can't be refreshed (signed out elsewhere, expired). */
export function onSessionLost(cb: SessionListener): () => void {
  sessionLostListeners.add(cb);
  return () => sessionLostListeners.delete(cb);
}

let refreshing: Promise<boolean> | null = null;

/** Exchange the refresh cookie for a new access token. Concurrent callers share one attempt. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= fetch('/api/auth/refresh', {
    method: 'POST',
    credentials: 'same-origin',
    headers: csrfToken() ? { [CSRF_HEADER]: csrfToken()! } : {},
  })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      setTimeout(() => (refreshing = null), 0);
    });
  return refreshing;
}

const NO_REFRESH = ['/api/auth/login', '/api/auth/signup', '/api/auth/refresh', '/api/auth/logout'];

export interface ApiFetchInit extends RequestInit {
  json?: unknown;
}

/** Raw response, after one refresh-and-retry on 401. */
export async function apiFetchRaw(path: string, init: ApiFetchInit = {}): Promise<Response> {
  const { json, headers, ...rest } = init;
  const send = () => {
    const h = new Headers(headers);
    if (json !== undefined) h.set('Content-Type', 'application/json');
    const token = csrfToken();
    if (token) h.set(CSRF_HEADER, token);
    return fetch(path, {
      ...rest,
      headers: h,
      credentials: 'same-origin',
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  };

  let res = await send();
  if (res.status === 401 && !NO_REFRESH.some((p) => path.startsWith(p))) {
    if (await refreshSession()) {
      res = await send();
    } else {
      for (const cb of sessionLostListeners) cb();
    }
  }
  return res;
}

export async function toApiError(res: Response): Promise<ApiRequestError> {
  let code = 'http_error';
  let message = `HTTP ${res.status}`;
  try {
    const body = await res.json();
    code = body?.error?.code ?? code;
    message = body?.error?.message ?? message;
  } catch {
    /* not JSON */
  }
  return new ApiRequestError(res.status, code, message);
}

export async function apiFetch<T>(path: string, init: ApiFetchInit = {}): Promise<T> {
  const res = await apiFetchRaw(path, init);
  if (!res.ok) throw await toApiError(res);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/*
 * Claudia's service worker: makes the app installable and quick to start.
 * - Hashed build files (/assets/*) never change: served from the cache once seen.
 * - Pages: network first; offline, the cached app shell opens (it then shows
 *   that the server can't be reached).
 * - Icons, the manifest and plugin shims: from the cache, refreshed behind.
 * Never cached: the API, plugin bundles, the WebSocket, anything else that
 * is per-user or changes. Nothing here holds user data.
 */
const SHELL_CACHE = 'claudia-shell-v1';
const ASSET_CACHE = 'claudia-assets-v1';
const MAX_ASSETS = 200;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(['/', '/manifest.webmanifest', '/icons/icon-192.png']))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== ASSET_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  // Oldest first: earlier builds' files go
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(key);
}

async function assetFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) {
    await cache.put(request, res.clone());
    void trim(cache);
  }
  return res;
}

async function page(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request);
    // Every page is the same app shell
    if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) await cache.put('/', res.clone());
    return res;
  } catch (err) {
    const shell = await cache.match('/');
    if (shell) return shell;
    throw err;
  }
}

async function refreshed(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request);
  const update = fetch(request)
    .then((res) => {
      if (res.ok) void cache.put(request, res.clone());
      return res;
    })
    .catch(() => hit);
  return hit || update;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  if (p.startsWith('/api/') || p.startsWith('/plugins/') || p === '/healthz' || p === '/readyz' || p === '/sw.js') return;

  if (request.mode === 'navigate') event.respondWith(page(request));
  else if (p.startsWith('/assets/')) event.respondWith(assetFirst(request));
  else if (p.startsWith('/icons/') || p.startsWith('/plugin-shims/') || p === '/manifest.webmanifest') event.respondWith(refreshed(request));
});

/* freeDMS app-shell service worker (issue #206).
 *
 * Hand-rolled, no dependencies. The cache policy is defined and tested in
 * packages/web/src/pwa.ts; this script implements it and the test suite
 * asserts the cache name below stays in step with PWA_CACHE_NAME there.
 * Bump the version in both places whenever the shell strategy changes:
 * activation deletes every older freedms-shell cache, so a new deploy can
 * never be hidden behind a stale shell.
 *
 * What is cached: only the static app shell — the HTML entry, built
 * assets, the manifest and the icons. /api/* and /public/* are tenant
 * data paths and are never cached; no API response is ever stored, so
 * going offline can only ever show the offline page or the app's normal
 * load-error state, never a cached record.
 */
const CACHE_NAME = 'freedms-shell-v1';
const OFFLINE_URL = '/offline.html';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  OFFLINE_URL,
  '/manifest.webmanifest',
  '/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/favicon.svg',
  '/favicon.ico',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => key.startsWith('freedms-shell-') && key !== CACHE_NAME)
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function isDataPath(pathname) {
  return pathname === '/api' || pathname === '/public'
    || pathname.startsWith('/api/') || pathname.startsWith('/public/');
}

function isShellAsset(url) {
  if (url.origin !== self.location.origin) return false;
  if (isDataPath(url.pathname)) return false;
  return /\.(?:html|js|mjs|css|svg|png|jpg|jpeg|webp|ico|webmanifest|woff2?|json)$/i.test(url.pathname);
}

self.addEventListener('fetch', event => {
  const {request} = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Tenant data: never intercepted, never cached.
  if (isDataPath(url.pathname)) return;

  if (request.mode === 'navigate') {
    // Network-first: a fresh deploy always wins. The cached shell and the
    // offline page are only fallbacks for a genuinely lost connection.
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put('/index.html', copy));
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME);
          return (await cache.match('/index.html')) || (await cache.match(OFFLINE_URL)) || Response.error();
        }),
    );
    return;
  }

  if (isShellAsset(url)) {
    // Cache-first for fingerprinted shell assets, refreshing in the
    // background so the next load picks up any change.
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(request);
        const network = fetch(request)
          .then(response => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          })
          .catch(() => cached);
        return cached || network;
      }),
    );
  }
});

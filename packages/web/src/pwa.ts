// PWA support for the dealer app (issue #206): service-worker registration
// plus the cache policy the worker in public/sw.js implements. The policy
// lives here as pure functions so tests can pin it down; public/sw.js is a
// plain script (service workers cannot be ES modules from the app bundle)
// and its cache name is asserted against PWA_CACHE_NAME by the tests.
//
// Policy, in one place:
// - Only the static app shell is ever cached: the HTML entry, built assets,
//   the manifest and the icons. Tenant data is never cached.
// - /api/* and /public/* are data paths (the API and public inventory/feeds)
//   and are never intercepted for caching, on any origin.
// - Navigations are network-first so a new deploy is never hidden behind a
//   stale shell; the cached shell (or the offline page) only appears when
//   the network is gone, and it shows the app's normal load-error state
//   rather than any cached record, because no API response is ever cached.

export const PWA_CACHE_VERSION = 1;
export const PWA_CACHE_NAME = `freedms-shell-v${PWA_CACHE_VERSION}`;
export const PWA_SERVICE_WORKER_URL = '/sw.js';
export const PWA_OFFLINE_URL = '/offline.html';

const DATA_PATH_PREFIXES = ['/api/', '/public/'];
const SHELL_EXTENSIONS = new Set([
  'html', 'js', 'mjs', 'css', 'svg', 'png', 'jpg', 'jpeg', 'webp', 'ico',
  'webmanifest', 'woff', 'woff2', 'json',
]);

export type PwaRequestKind = 'navigation' | 'shell' | 'data' | 'other';

export function classifyPwaRequest(input: {method: string; url: string; mode?: string}, origin: string): PwaRequestKind {
  if (input.method !== 'GET') return 'other';
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return 'other';
  }
  if (DATA_PATH_PREFIXES.some(prefix => url.pathname.startsWith(prefix)) || url.pathname === '/api' || url.pathname === '/public') return 'data';
  if (url.origin !== origin) return 'other';
  if (input.mode === 'navigate') return 'navigation';
  const extension = url.pathname.split('.').pop()?.toLowerCase() ?? '';
  if (url.pathname === '/' || SHELL_EXTENSIONS.has(extension)) return 'shell';
  return 'other';
}

export interface ServiceWorkerContainerLike {
  register: (url: string, options?: {scope?: string}) => Promise<unknown>;
}

// Registers the shell service worker. Returns undefined (a no-op) wherever
// service workers are unavailable — insecure contexts, older browsers — so
// the app behaves exactly as before there.
export function registerServiceWorker(container: ServiceWorkerContainerLike | undefined): Promise<unknown> | undefined {
  if (!container) return undefined;
  return container.register(PWA_SERVICE_WORKER_URL, {scope: '/'});
}

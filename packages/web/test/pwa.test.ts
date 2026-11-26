import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {
  PWA_CACHE_NAME,
  PWA_CACHE_VERSION,
  PWA_OFFLINE_URL,
  PWA_SERVICE_WORKER_URL,
  classifyPwaRequest,
  registerServiceWorker,
} from '../src/pwa.js';

const webRoot = new URL('../', import.meta.url);
const publicFile = (name: string) => new URL(`public/${name}`, webRoot);
const readPublic = (name: string) => readFileSync(publicFile(name), 'utf8');

function pngSize(name: string): {width: number; height: number} {
  const bytes = readFileSync(publicFile(name));
  assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG', `${name} is a PNG`);
  return {width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20)};
}

interface ManifestIcon {src: string; sizes: string; type: string; purpose?: string}
interface Manifest {name: string; short_name: string; start_url: string; scope: string; display: string; theme_color: string; background_color: string; icons: ManifestIcon[]}
const manifest = JSON.parse(readPublic('manifest.webmanifest')) as Manifest;

test('manifest makes the dealer app installable with the navy chrome', () => {
  assert.equal(manifest.name, 'freeDMS');
  assert.equal(manifest.short_name, 'freeDMS');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.theme_color, '#0B1F2C');
  assert.equal(manifest.background_color, '#0B1F2C');
});

test('manifest icons exist at the declared sizes and purposes are honest', () => {
  for (const sizes of ['192x192', '512x512']) {
    const icon = manifest.icons.find(candidate => candidate.sizes === sizes && (candidate.purpose ?? 'any').split(' ').includes('any'));
    assert.ok(icon, `manifest declares a ${sizes} icon`);
    assert.equal(icon.type, 'image/png');
    assert.ok((icon.purpose ?? 'any').split(' ').includes('any'), `${sizes} icon is usable as a regular icon`);
    const [width, height] = sizes.split('x').map(Number);
    assert.deepEqual(pngSize(icon.src.replace(/^\//, '')), {width, height});
  }
  const maskable = manifest.icons.find(icon => (icon.purpose ?? '').split(' ').includes('maskable'));
  assert.ok(maskable, 'manifest declares a maskable icon');
  const [width, height] = maskable.sizes.split('x').map(Number);
  assert.ok(width >= 192 && width === height, 'maskable icon is square and large enough');
  assert.deepEqual(pngSize(maskable.src.replace(/^\//, '')), {width, height});
});

test('apple touch icon is a square 180x180 PNG', () => {
  assert.deepEqual(pngSize('apple-touch-icon.png'), {width: 180, height: 180});
});

test('the HTML entry links the manifest and the Apple install metadata', () => {
  const html = readFileSync(new URL('index.html', webRoot), 'utf8');
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/);
  assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /name="mobile-web-app-capable" content="yes"/);
  assert.match(html, /name="theme-color" content="#0B1F2C"/);
});

test('request classification never treats tenant data as shell', () => {
  const origin = 'https://app.freedms.co';
  const kind = (method: string, url: string, mode?: string) => classifyPwaRequest({method, url, mode}, origin);
  assert.equal(kind('GET', `${origin}/`, 'navigate'), 'navigation');
  assert.equal(kind('GET', `${origin}/#/vehicles`, 'navigate'), 'navigation');
  assert.equal(kind('GET', `${origin}/assets/index-abc123.js`), 'shell');
  assert.equal(kind('GET', `${origin}/manifest.webmanifest`), 'shell');
  assert.equal(kind('GET', `${origin}/icons/icon-512.png`), 'shell');
  // Data paths are data even when they look like documents or downloads.
  assert.equal(kind('GET', `${origin}/api/session`), 'data');
  assert.equal(kind('GET', `${origin}/api/reports/inventory.csv`), 'data');
  assert.equal(kind('GET', `${origin}/public/tenant/facebook.csv`), 'data');
  assert.equal(kind('GET', `${origin}/api`, 'navigate'), 'data');
  // Writes and other origins are never the shell worker's business.
  assert.equal(kind('POST', `${origin}/api/vehicles`), 'other');
  assert.equal(kind('POST', `${origin}/`), 'other');
  assert.equal(kind('GET', 'https://cdn.example.com/assets/index.js'), 'other');
});

test('service worker registration targets the root-scope worker and is a no-op without support', async () => {
  const calls: Array<{url: string; options?: {scope?: string}}> = [];
  const result = registerServiceWorker({register: async (url, options) => { calls.push({url, options}); return 'registration'; }});
  assert.equal(await result, 'registration');
  assert.deepEqual(calls, [{url: PWA_SERVICE_WORKER_URL, options: {scope: '/'}}]);
  assert.equal(PWA_SERVICE_WORKER_URL, '/sw.js');
  assert.equal(registerServiceWorker(undefined), undefined);
});

test('the shipped service worker implements the tested cache policy', () => {
  assert.ok(existsSync(publicFile('sw.js')), 'public/sw.js exists so it is served from the app origin root');
  const worker = readPublic('sw.js');
  assert.ok(worker.includes(`const CACHE_NAME = '${PWA_CACHE_NAME}';`), 'worker cache name matches PWA_CACHE_NAME');
  assert.match(PWA_CACHE_NAME, new RegExp(`^freedms-shell-v${PWA_CACHE_VERSION}$`));
  // Data paths are excluded before any caching branch.
  assert.match(worker, /pathname\.startsWith\('\/api\/'\)/);
  assert.match(worker, /pathname\.startsWith\('\/public\/'\)/);
  assert.match(worker, /if \(isDataPath\(url\.pathname\)\) return;/);
  // Navigations are network-first; activation drops older shell caches.
  assert.match(worker, /request\.mode === 'navigate'/);
  assert.match(worker, /caches\.delete\(key\)/);
  assert.match(worker, /key !== CACHE_NAME/);
  // The offline fallback is precached and points at the plain offline page.
  assert.ok(worker.includes(`const OFFLINE_URL = '${PWA_OFFLINE_URL}';`));
  assert.ok(existsSync(publicFile(PWA_OFFLINE_URL.replace(/^\//, ''))), 'offline page exists in public/');
  const offline = readPublic(PWA_OFFLINE_URL.replace(/^\//, ''));
  assert.match(offline, /not connected/i);
  assert.doesNotMatch(offline, /<script[^>]+src=/, 'offline page loads no app code or data');
});

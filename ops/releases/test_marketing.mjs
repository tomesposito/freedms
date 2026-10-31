import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {runInNewContext} from 'node:vm';
import {createHash} from 'node:crypto';
import {buildMarketing} from './marketing.mjs';

test('marketing image references match immutable packaged assets and pilot links', () => {
  const destination = mkdtempSync(`${tmpdir()}/freedms-marketing-test-`);
  try {
    buildMarketing('site', destination);
    const html = readFileSync(`${destination}/index.html`, 'utf8');
    const references = [...html.matchAll(/(?:src|data-src)="(assets\/[^"]+)"/g)].map(match => match[1]);
    assert.ok(references.length >= 10);
    for (const path of references) {
      const hash = createHash('sha256').update(readFileSync(`${destination}/${path}`)).digest('hex').slice(0, 20);
      assert.ok(path.endsWith(`-${hash}.${path.slice(path.lastIndexOf('.') + 1)}`));
    }
    assert.equal(readdirSync(`${destination}/assets`).length, readdirSync('site/assets').length);
    assert.ok(readdirSync(`${destination}/assets`).some(name => /^og-image-[a-f0-9]{20}\.jpg$/.test(name)));
    for (const page of ['index.html', 'dms-cost.html', 'free-dealer-management-software.html']) {
      const content = readFileSync(`${destination}/${page}`, 'utf8');
      const assets = [...content.matchAll(/(?:src|data-src|href|content)="(?:https:\/\/freedms\.co\/)?(assets\/[^"]+)"/g)].map(match => match[1]);
      assert.ok(assets.length >= 5);
      for (const path of assets) {
        const hash = createHash('sha256').update(readFileSync(`${destination}/${path}`)).digest('hex').slice(0, 20);
        assert.ok(path.endsWith(`-${hash}.${path.slice(path.lastIndexOf('.') + 1)}`));
      }
      for (const meta of ['property="og:image"', 'name="twitter:image"']) {
        const path = content.match(new RegExp(`<meta ${meta} content="https://freedms\\.co/(assets/og-image-[a-f0-9]{20}\\.jpg)"`))?.[1];
        assert.ok(path, `${page}: ${meta}`);
        assert.deepEqual(readFileSync(`${destination}/${path}`), readFileSync('site/assets/og-image.jpg'));
      }
    }
    for (const name of ['robots.txt', 'sitemap.xml', 'llms.txt']) {
      assert.deepEqual(readFileSync(`${destination}/${name}`), readFileSync(`site/${name}`));
    }
    assert.ok(html.includes('https://app.freedms.co/'));
    assert.ok(html.includes('invite-only'));
    assert.ok(!/href="\/(signup|login)"/.test(html));
  } finally {
    rmSync(destination, {recursive: true, force: true});
  }
});

const template = readFileSync('infra/template.yaml', 'utf8');
const code = template.split('      FunctionCode: !Sub |\n')[1].split('\n  WebAcl:')[0]
  .replaceAll('${RootDomain}', 'freedms.co');
const handler = runInNewContext(code + '\nhandler;');
const route = (host, uri, method = 'GET') => handler({request: {headers: {host: {value: host}}, uri, method}});

test('apex routes to marketing objects without sharing the app asset cache keys', () => {
  for (const path of ['/', '/index.html']) assert.equal(route('freedms.co', path).uri, '/marketing/index.html');
  assert.equal(route('freedms.co', '/assets/hero-abc.png').uri, '/marketing/assets/hero-abc.png');
  assert.equal(route('freedms.co', '/assets/og-image-abc.jpg').uri, '/marketing/assets/og-image-abc.jpg');
  for (const path of ['/robots.txt', '/sitemap.xml', '/llms.txt', '/dms-cost.html', '/free-dealer-management-software.html']) {
    assert.equal(route('freedms.co', path).uri, `/marketing${path}`);
    assert.equal(route('app.freedms.co', path).statusCode, 404);
  }
  assert.equal(route('app.freedms.co', '/assets/hero-abc.png').uri, '/assets/hero-abc.png');
  assert.equal(route('app.freedms.co', '/api/session').uri, '/session');
  assert.equal(route('app.freedms.co', '/').uri, '/');
});

test('pilot redirects work and unsupported apex paths do not reach the API', () => {
  assert.equal(route('freedms.co', '/login').headers.location.value, 'https://app.freedms.co/');
  assert.equal(route('freedms.co', '/signup').headers.location.value, 'https://freedms.co/#signup');
  for (const path of ['/api/session', '/assets/../index.html', '/unknown', '/marketing/index.html']) {
    assert.equal(route('freedms.co', path).statusCode, 404);
  }
  assert.equal(route('app.freedms.co', '/marketing/index.html').statusCode, 404);
  assert.equal(route('other.example', '/').statusCode, 404);
});

test('only the pilot request POST reaches the API from the marketing host', () => {
  assert.equal(route('freedms.co', '/api/access-requests', 'POST').uri, '/access-requests');
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']) {
    assert.equal(route('freedms.co', '/api/access-requests', method).statusCode, 404);
  }
  for (const path of ['/api/session', '/api/mcp', '/api/access-requests/anything', '/api/access-requests/']) {
    assert.equal(route('freedms.co', path, 'POST').statusCode, 404);
  }
});

const accessHtml = readFileSync('site/index.html', 'utf8');
const accessScript = [...accessHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(script => script.includes("getElementById('access-form')"));

function accessHarness(fetchRequest) {
  let submit;
  let timeout;
  const timers = new Set();
  const button = {disabled: false};
  const panel = () => ({hidden: true, scrollIntoView() { this.scrolled = true; }, focus() { this.focused = true; }});
  const error = panel(), success = panel();
  const form = {hidden: false, querySelector: () => button, addEventListener: (name, handler) => { submit = handler; }};
  const fields = Object.fromEntries(['contactName', 'dealershipName', 'email', 'phone', 'inventorySize', 'currentDms', 'message', 'website'].map(key => [key, `value-${key}`]));
  runInNewContext(accessScript, {
    document: {getElementById: id => ({'access-form': form, 'access-error': error, 'access-success': success})[id]},
    FormData: class { get(key) { return fields[key]; } },
    AbortController,
    fetch: (url, options) => {
      assert.equal(url, '/api/access-requests');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['content-type'], 'application/json');
      assert.deepEqual(JSON.parse(options.body), fields);
      return fetchRequest(options);
    },
    setTimeout: (callback, delay) => {
      assert.equal(delay, 15000);
      timeout = callback;
      timers.add(callback);
      return callback;
    },
    clearTimeout: timer => timers.delete(timer)
  });
  return {button, error, success, form, timers, submit: () => submit({preventDefault() {}}), expire: () => timeout()};
}

function assertOutcome(harness, succeeded) {
  const visible = succeeded ? harness.success : harness.error;
  assert.equal(visible.hidden, false);
  assert.equal(visible.scrolled, true);
  assert.equal(visible.focused, true);
  assert.equal(harness.form.hidden, succeeded);
  assert.equal((succeeded ? harness.error : harness.success).hidden, true);
  assert.equal(harness.button.disabled, false);
  assert.equal(harness.timers.size, 0);
}

test('access outcomes are focusable panels with headings and next steps', () => {
  for (const [id, role] of [['error', 'alert'], ['success', 'status']]) {
    assert.match(accessHtml, new RegExp(`<div id="access-${id}"[^>]*class="access-status[^>]*role="${role}" tabindex="-1" hidden>\\s*<h4>`));
  }
  assert.ok(accessHtml.includes("That didn't go through. Nothing was sent. Please try again."));
  assert.ok(accessHtml.includes('Thanks — your request is in. We review requests by hand and invite dealers a few at a time.'));
  assert.ok(accessHtml.includes("email an invitation if there's a fit."));
});

test('access success replaces the form and brings confirmation into view', async () => {
  const harness = accessHarness(async () => ({ok: true}));
  const pending = harness.submit();
  assert.equal(harness.button.disabled, true);
  await pending;
  assertOutcome(harness, true);
});

test('access HTTP and network failures show an error and allow a successful retry', async () => {
  for (const failure of [() => ({ok: false}), () => { throw new Error('Offline'); }]) {
    let attempts = 0;
    const harness = accessHarness(async () => ++attempts === 1 ? failure() : {ok: true});
    await harness.submit();
    assertOutcome(harness, false);
    const retry = harness.submit();
    assert.equal(harness.error.hidden, true);
    assert.equal(harness.button.disabled, true);
    await retry;
    assertOutcome(harness, true);
  }
});

test('access timeout aborts a hung request, allows retry, and ignores late success', async () => {
  let signal, complete;
  let attempts = 0;
  const harness = accessHarness(options => {
    if (++attempts > 1) return Promise.resolve({ok: true});
    signal = options.signal;
    return new Promise(resolve => { complete = resolve; });
  });
  const pending = harness.submit();
  assert.equal(harness.button.disabled, true);
  assert.equal(signal.aborted, false);
  harness.expire();
  await pending;
  assert.equal(signal.aborted, true);
  assertOutcome(harness, false);
  complete({ok: true});
  await Promise.resolve();
  assertOutcome(harness, false);
  await harness.submit();
  assertOutcome(harness, true);
});

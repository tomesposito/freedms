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
const route = (host, uri) => handler({request: {headers: {host: {value: host}}, uri}});

test('apex routes to marketing objects without sharing the app asset cache keys', () => {
  for (const path of ['/', '/index.html']) assert.equal(route('freedms.co', path).uri, '/marketing/index.html');
  assert.equal(route('freedms.co', '/assets/hero-abc.png').uri, '/marketing/assets/hero-abc.png');
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

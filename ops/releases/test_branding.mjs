import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {build} from 'vite';

test('production branding uses allowed versioned assets and resolvable references', () => {
  const root = 'packages/web/dist';
  assert.deepEqual(readdirSync(root).sort(), ['assets', 'index.html']);
  const assets = readdirSync(`${root}/assets`);
  const html = readFileSync(`${root}/index.html`, 'utf8');
  const javascript = assets.filter(name => name.endsWith('.js')).map(name => readFileSync(`${root}/assets/${name}`, 'utf8')).join('\n');
  for (const name of ['icon', 'logo', 'logo-reversed']) {
    const source = readFileSync(`packages/web/src/assets/${name}.svg`);
    const matches = assets.filter(path => new RegExp(`^${name}-[A-Za-z0-9_-]{8}\\.svg$`).test(path));
    assert.equal(matches.length, 1, `Expected a versioned ${name}`);
    assert.deepEqual(readFileSync(`${root}/assets/${matches[0]}`), source);
    assert.ok(javascript.includes(`/assets/${matches[0]}`), `App must reference ${name}`);
    if (name === 'icon') assert.ok(html.includes(`href="/assets/${matches[0]}"`));
  }
  assert.doesNotMatch(html + javascript, /["']\/(?:logo|logo-reversed|icon)\.svg["']/);
});

test('a changed logo gets a new URL and JavaScript bundle for immutable caching', async () => {
  const root = realpathSync(mkdtempSync(`${tmpdir()}/freedms-branding-`));
  try {
    mkdirSync(`${root}/src`);
    cpSync('packages/web/src/assets', `${root}/src/assets`, {recursive: true});
    cpSync('packages/web/src/brand.ts', `${root}/src/brand.ts`);
    writeFileSync(`${root}/index.html`, '<div id="app"></div><script type="module" src="/src/main.js"></script>');
    writeFileSync(`${root}/src/main.js`, 'import {brandLogoUrl} from "./brand.ts"; document.querySelector("#app").innerHTML = `<img src="${brandLogoUrl}">`;');
    const compile = () => build({root, configFile: resolve('packages/web/vite.config.ts'), logLevel: 'silent', build: {write: false}});
    const before = (await compile()).output;
    const logo = readFileSync(`${root}/src/assets/logo.svg`, 'utf8');
    writeFileSync(`${root}/src/assets/logo.svg`, logo + '\n<!-- revised branding -->');
    const after = (await compile()).output;
    const logoName = output => output.find(file => /^assets\/logo-[A-Za-z0-9_-]{8}\.svg$/.test(file.fileName)).fileName;
    const script = output => output.find(file => file.type === 'chunk' && file.isEntry);
    assert.notEqual(logoName(before), logoName(after));
    assert.notEqual(script(before).fileName, script(after).fileName);
    assert.ok(script(before).code.includes('/' + logoName(before)));
    assert.ok(script(after).code.includes('/' + logoName(after)));
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

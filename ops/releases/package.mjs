import {createHash} from 'node:crypto';
import {readFileSync, readdirSync, mkdirSync, statSync, writeFileSync, rmSync, cpSync, mkdtempSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {buildMarketing} from './marketing.mjs';
import {releaseConfiguration} from './configuration.mjs';

const source = process.env.GITHUB_SHA;
const repository = process.env.GITHUB_REPOSITORY;
if (!/^[a-f0-9]{40}$/.test(source ?? '') || repository !== 'tomesposito/freedms') throw Error('Trusted release identity required');
const config = releaseConfiguration(process.env);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = [];
function walk(dir, prefix = '') {
  for (const name of readdirSync(dir).sort()) {
    const path = prefix + name;
    if (statSync(`${dir}/${name}`).isDirectory()) walk(`${dir}/${name}`, `${path}/`);
    else {
      if (!(/^(marketing\/)?index\.html$/.test(path) || /^marketing\/(robots\.txt|sitemap\.xml|llms\.txt|dms-cost\.html|free-dealer-management-software\.html)$/.test(path) || /^(marketing\/)?assets\/[A-Za-z0-9_-]+\.(js|css|woff2|png|svg|jpg)$/.test(path))) throw Error('Unexpected frontend file');
      files.push({path, sha256: hash(readFileSync(`${dir}/${name}`)), size: statSync(`${dir}/${name}`).size});
    }
  }
}
mkdirSync('release', {recursive: true});
rmSync('release/api.zip', {force: true});
execFileSync('zip', ['-X', '-q', resolve('release/api.zip'), 'lambda.cjs'], {cwd: 'packages/api/dist'});
const staging = mkdtempSync(`${tmpdir()}/freedms-web-`);
try {
  cpSync('packages/web/dist', staging, {recursive: true});
  buildMarketing('site', `${staging}/marketing`);
  walk(staging);
  if (!files.some(f => f.path === 'index.html') || !files.some(f => f.path === 'marketing/index.html')) throw Error('Incomplete frontend');
  execFileSync('tar', ['--format=ustar', '-czf', resolve('release/web.tar.gz'), '-C', staging, ...files.map(f => f.path)], {env: {...process.env, COPYFILE_DISABLE: '1'}});
} finally {
  rmSync(staging, {recursive: true, force: true});
}
const artifacts = Object.fromEntries(['api.zip', 'web.tar.gz'].map(name => [name, {sha256: hash(readFileSync(`release/${name}`)), size: statSync(`release/${name}`).size}]));
writeFileSync('release/release.json', JSON.stringify({version: 2, repository, source, infrastructure: hash(readFileSync('infra/template.yaml')),
  configuration: hash(JSON.stringify(config)), artifacts, frontend: files}, null, 2) + '\n');
console.log(`Packaged tested source ${source}.`);

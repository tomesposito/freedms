import {createHash} from 'node:crypto';
import {readFileSync, readdirSync, mkdirSync, statSync, writeFileSync, rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';

const source = process.env.GITHUB_SHA;
const repository = process.env.GITHUB_REPOSITORY;
if (!/^[a-f0-9]{40}$/.test(source ?? '') || repository !== 'tomesposito/freedms') throw Error('Trusted release identity required');
const config = {apiUrl: process.env.VITE_API_URL, cognitoDomain: process.env.VITE_COGNITO_DOMAIN, clientId: process.env.VITE_COGNITO_CLIENT_ID};
if (config.apiUrl !== '/api' || !/^https:\/\/[a-z0-9-]+\.auth\.us-east-1\.amazoncognito\.com$/.test(config.cognitoDomain ?? '') || !/^[a-z0-9]+$/.test(config.clientId ?? '')) throw Error('Hosted frontend configuration required');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = [];
function walk(dir, prefix = '') {
  for (const name of readdirSync(dir).sort()) {
    const path = prefix + name;
    if (statSync(`${dir}/${name}`).isDirectory()) walk(`${dir}/${name}`, `${path}/`);
    else {
      if (!(path === 'index.html' || /^assets\/[A-Za-z0-9_-]+\.(js|css|woff2|png|svg)$/.test(path))) throw Error('Unexpected frontend file');
      files.push({path, sha256: hash(readFileSync(`${dir}/${name}`)), size: statSync(`${dir}/${name}`).size});
    }
  }
}
walk('packages/web/dist');
if (!files.some(f => f.path === 'index.html') || files.length < 2) throw Error('Incomplete frontend');
mkdirSync('release', {recursive: true});
rmSync('release/api.zip', {force: true});
execFileSync('zip', ['-X', '-q', resolve('release/api.zip'), 'lambda.cjs'], {cwd: 'packages/api/dist'});
execFileSync('tar', ['--format=ustar', '-czf', resolve('release/web.tar.gz'), '-C', 'packages/web/dist', ...files.map(f => f.path)], {env: {...process.env, COPYFILE_DISABLE: '1'}});
const artifacts = Object.fromEntries(['api.zip', 'web.tar.gz'].map(name => [name, {sha256: hash(readFileSync(`release/${name}`)), size: statSync(`release/${name}`).size}]));
writeFileSync('release/release.json', JSON.stringify({version: 1, repository, source, infrastructure: hash(readFileSync('infra/template.yaml')),
  configuration: hash(JSON.stringify(config)), artifacts, frontend: files}, null, 2) + '\n');
console.log(`Packaged tested source ${source}.`);

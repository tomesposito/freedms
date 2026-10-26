import {createHash} from 'node:crypto';
import {lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';

// Content-addressed assets let CloudFront cache screenshots without serving an old
// screenshot under a new page. Previous assets remain usable during rollback.
export function buildMarketing(source, destination) {
  mkdirSync(`${destination}/assets`, {recursive: true});
  let html = readFileSync(`${source}/index.html`, 'utf8');
  for (const name of readdirSync(`${source}/assets`).sort()) {
    if (!/^[A-Za-z0-9_-]+\.(png|svg)$/.test(name) || !lstatSync(`${source}/assets/${name}`).isFile()) throw Error('Unexpected marketing asset');
    const data = readFileSync(`${source}/assets/${name}`);
    const hash = createHash('sha256').update(data).digest('hex').slice(0, 20);
    const dot = name.lastIndexOf('.');
    const target = `${name.slice(0, dot)}-${hash}.${name.slice(dot + 1)}`;
    html = html.replaceAll(`assets/${name}`, `assets/${target}`);
    writeFileSync(`${destination}/assets/${target}`, data);
  }
  if (html.includes('href="/signup"') || html.includes('href="/login"')) throw Error('Marketing links must support the invite-only pilot');
  writeFileSync(`${destination}/index.html`, html);
}

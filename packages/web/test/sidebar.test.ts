import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sidebarNavigation, readSidebarPreference, writeSidebarPreference } from '../src/sidebar.js';

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
test('Sidebar renders all destinations in order with distinct inline icons and accessible tooltips', () => {
  const expected = [['Inventory',''],['Leads','leads'],['Deals','deals'],['Service','service'],['Parts','parts'],['Accounting','accounting'],['F&amp;I','fi-products'],['Documents','documents'],['Compliance','compliance'],['Reports','reports'],['Feeds','feeds'],['Webhooks','webhooks'],['Account','account'],['Users','users']];
  const links = [...sidebarNavigation(true).matchAll(/<a href="([^"]+)" title="([^"]+)" aria-label="([^"]+)">(<svg.*?<\/svg>)<span class="nav-text">([^<]+)<\/span><\/a>/g)];
  assert.equal(links.length, 14);
  assert.equal(new Set(links.map(link => link[4])).size, 14);
  links.forEach((link, i) => {
    assert.equal(link[1], `#/${expected[i][1]}`);
    for (const index of [2, 3, 5]) assert.equal(link[index], expected[i][0]);
    assert.match(link[4], /viewBox="0 0 24 24"/);
    assert.match(link[4], /aria-hidden="true"/);
    assert.match(link[4], /stroke-width="1.8"/);
  });
  assert.doesNotMatch(sidebarNavigation(false), /#\/users/);
  assert.match(main, /sidebarNavigation\(session\?\.principal.role === 'admin'\)/);
  assert.match(main, /anchor.setAttribute\('aria-current', 'page'\)/);
});
test('Sidebar preference defaults expanded, persists both choices and tolerates blocked storage', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
    assert.equal(readSidebarPreference(), false);
    writeSidebarPreference(true);
    assert.equal(values.get('freedms-sidebar'), 'slim');
    assert.equal(readSidebarPreference(), true);
    writeSidebarPreference(false);
    assert.equal(readSidebarPreference(), false);
    values.set('freedms-sidebar', 'unknown');
    assert.equal(readSidebarPreference(), false);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage blocked'); } });
    assert.equal(readSidebarPreference(), false);
    assert.doesNotThrow(() => writeSidebarPreference(true));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
test('Shell reads preference on render and toggle flips the layout and stores it without navigation', () => {
  assert.match(main, /const slim = readSidebarPreference\(\)/);
  assert.match(main, /class="sidebar\$\{slim \? ' is-slim' : ''\}"/);
  assert.match(main, /id="sidebar-toggle".*aria-pressed="\$\{slim\}"/);
  assert.match(main, /slimToggle.addEventListener\('click', \(\) => \{\s*const slim = sidebar.classList.toggle\('is-slim'\);\s*writeSidebarPreference\(slim\)/);
  assert.match(main, /slimToggle.setAttribute\('aria-pressed', String\(slim\)\)/);
  assert.match(main, /id="signout".*title="Sign out" aria-label="Sign out"/);
});
test('Slim layout is desktop-only and content uses the reclaimed sidebar width', () => {
  const desktop = css.slice(css.indexOf('@media (min-width: 761px)'), css.indexOf('@media (max-width: 760px)', css.indexOf('@media (min-width: 761px)')));
  assert.match(desktop, /#app:has\(\.sidebar.is-slim\) \{ --sidebar-width: var\(--sidebar-slim-width\)/);
  assert.match(desktop, /\.sidebar.is-slim \.nav-text/);
  assert.match(desktop, /\.sidebar.is-slim \.nav-group \+ \.nav-group \{ border-top:/);
  assert.match(css, /--sidebar-slim-width: 60px/);
  assert.match(css, /\.app-main \{ max-width: none; margin-left: var\(--sidebar-width\)/);
  assert.match(css, /\.sidebar.is-open \.nav-panel \{ display: flex/);
});

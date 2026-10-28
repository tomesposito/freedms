import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sidebarUserHtml, sidebarToggleIcon, sidebarNavigation, readSidebarPreference, writeSidebarPreference } from '../src/sidebar.js';

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
  assert.match(main, /id="sidebar-toggle".*aria-expanded="\$\{!slim\}"/);
  assert.match(main, /slimToggle.addEventListener\('click', \(\) => \{\s*const slim = sidebar.classList.toggle\('is-slim'\);\s*writeSidebarPreference\(slim\)/);
  assert.match(main, /slimToggle.setAttribute\('aria-expanded', String\(!slim\)\)/);
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

test('Sidebar toggle is icon-only with the current action and direction in both states', () => {
  const toggle = main.match(/<button type="button" id="sidebar-toggle"[^>]*>(.*?)<\/button>/)![0];
  assert.doesNotMatch(toggle, /Slim mode|nav-text|aria-pressed/);
  assert.match(toggle, />\$\{sidebarToggleIcon\(slim\)\}<\/button>/);
  for (const attribute of ['title', 'aria-label']) {
    assert.ok(toggle.includes(`${attribute}="\${slim ? 'Expand sidebar' : 'Collapse sidebar'}"`));
  }
  assert.match(main, /const label = slim \? 'Expand sidebar' : 'Collapse sidebar'/);
  assert.match(main, /slimToggle.setAttribute\('aria-label', label\)/);
  assert.match(main, /slimToggle.title = label/);
  assert.match(main, /slimToggle.innerHTML = sidebarToggleIcon\(slim\)/);
  assert.notEqual(sidebarToggleIcon(false), sidebarToggleIcon(true));
  assert.match(sidebarToggleIcon(false), /M9 3v18m7-13-4 4 4 4/);
  assert.match(sidebarToggleIcon(true), /M9 3v18m4-13 4 4-4 4/);
  for (const slim of [false, true]) {
    const markup = sidebarToggleIcon(slim);
    assert.equal(markup.replace(/<[^>]*>/g, '').trim(), '');
    assert.match(markup, /stroke-width="1.8"/);
    assert.match(markup, /aria-hidden="true"/);
  }
});

test('Sidebar identity renders name, email and an accessible slim avatar', () => {
  const html = sidebarUserHtml({name: '  Olivia Owner  ', email: 'owner@example.test'});
  assert.match(html, /<strong>Olivia Owner<\/strong>/);
  assert.match(html, /class="sidebar-user-email">owner@example.test<\/span>/);
  assert.match(html, /title="Olivia Owner \(owner@example.test\)" aria-label="Olivia Owner \(owner@example.test\)">O<\/span>/);
  assert.match(html, /class="sidebar-user-text nav-text"/);
  assert.match(main, /sidebarUserHtml\(session\?\.user\)/);
  assert.match(css, /\.sidebar.is-slim \.sidebar-user \{ justify-content: center/);
});
test('Sidebar identity escapes user text and tooltip attributes', () => {
  const html = sidebarUserHtml({name: '<script>"&', email: "a'<>@example.test"});
  assert.doesNotMatch(html, /<script>|a'<>/);
  assert.match(html, /&lt;script&gt;&quot;&amp;/);
  assert.match(html, /a&#39;&lt;&gt;@example.test/);
  assert.match(html, />&lt;<\/span>/);
});
test('Sidebar identity handles absent users, missing emails and trimmed initials', () => {
  assert.equal(sidebarUserHtml(null), '');
  assert.equal(sidebarUserHtml(undefined), '');
  const html = sidebarUserHtml({name: '  olivia Owner ', email: null});
  assert.match(html, /title="olivia Owner" aria-label="olivia Owner">O<\/span>/);
  assert.doesNotMatch(html, /sidebar-user-email/);
  assert.match(sidebarUserHtml({name: '  ', email: null}), />\?<\/span>/);
});

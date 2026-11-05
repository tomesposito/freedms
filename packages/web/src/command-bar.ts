import { escapeHtml as e } from './format';
import { commandSkills, askAssistant, openAssistantSkill, type AssistantSkill } from './assistant';
type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export interface SearchRecord {id: string; title: string; meta: string; href: string}
export interface SearchResults {vehicles: SearchRecord[]; people: SearchRecord[]; deals: SearchRecord[]}
export function commandBarHtml(toggle: string): string {
  return `<div class="command-bar" aria-label="Command bar">${toggle}<button type="button" id="command-prompt" aria-label="Search records or ask the assistant" aria-expanded="false" aria-controls="command-palette"><span aria-hidden="true">⌕</span><span class="command-placeholder">Search vehicles, people, deals — or ask…</span><kbd>Ctrl K</kbd></button><div class="command-assistant"></div><section id="command-palette" aria-label="Search records or ask" hidden><input id="command-input" type="search" maxlength="200" aria-label="Search vehicles, people, deals" autocomplete="off" role="combobox" aria-expanded="true" aria-controls="command-results" aria-autocomplete="list"><div id="command-results" role="listbox"></div><small>↑ ↓ to choose · Enter to open · Esc to close</small></section></div>`;
}
export function shortcutAllowed(target: Element | null): boolean {
  return target?.id === 'command-input' || !target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}
export function paletteHtml(query: string, results: SearchResults, skills: AssistantSkill[], message = ''): string {
  let index = 0;
  const row = (attrs: string, text: string) => `<button type="button" role="option" aria-selected="false" id="command-row-${index++}" ${attrs}>${text}</button>`;
  let html = '';
  if (query) for (const [group, label] of [['vehicles', 'Vehicles'], ['people', 'People'], ['deals', 'Deals']] as const) {
    if (results[group].length) html += `<h3>${label}</h3>` + results[group].map(r => row(`data-href="${e(r.href)}"`, `<b>${e(r.title)}</b><span>${e(r.meta)}</span>`)).join('');
  }
  if (query && !index) html += `<p role="status">${e(message || 'No records match')}</p>`;
  if (skills.length) html += '<h3>On this page</h3>' + skills.map(s => row(`data-skill="${e(s.id)}"`, `<b>✦ ${e(s.name)}</b><span>${e(s.costCredits)} credits</span>`)).join('');
  if (query) html += row('data-ask', `Ask the assistant: '${e(query)}'`);
  else html += '<p>Type to find vehicles, people, or deals, or ask the assistant.</p>';
  return html;
}
let dispose: (() => void) | undefined;
export function mountCommandBar(container: HTMLElement, api: Api): void {
  dispose?.();
  const bar = container.querySelector<HTMLElement>('.command-bar')!;
  const prompt = bar.querySelector<HTMLButtonElement>('#command-prompt')!;
  const palette = bar.querySelector<HTMLElement>('#command-palette')!;
  const input = bar.querySelector<HTMLInputElement>('#command-input')!;
  const list = bar.querySelector<HTMLElement>('#command-results')!;
  let skills: AssistantSkill[] = [], results: SearchResults = {vehicles: [], people: [], deals: []};
  let timer: ReturnType<typeof setTimeout> | undefined, version = 0, active = 0, suppressFocus = false;
  const rows = () => Array.from(list.querySelectorAll<HTMLButtonElement>('[role=option]'));
  const highlight = () => { rows().forEach((row, i) => row.setAttribute('aria-selected', String(i === active))); const row = rows()[active]; if (row) input.setAttribute('aria-activedescendant', row.id); else input.removeAttribute('aria-activedescendant'); };
  const paint = (message = '') => { list.innerHTML = paletteHtml(input.value.trim(), results, skills, message); active = 0; highlight(); };
  const close = (focus = true) => { version++; clearTimeout(timer); palette.hidden = true; prompt.setAttribute('aria-expanded', 'false'); if (focus) { suppressFocus = true; prompt.focus(); suppressFocus = false; } };
  const show = async () => {
    if (suppressFocus || !palette.hidden) return;
    palette.hidden = false; prompt.setAttribute('aria-expanded', 'true'); input.focus(); paint(); input.dispatchEvent(new Event('input'));
    const loaded = await commandSkills();
    if (bar.isConnected && !palette.hidden) { skills = loaded; paint(); }
  };
  const choose = (row?: HTMLButtonElement) => {
    if (!row) return;
    const query = input.value.trim(); close(false);
    if (row.dataset.href) location.hash = row.dataset.href;
    else if (row.dataset.skill) openAssistantSkill(row.dataset.skill);
    else if (row.hasAttribute('data-ask')) void askAssistant(query);
  };
  prompt.addEventListener('focus', () => { void show(); queueMicrotask(() => { if (!palette.hidden) input.focus(); }); });
  prompt.addEventListener('click', () => { void show(); input.focus(); });
  input.addEventListener('input', () => {
    clearTimeout(timer); const current = ++version, query = input.value.trim(); results = {vehicles: [], people: [], deals: []}; paint(query ? 'Searching…' : '');
    if (!query) return;
    timer = setTimeout(async () => {
      try { const found = await api<SearchResults>(`/search?q=${encodeURIComponent(query)}`); if (bar.isConnected && current === version) { results = found; paint(); } }
      catch { if (bar.isConnected && current === version) paint('Search unavailable. Try again.'); }
    }, 180);
  });
  list.addEventListener('click', event => choose((event.target as Element).closest<HTMLButtonElement>('[role=option]') ?? undefined));
  const keydown = (event: KeyboardEvent) => {
    if (!bar.isConnected || event.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && shortcutAllowed(event.target as Element)) { event.preventDefault(); void show(); input.focus(); }
    if (palette.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); const count = rows().length; active = count ? (active + (event.key === 'ArrowDown' ? 1 : -1) + count) % count : 0; highlight(); rows()[active]?.scrollIntoView({block: 'nearest'}); }
    if (event.key === 'Enter' && event.target === input) { event.preventDefault(); choose(rows()[active]); }
  };
  const outside = (event: PointerEvent) => { if (!bar.contains(event.target as Node)) close(false); };
  document.addEventListener('keydown', keydown); document.addEventListener('pointerdown', outside);
  dispose = () => { version++; clearTimeout(timer); document.removeEventListener('keydown', keydown); document.removeEventListener('pointerdown', outside); };
  // One responsive bar: on phones its controls join the existing branded Menu header.
  const media = matchMedia('(max-width: 760px)');
  const place = () => { if (!bar.isConnected) return; if (media.matches) container.querySelector('.sidebar-heading')!.insertBefore(bar, container.querySelector('.menu-toggle')); else container.querySelector('.sidebar')!.after(bar); };
  place(); media.addEventListener('change', place);
  const cleanup = dispose; dispose = () => { cleanup(); media.removeEventListener('change', place); };
}

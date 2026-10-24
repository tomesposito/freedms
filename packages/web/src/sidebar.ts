import { escapeHtml as e } from './format';

export const icon = (paths: string): string => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="20" height="20" aria-hidden="true">${paths}</svg>`;
type Destination = { label: string; href: string; icon: string };
const destination = (label: string, href: string, paths: string): Destination => ({ label, href, icon: icon(paths) });
export function sidebarNavigation(admin: boolean): string {
  const groups: [string, Destination[]][] = [
    ['Sales', [
      destination('Inventory', '#/', '<path d="m5 10 2-5h10l2 5M4 10h16v8H4zM7 18v2m10-2v2M7 14h1m8 0h1"/>'),
      destination('Leads', '#/leads', '<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>'),
      destination('Deals', '#/deals', '<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6"/>'),
    ]],
    ['Operations', [
      destination('Service', '#/service', '<path d="M14 4a6 6 0 0 0-7 7l-4 6a3 3 0 0 0 4 4l6-6a6 6 0 0 0 7-7l-4 4-4-4 4-4z"/>'),
      destination('Parts', '#/parts', '<path d="m10 2 4 0 .5 3 2 1 2.5-1 2 3-2 2v4l2 2-2 3-2.5-1-2 1-.5 3h-4l-.5-3-2-1-2.5 1-2-3 2-2v-4L3 8l2-3 2.5 1 2-1z"/><circle cx="12" cy="12" r="3"/>'),
    ]],
    ['Back office', [
      destination('Accounting', '#/accounting', '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M8 6h8v4H8zM8 14h1m6 0h1m-8 4h1m6 0h1"/>'),
      destination('F&I', '#/fi-products', '<path d="m12 2 8 3v6c0 5-4 8-8 11-4-3-8-6-8-11V5z"/>'),
      destination('Documents', '#/documents', '<path d="M3 6V4h6l3 3h9v13H3z"/>'),
      destination('Compliance', '#/compliance', '<path d="m12 2 8 3v6c0 5-4 8-8 11-4-3-8-6-8-11V5zM8 9l1 1 2-2m2 1h3m-8 5 1 1 2-2m2 1h2"/>'),
      destination('Reports', '#/reports', '<path d="M3 3v18h18M7 17v-5h3v5m3 0V8h3v9m3 0V4h3v13"/>'),
    ]],
    ['Connect', [
      destination('Feeds', '#/feeds', '<circle cx="5" cy="19" r="1"/><path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/>'),
      destination('Webhooks', '#/webhooks', '<path d="m10 7 3-3a5 5 0 0 1 7 7l-3 3m-3 3-3 3a5 5 0 0 1-7-7l3-3m1 6 8-8"/>'),
    ]],
    ['Workspace', [
      destination('Account', '#/account', '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="9" r="3"/><path d="M6 20v-2a6 6 0 0 1 12 0v2"/>'),
      ...(admin ? [destination('Users', '#/users', '<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v3"/>')] : []),
    ]],
  ];
  return groups.map(([label, links]) => `<div class="nav-group"><p class="nav-label">${label}</p>${links.map(link => `<a href="${link.href}" title="${e(link.label)}" aria-label="${e(link.label)}">${link.icon}<span class="nav-text">${e(link.label)}</span></a>`).join('')}</div>`).join('');
}

export function readSidebarPreference(): boolean {
  try { return localStorage.getItem('freedms-sidebar') === 'slim'; } catch { return false; }
}
export function writeSidebarPreference(slim: boolean): void {
  try { localStorage.setItem('freedms-sidebar', slim ? 'slim' : 'expanded'); } catch { /* Display still works when storage is unavailable. */ }
}

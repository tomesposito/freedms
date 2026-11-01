import type { McpGrantView } from '@freedms/shared';
import type { UI } from './desking';
import { escapeHtml as e } from './format';
import { showLoadError } from './load-error';

const connection = (grant: McpGrantView, workspace: boolean) => `<section class="card">
  <h3>${e(grant.appName)}</h3>${workspace ? `<p>${e(grant.ownerName ?? grant.userId)}${grant.ownerEmail ? ` · ${e(grant.ownerEmail)}` : ''}</p>` : ''}
  <p>${grant.scopes.includes('freedms/mcp.write') ? 'can read and change' : 'can read'}</p>
  <dl class="detail-grid"><div><dt>Connected</dt><dd>${e(new Date(grant.firstGrantedAt).toLocaleString())}</dd></div><div><dt>Last used</dt><dd>${e(new Date(grant.lastUsedAt).toLocaleString())}</dd></div></dl>
  <span class="badge${grant.revokedAt ? ' muted' : ''}">${grant.revokedAt ? 'Revoked' : 'Active'}</span>
  ${grant.revokedAt ? '' : `<button class="danger" data-revoke="${e(grant.id)}">Revoke</button>`}</section>`;
export function aiConnectionsHtml(own: McpGrantView[], endpoint: string, workspace?: McpGrantView[]): string {
  return `<h1>AI connections</h1><p>See which AI apps have access to your dealership and take that access back.</p>
    ${own.length ? '' : '<div class="empty"><h2>No AI connections yet</h2><p>AI connections let an assistant read or change dealership records with your permission. Connect an app using the address below. It appears here after its first use.</p></div>'}
    <section class="card"><h2>Connect an AI app</h2><p>Paste this address into your AI assistant’s connection settings:</p><p><code>${e(endpoint)}</code></p>
    <p>Sign in with your normal freeDMS login. You approve what the app can do. You can revoke its access here any time.</p></section>
    ${own.length ? `<h2>Your connections</h2>${own.map(g => connection(g, false)).join('')}` : ''}
    ${workspace === undefined ? '' : `<h2>Everyone at this dealership</h2>${workspace.length ? workspace.map(g => connection(g, true)).join('') : '<p class="empty">No one at this dealership has connected an AI app yet.</p>'}`}`;
}
export async function aiConnectionsRoute(ui: UI): Promise<void> {
  ui.shell('<h1>AI connections</h1><p>Loading connections…</p>');
  try {
    const [own, workspace] = await Promise.all([ui.api<McpGrantView[]>('/ai-connections'), ui.admin ? ui.api<McpGrantView[]>('/ai-connections/workspace') : Promise.resolve(undefined)]);
    if (!ui.current()) return;
    ui.shell(aiConnectionsHtml(own, window.location.origin + '/api/mcp', workspace));
    document.querySelectorAll<HTMLButtonElement>('[data-revoke]').forEach(button => button.addEventListener('click', async () => {
      if (button.disabled || !confirm('Permanently revoke this connection? The app will lose access on its next request.')) return;
      button.disabled = true;
      try {
        await ui.api(`/ai-connections/${encodeURIComponent(button.dataset.revoke!)}/revoke`, 'POST');
        if (ui.current()) ui.refresh();
      } catch (error) { if (ui.current()) ui.flash(error); }
      finally { button.disabled = false; }
    }));
  } catch (error) { showLoadError(ui, error, () => { void aiConnectionsRoute(ui); }); }
}

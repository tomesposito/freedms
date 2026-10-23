import type { PublicWorkspaceUser } from '@freedms/shared';
import { escapeHtml as e } from './format';
import type { UI } from './desking';
export function usersHtml(users: PublicWorkspaceUser[], admin: boolean): string {
  if (!admin) return '<h1>Users</h1><p>Only administrators can manage workspace users.</p>';
  return `<h1>Workspace users</h1><p>Manage access for your dealership. Keep at least one active administrator.</p><p class="muted">Local sign-in only. Hosted invite emails are out of scope; no invite is sent.</p>
    <section class="card"><h2>Add user</h2><form id="add-user" class="filters"><label>Name<input name="name" required maxlength="120" autocomplete="name"></label><label>Email<input name="email" type="email" required maxlength="254" autocomplete="email"></label><label>Role<select name="role"><option value="staff">Staff</option><option value="admin">Admin</option></select></label><button class="primary">Add user</button></form></section>
    ${users.length ? `<div class="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Status</th><th>MFA</th><th>Actions</th></tr></thead><tbody>${users.map(u => `<tr><td>${e(u.name)}<small>${e(u.email ?? 'No email recorded')}</small></td><td>${e(u.role)}</td><td>${u.active ? 'Active' : 'Inactive'}</td><td>${u.mfaEnabled ? 'Enabled' : 'Disabled'}</td><td><button data-user="${e(u.userId)}" data-action="role">Make ${u.role === 'admin' ? 'staff' : 'admin'}</button> <button data-user="${e(u.userId)}" data-action="${u.active ? 'deactivate' : 'reactivate'}" class="${u.active ? 'danger' : ''}">${u.active ? 'Deactivate' : 'Reactivate'}</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No workspace users.</p>'}`;
}
export async function usersRoute(ui: UI, tenantId: string): Promise<void> {
  if (!ui.admin) { ui.shell(usersHtml([], false)); return; }
  ui.shell('<p>Loading workspace users…</p>');
  try {
    const users = await ui.api<PublicWorkspaceUser[]>('/admin/users');
    if (!ui.current()) return;
    ui.shell(usersHtml(users, true) + `<p class="muted">For local sign-in, share this workspace ID with the added user: <code>${e(tenantId)}</code></p>`);
    const run = async (button: HTMLButtonElement, path: string, body: unknown) => {
      button.disabled = true;
      try { await ui.api(path, 'POST', body); if (ui.current()) ui.refresh(); }
      catch (error) { if (ui.current()) ui.flash(error); }
      finally { button.disabled = false; }
    };
    document.querySelector<HTMLFormElement>('#add-user')?.addEventListener('submit', event => {
      event.preventDefault(); const form = event.currentTarget as HTMLFormElement;
      void run(form.querySelector('button')!, '/admin/users', Object.fromEntries(new FormData(form)));
    });
    document.querySelectorAll<HTMLButtonElement>('[data-user]').forEach(button => button.addEventListener('click', () => {
      const user = users.find(u => u.userId === button.dataset.user)!;
      const action = button.dataset.action!;
      if (action === 'deactivate' && !confirm(`Deactivate ${user.name}? Their access stops immediately.`)) return;
      void run(button, `/admin/users/${encodeURIComponent(user.userId)}/${action}`, {version: user.version, ...(action === 'role' ? {role: user.role === 'admin' ? 'staff' : 'admin'} : {})});
    }));
  } catch (error) { if (ui.current()) ui.flash(error); }
}

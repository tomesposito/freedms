import { inviteLinksHtml, bindInviteCopies } from './invites';
import type { PublicWorkspaceUser, Invite } from '@freedms/shared';
import { escapeHtml as e } from './format';
import type { UI } from './desking';
export function usersHtml(users: PublicWorkspaceUser[], admin: boolean, invites: Invite[] = [], linkBase?: string, hosted = false): string {
  if (!admin) return '<h1>Users</h1><p>Only administrators can manage workspace users.</p>';
  return `<h1>Workspace users</h1><p>Manage access for your dealership. Keep at least one active administrator.</p><p class="muted">${hosted ? 'Pilot accounts are created by your pilot operator. You can manage roles, deactivate access, and revoke invitations here.' : 'Local sign-in only. Admins share copyable invite links themselves; no email is sent.'}</p>
    ${hosted ? '' : `<section class="card"><h2>Add user</h2><form id="add-user" class="filters"><label>Name<input name="name" required maxlength="120" autocomplete="name"></label><label>Email<input name="email" type="email" required maxlength="254" autocomplete="email"></label><label>Role<select name="role"><option value="staff">Staff</option><option value="admin">Admin</option></select></label><button class="primary">Add user</button></form></section>`}
    ${users.length ? `<div class="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Status</th><th>MFA</th><th>Actions</th></tr></thead><tbody>${users.map(u => `<tr><td>${e(u.name)}<small>${e(u.email ?? 'No email recorded')}</small></td><td>${e(u.role)}</td><td>${u.active ? 'Active' : 'Inactive'}</td><td>${hosted ? 'Required at sign-in' : u.mfaEnabled ? 'Enabled' : 'Disabled'}</td><td><button data-user="${e(u.userId)}" data-action="role">Make ${u.role === 'admin' ? 'staff' : 'admin'}</button> <button data-user="${e(u.userId)}" data-action="${u.active ? 'deactivate' : 'reactivate'}" class="${u.active ? 'danger' : ''}">${u.active ? 'Deactivate' : 'Reactivate'}</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No workspace users.</p>'}<section><h2>Invites</h2><p>Reissue replaces the old link. Revocation is final.</p>${invites.map(i => `<div>${inviteLinksHtml([i], linkBase)}${i.status === 'pending' ? `<button data-invite="${e(i.id)}" data-action="reissue">Reissue</button> <button class="danger" data-invite="${e(i.id)}" data-action="revoke">Revoke</button>` : ''}</div>`).join('') || '<p>No invites.</p>'}</section>`;
}
export async function usersRoute(ui: UI, tenantId: string, hosted = false): Promise<void> {
  if (!ui.admin) { ui.shell(usersHtml([], false)); return; }
  ui.shell('<p>Loading workspace users…</p>');
  try {
    const [users, invites] = await Promise.all([ui.api<PublicWorkspaceUser[]>('/admin/users'), ui.api<Invite[]>('/admin/invites')]);
    if (!ui.current()) return;
    ui.shell(usersHtml(users, true, invites, undefined, hosted) + (hosted ? '' : `<p class="muted">For local sign-in, share this workspace ID with the added user: <code>${e(tenantId)}</code></p>`));
    const run = async (button: HTMLButtonElement, path: string, body: unknown) => {
      button.disabled = true;
      try { await ui.api(path, 'POST', body); if (ui.current()) ui.refresh(); }
      catch (error) { if (ui.current()) ui.flash(error); }
      finally { button.disabled = false; }
    };
    bindInviteCopies(document);
    document.querySelectorAll<HTMLButtonElement>('[data-invite]').forEach(button => button.addEventListener('click', () => {
      const invite = invites.find(i => i.id === button.dataset.invite)!;
      const action = button.dataset.action!;
      if (action === 'revoke' && !confirm(`Permanently revoke the invite for ${invite.name}? This link will stop working and cannot be reissued.`)) return;
      void run(button, `/admin/invites/${encodeURIComponent(invite.id)}/${action}`, {version: invite.version});
    }));
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

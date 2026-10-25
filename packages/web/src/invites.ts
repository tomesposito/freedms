import type { Invite } from '@freedms/shared';
import { escapeHtml as e } from './format';
export function inviteLink(token: string, base = `${location.origin}${location.pathname}`): string { return `${base}#/invite/${token}`; }
export function inviteLinksHtml(invites: Invite[], base?: string): string {
  return invites.length ? invites.map(i => `<article class="card"><h3>${e(i.name)}</h3><p>${e(i.email)} · ${e(i.role)} · ${e(i.status)}<br>Expires ${e(i.expiresAt)}</p>${i.status === 'pending' ? `<label>Invite link<input readonly value="${e(inviteLink(i.token, base))}"></label><button type="button" data-copy>Copy link</button>` : ''}</article>`).join('') : '<p>No invites.</p>';
}
export function bindInviteCopies(root: ParentNode): void {
  root.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    const input = button.parentElement!.querySelector('input')!;
    try { await navigator.clipboard.writeText(input.value); button.textContent = 'Copied'; }
    catch { input.focus(); input.select(); button.textContent = 'Select and copy the link'; }
  }));
}
export type InviteView = {valid: false} | {valid: true; dealership: string; role: string};
export function inviteLandingHtml(view: InviteView): string {
  return `<main class="login"><span class="brand">free<span>DMS</span></span>${view.valid ? `<h1>You're invited to join ${e(view.dealership)} as ${e(view.role)}.</h1><p>Acceptance and profile setup arrive in the next step — your admin shared this link with you directly.</p>` : '<h1>This invite link is not valid</h1><p>It may have expired, been revoked, or been replaced by a newer link. Ask your admin for a current link.</p>'}</main>`;
}

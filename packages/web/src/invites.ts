import { brandLogoUrl } from './brand';
import type { Invite } from '@freedms/shared';
import { escapeHtml as e } from './format';
export function inviteLink(token: string, base = `${location.origin}${location.pathname}`): string { return `${base}#/invite/${token}`; }
export function inviteLinksHtml(invites: Invite[], base?: string): string {
  return invites.length ? invites.map(i => `<article class="card"><h3>${e(i.name)}</h3><p>${e(i.email)} · ${e(i.role)} · ${e(i.status)}${i.status === 'accepted' ? `<br>Accepted ${e(i.acceptedAt ?? '')} as ${e(i.acceptedName ?? i.name)} (${e(i.email)})` : `<br>Expires ${e(i.expiresAt)}`}</p>${i.status === 'pending' ? `<label>Invite link<input readonly value="${e(inviteLink(i.token, base))}"></label><button type="button" data-copy>Copy link</button>` : ''}</article>`).join('') : '<p>No invites.</p>';
}
export function bindInviteCopies(root: ParentNode): void {
  root.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    const input = button.parentElement!.querySelector('input')!;
    try { await navigator.clipboard.writeText(input.value); button.textContent = 'Copied'; }
    catch { input.focus(); input.select(); button.textContent = 'Select and copy the link'; }
  }));
}
export type InviteView = {valid: false; reason?: 'expired' | 'revoked' | 'accepted'} | {valid: true; dealership: string; inviter: string; name: string; email: string; role: string};
export function inviteLandingHtml(view: InviteView, hosted = false, signedIn = false): string {
  const titles = {expired: 'This invite has expired', revoked: 'This invite was revoked', accepted: 'This invite was already used'};
  return `<main class="login"><span class="brand"><img src="${brandLogoUrl}" alt="freeDMS"></span>${view.valid ? `<h1>Join ${e(view.dealership)}</h1><p>${e(view.inviter)} invited you as <strong>${e(view.role)}</strong>.</p><h2>Set up your profile</h2><p>${hosted ? 'Sign in with your invited account, then confirm your profile to join.' : 'Your invited email is your local sign-in identity. No password is needed.'}</p>${hosted && !signedIn ? '<button id="invite-signin" class="primary">Sign in to accept</button>' : ''}<form id="accept-invite" ${hosted && !signedIn ? 'hidden' : ''}><label>Display name<input name="name" required maxlength="120" autocomplete="name" value="${e(view.name)}"></label><label>Email<input name="email" type="email" required maxlength="254" autocomplete="email" value="${e(view.email)}"></label><p id="email-warning" role="status" hidden>Acceptance requires the invited email: ${e(view.email)}.</p><p id="invite-message" role="alert"></p><button class="primary">Accept invitation</button></form>` : `<h1>${view.reason ? titles[view.reason] : 'This invite link is not valid'}</h1><p>Ask your admin to reissue a link.</p>`}</main>`;
}
export const invitedEmailMatches = (email: string, invited: string) => email.trim().toLowerCase() === invited.toLowerCase();
export function inviteSignInHtml(tenantId: string, email: string, already = false, hosted = false): string {
  return `<main class="login"><h1>${already ? "You're already a member — sign in" : 'Invitation accepted'}</h1>${hosted ? '<p>Your dealership membership is ready.</p><a href="#/">Open your workspace</a>' : `<p>Use the sign-in form with workspace ID <code>${e(tenantId)}</code> and email <strong>${e(email)}</strong>.</p><a href="#/join?${new URLSearchParams({tenantId, email})}">Go to sign in</a>`}</main>`;
}
export function welcomeHtml(role: string, dealership: string, hosted = false): string {
  return `<h1>Welcome to ${e(dealership)}</h1><section class="card"><h2>You're joining as ${e(role)}</h2><p>${role === 'admin' ? 'You can manage users, invites and workspace settings, and everything staff can: inventory, customers, leads and deals.' : 'You can work inventory, customers, leads and deals. Admin-only areas (Users, invites and workspace settings) will refuse access.'}</p>${hosted ? '<h2>Account protected</h2><p>Your account requires an authenticator at sign-in.</p><button class="primary" data-welcome="/">Start exploring</button>' : `<h2>Protect your account</h2><p>MFA is optional. Set it up now or later in Account.</p><div class="form-actions"><button class="primary" data-welcome="/">Start exploring</button><button data-welcome="/account">Set up MFA now</button><button data-welcome="/">Skip MFA for now</button></div>`}</section>`;
}
const welcomeKey = (tenantId: string, userId: string) => `freedms-welcome:${tenantId}:${userId}`;
export function welcomeDismissed(storage: Pick<Storage, 'getItem'>, tenantId: string, userId: string): boolean { return storage.getItem(welcomeKey(tenantId, userId)) === 'dismissed'; }
export function dismissWelcome(storage: Pick<Storage, 'setItem'>, tenantId: string, userId: string): void { storage.setItem(welcomeKey(tenantId, userId), 'dismissed'); }

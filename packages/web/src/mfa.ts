import { hostedAccountRoute } from './hosted-account';
import type { Cognito } from './cognito';
import type { AdminMfaEntry, PublicMfaStatus } from '@freedms/shared';
import { escapeHtml as e } from './format';
import type { UI } from './desking';
export function mfaStatusHtml(status: PublicMfaStatus): string {
  return `<section class="card"><h2>MFA ${status.enabled ? 'Enabled' : 'Disabled'}</h2><p>${e(status.recoveryCodesRemaining)} recovery codes remaining.</p>${status.lockedUntil ? `<p>Locked until ${e(status.lockedUntil)}</p>` : ''}</section>`;
}
export function adminMfaHtml(users: AdminMfaEntry[], admin: boolean): string {
  if (!admin) return '';
  return `<section><h2>Workspace MFA</h2>${users.length ? users.map(user => `<article class="card"><h3>${e(user.name)}</h3><p>${user.enabled ? 'Enabled' : 'Disabled'}</p>${user.enabled ? `<button class="danger" data-mfa-reset="${e(user.userId)}">Reset MFA</button>` : ''}</article>`).join('') : '<p>No active users.</p>'}</section>`;
}
type Reveal = {secret?: string; otpauthUrl?: string; recoveryCodes?: string[]; verified?: boolean};
const codeForm = (action: string, label: string, totpOnly = false) => `<form data-mfa-action="${e(action)}"><label>${totpOnly ? 'Authenticator code' : 'Authenticator or recovery code'}<input name="code" required autocomplete="one-time-code" ${totpOnly ? 'inputmode="numeric" pattern="[0-9]{6}" maxlength="6"' : 'maxlength="32"'}></label><button class="${action === 'disable' ? 'danger' : ''}">${e(label)}</button></form>`;
export async function accountRoute(ui: UI, reveal: Reveal = {}, hosted = false, client?: Cognito): Promise<void> {
  if (hosted) {
    await hostedAccountRoute(ui, client);
    return;
  }
  ui.shell('<p>Loading account security…</p>');
  try {
    const [status, users] = await Promise.all([ui.api<PublicMfaStatus>('/account/mfa'), ui.admin ? ui.api<AdminMfaEntry[]>('/admin/mfa') : Promise.resolve([])]);
    if (!ui.current()) return;
    ui.shell(`<h1>Account security</h1><p>MFA here uses TOTP authenticator codes. New local workspaces start with MFA off. Existing local users with MFA enabled must verify their second factor at sign-in. Hosted sign-in enforcement is handled by the identity provider. The verification form below tests your second factor; it does not issue a session token.</p>
      ${mfaStatusHtml(status)}
      ${reveal.verified ? '<p role="status">Second factor verified.</p>' : ''}
      ${reveal.recoveryCodes ? `<section class="card"><h2>Recovery codes</h2><p>Save these codes. Each works once. They will not be shown again.</p><ul>${reveal.recoveryCodes.map(code => `<li><code>${e(code)}</code></li>`).join('')}</ul><button id="mfa-done">Done</button></section>` : reveal.secret ? `<section class="card"><h2>Set up MFA</h2><p>Enter this secret in your authenticator app, or use the otpauth URL. It is shown once — confirming replaces it.</p><code>${e(reveal.secret)}</code><p><code style="overflow-wrap:anywhere">${e(reveal.otpauthUrl ?? '')}</code></p>${codeForm('enable', 'Enable MFA', true)}</section>` : status.enabled ? `<p>Use a fresh authenticator code for each action. A code already used in the same 30-second step cannot be reused.</p>${codeForm('verify', 'Verify second factor')}${codeForm('recovery-codes', 'Regenerate recovery codes', true)}<div class="danger-zone">${codeForm('disable', 'Disable MFA')}</div>` : '<p class="empty">MFA is off.</p><button id="mfa-setup">Set up MFA</button>'}
      ${adminMfaHtml(users, ui.admin)}`);
    const run = async (button: HTMLButtonElement, path: string, body: unknown) => {
      button.disabled = true;
      try { const result = await ui.api<Reveal>(path, 'POST', body); if (ui.current()) await accountRoute(ui, result); }
      catch (error) { if (ui.current()) ui.flash(error); }
      finally { button.disabled = false; }
    };
    document.querySelector<HTMLButtonElement>('#mfa-setup')?.addEventListener('click', event => { void run(event.currentTarget as HTMLButtonElement, '/account/mfa/setup', {}); });
    document.querySelector('#mfa-done')?.addEventListener('click', () => { void accountRoute(ui); });
    document.querySelectorAll<HTMLFormElement>('[data-mfa-action]').forEach(form => form.addEventListener('submit', event => {
      event.preventDefault(); const action = form.dataset.mfaAction!;
      if (action === 'disable' && !confirm('Disable MFA for your account?')) return;
      void run(form.querySelector('button')!, `/account/mfa/${action}`, {code: new FormData(form).get('code')});
    }));
    document.querySelectorAll<HTMLButtonElement>('[data-mfa-reset]').forEach(button => button.addEventListener('click', () => {
      if (confirm('Reset this user’s MFA? They will need to set it up again.')) void run(button, `/admin/mfa/${encodeURIComponent(button.dataset.mfaReset!)}/reset`, {});
    }));
  } catch (error) { if (ui.current()) ui.flash(error); }
}

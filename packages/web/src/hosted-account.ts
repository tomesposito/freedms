import type { Session } from '@freedms/shared';
import qrcode from 'qrcode-generator';
import { getAccessToken, getToken } from './auth';
import type { AccountUser, Cognito } from './cognito';
import type { UI } from './desking';
import { escapeHtml as e } from './format';

export function profileValues(session?: Session, user?: AccountUser, token?: string | null) {
  let claims: {name?: string; email?: string} = {};
  try { claims = JSON.parse(atob((token ?? '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { /* No usable ID claims. */ }
  const text = (...values: unknown[]) => values.find((v): v is string => typeof v === 'string' && v.trim().length > 0) as string | undefined;
  return {name: text(session?.user?.name, user?.name, claims.name) ?? 'Not provided', email: text(session?.user?.email, user?.email, claims.email) ?? 'Not provided', workspace: text(session?.tenant?.name) ?? 'Workspace unavailable', role: text(session?.principal?.role) ?? 'Role unavailable'};
}
export function profileHtml(profile: ReturnType<typeof profileValues>): string {
  return `<section class="card"><h2>Profile</h2><dl>${Object.entries({Name: profile.name, Email: profile.email, Workspace: profile.workspace, Role: profile.role}).map(([label, value]) => `<dt>${label}</dt><dd>${e(value)}</dd>`).join('')}</dl></section>`;
}
export function passwordHtml(): string {
  return `<section class="card"><h2>Change password</h2><form id="account-password"><div class="form-grid">${[['Current password', 'previous', 'current-password'], ['New password', 'proposed', 'new-password'], ['Confirm new password', 'confirm', 'new-password']].map(([label, name, autocomplete]) => `<label>${label}<input type="password" name="${name}" autocomplete="${autocomplete}" required></label>`).join('')}</div><button>Change password</button></form><p id="password-result" role="status"></p></section>`;
}
export const operatorNote = '<p>Your pilot account requires a password and authenticator code at sign-in. Contact the pilot operator if you lose your authenticator. If you have no valid session, you cannot replace it here. Cognito does not provide recovery codes.</p>';
export function authenticatorHtml(enabled: boolean): string {
  return `<section class="card"><h2>Authenticator</h2><p>Status: <strong>${enabled ? 'Enabled' : 'Not set'}</strong></p><button id="account-enroll">${enabled ? 'Replace authenticator' : 'Enroll authenticator'}</button><div id="account-enrollment"></div>${operatorNote}</section>`;
}
export const otpauthUrl = (secret: string, account: string) => `otpauth://totp/freeDMS:${encodeURIComponent(account)}?secret=${encodeURIComponent(secret)}&issuer=freeDMS&algorithm=SHA1&digits=6&period=30`;
export function enrollmentHtml(secret: string, account: string): string {
  // qrcode-generator (MIT) encodes locally; the setup secret never leaves the browser for a QR service.
  const qr = qrcode(0, 'M'); qr.addData(otpauthUrl(secret, account)); qr.make();
  return `<p>Scan this QR code, or enter the setup key in your authenticator app. This key is shown only during setup. Verify a code to finish replacing any previous authenticator.</p><div aria-label="Authenticator QR code" role="img" class="account-qr">${qr.createSvgTag({cellSize: 4, margin: 16, scalable: true})}</div><code class="auth-secret">${e(secret)}</code><form id="account-verify"><label>Authenticator code<input name="code" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required></label><button>Verify authenticator</button></form><p id="authenticator-result" role="status"></p>`;
}
export async function hostedAccountRoute(ui: UI, client?: Cognito): Promise<void> {
  ui.shell('<p>Loading account security…</p>');
  const access = getAccessToken();
  const [sessionResult, userResult] = await Promise.allSettled([ui.api<Session>('/session'), client && access ? client.getUser(access) : Promise.resolve(undefined)]);
  if (!ui.current()) return;
  const session = sessionResult.status === 'fulfilled' ? sessionResult.value : undefined;
  const user = userResult.status === 'fulfilled' ? userResult.value : undefined;
  const profile = profileValues(session, user, getToken());
  const available = Boolean(client && access && user);
  ui.shell(`<h1>Account security</h1>${profileHtml(profile)}${available ? passwordHtml() + authenticatorHtml(user!.enabled) : `<section class="card"><h2>Authenticator required</h2><p>${client && access ? 'Account settings could not be loaded. Try reopening Account or contact the pilot operator.' : 'Password and authenticator changes are not available in this sign-in mode. Contact the pilot operator for help.'}</p>${operatorNote}</section>`}`);
  if (sessionResult.status === 'rejected') ui.flash(sessionResult.reason);
  if (!available || !client || !access) return;
  const passwordForm = document.querySelector<HTMLFormElement>('#account-password')!;
  passwordForm.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(passwordForm);
    passwordForm.reset();
    const result = document.querySelector<HTMLElement>('#password-result')!;
    if (data.get('proposed') !== data.get('confirm')) { result.textContent = 'New passwords must match.'; return; }
    const button = passwordForm.querySelector('button')!; button.disabled = true;
    result.textContent = '';
    void client.changePassword(access, String(data.get('previous')), String(data.get('proposed'))).then(() => {
      if (ui.current()) result.textContent = 'Password changed.';
    }).catch(error => { if (ui.current()) result.textContent = (error as Error).message; }).finally(() => { passwordForm.reset(); button.disabled = false; });
  });
  const enroll = document.querySelector<HTMLButtonElement>('#account-enroll')!;
  enroll.addEventListener('click', () => {
    enroll.disabled = true;
    void client.associateSoftwareToken(access).then(secret => {
      if (!ui.current()) return;
      document.querySelector('#account-enrollment')!.innerHTML = enrollmentHtml(secret, profile.email === 'Not provided' ? 'account' : profile.email);
      const form = document.querySelector<HTMLFormElement>('#account-verify')!;
      form.addEventListener('submit', event => {
        event.preventDefault();
        const code = String(new FormData(form).get('code')); form.reset();
        const button = form.querySelector('button')!; button.disabled = true;
        const result = document.querySelector<HTMLElement>('#authenticator-result')!;
        result.textContent = '';
        // Associate -> verify -> preference replaces the old token without disabling protection first.
        void client.verifySoftwareToken(access, code).then(() => client.setTotpPreference(access, true)).then(async () => {
          if (!ui.current()) return;
          await hostedAccountRoute(ui, client);
        }).catch(error => { if (ui.current()) result.textContent = (error as Error).message; }).finally(() => { button.disabled = false; });
      });
    }).catch(error => { if (ui.current()) ui.flash(error); enroll.disabled = false; });
  });
}

import { brandLogoUrl, duskLotUrl } from './brand';
import { escapeHtml as e } from './format';
import type { AuthResult, ChallengeSession, Cognito, Tokens } from './cognito';
export type LoginState = 'sign-in' | 'new-password' | 'totp' | 'totp-setup' | 'forgot' | 'forgot-confirm' | 'error';
const password = (fresh = false) => `<label>${fresh ? 'New password' : 'Password'}<input name="password" type="password" autocomplete="${fresh ? 'new-password' : 'current-password'}" required></label>`;
const email = '<label>Email<input name="email" type="email" autocomplete="username" required></label>';
const code = '<label>Code<input name="code" autocomplete="one-time-code" inputmode="numeric" required></label>';
export function loginHtml(state: LoginState = 'sign-in', message = '', secretCode = ''): string {
  const titles = {'sign-in': 'Sign in', 'new-password': 'Choose your password', totp: 'Authenticator code', 'totp-setup': 'Set up your authenticator', forgot: 'Reset your password', 'forgot-confirm': 'Check your email', error: 'Unable to sign in'};
  const setup = `<p>Add a time-based account named freeDMS in your authenticator app using this setup key. Then enter its six-digit code.</p><code class="auth-secret" aria-label="Setup key">${e(secretCode)}</code>${code}`;
  const fields = {'sign-in': email + password(), 'new-password': password(true), totp: code, 'totp-setup': setup, forgot: email, 'forgot-confirm': code + password(true), error: ''};
  return `<main class="auth-view"><section class="auth-panel"><a href="#/" class="auth-brand"><img src="${brandLogoUrl}" alt="freeDMS"></a><p class="auth-tagline">INVENTORY. DEALS. GROWTH. YOURS.</p><div class="auth-form"><h1>${titles[state]}</h1><p>${state === 'sign-in' ? 'Invite-only pilot. Sign in with the account provided by your pilot operator.' : state === 'new-password' ? 'Set a new password to finish your first sign-in.' : state === 'totp' ? 'Enter the code from your authenticator app.' : state === 'totp-setup' ? 'Protect your account with an authenticator before continuing.' : state === 'forgot-confirm' ? 'If an account matches, a reset code has been sent. Enter it below with your new password.' : state === 'forgot' ? 'Enter your account email to request a reset code.' : 'Return to sign-in to try again.'}</p><div id="message" class="error" role="alert" tabindex="-1" ${message ? '' : 'hidden'}>${e(message)}</div>${state === 'error' ? '' : `<form id="auth-form">${fields[state]}<button class="primary" type="submit">${state === 'sign-in' ? 'Sign in' : state === 'forgot' ? 'Send reset code' : state === 'forgot-confirm' ? 'Reset password' : 'Continue'}</button></form>`}${state === 'sign-in' ? '<button class="quiet" id="auth-forgot">Forgot password?</button>' : '<button class="quiet" id="auth-back">Back to sign in</button>'}</div><footer>freeDMS</footer></section><aside class="auth-photo" aria-label="Vehicle lot at dusk" style="background-image:linear-gradient(180deg,rgba(11,31,44,.08),rgba(11,31,44,.5)),url('${duskLotUrl}')"></aside></main>`;
}
export const signInHtml = () => loginHtml('sign-in');
export const newPasswordHtml = () => loginHtml('new-password');
export const totpHtml = () => loginHtml('totp');
export const forgotHtml = () => loginHtml('forgot');
export const forgotConfirmHtml = () => loginHtml('forgot-confirm');
export const loginErrorHtml = (message: string) => loginHtml('error', message);
export function mountLogin(root: HTMLElement, client: Cognito, complete: (tokens: Tokens) => Promise<void>): void {
  let state: LoginState = 'sign-in'; let session: ChallengeSession | undefined; let username = ''; let generation = 0;
  function render(message = '') {
    const current = ++generation;
    root.innerHTML = loginHtml(state, message, session?.secretCode);
    root.querySelector('#auth-back')?.addEventListener('click', () => { session = undefined; state = 'sign-in'; render(); });
    root.querySelector('#auth-forgot')?.addEventListener('click', () => { state = 'forgot'; render(); });
    root.querySelector<HTMLFormElement>('#auth-form')?.addEventListener('submit', async event => {
      event.preventDefault(); const form = event.currentTarget as HTMLFormElement; const data = new FormData(form);
      const button = form.querySelector('button')!; button.disabled = true;
      try {
        let result: AuthResult | undefined;
        if (state === 'sign-in') { username = String(data.get('email')); result = await client.signIn(username, String(data.get('password'))); }
        else if (state === 'new-password') result = await client.respondNewPassword(session!, String(data.get('password')));
        else if (state === 'totp') result = await client.respondTotp(session!, String(data.get('code')));
        else if (state === 'totp-setup') result = await client.completeTotpSetup(session!, String(data.get('code')));
        else if (state === 'forgot') { username = String(data.get('email')); await client.forgotPassword(username); if (current === generation) state = 'forgot-confirm'; }
        else if (state === 'forgot-confirm') { await client.confirmForgotPassword(username, String(data.get('code')), String(data.get('password'))); if (current === generation) state = 'sign-in'; }
        if (current !== generation || !root.contains(form)) return;
        form.reset();
        if (result && 'tokens' in result) { session = undefined; await complete(result.tokens); return; }
        if (result && 'challenge' in result) { state = result.challenge; session = result.session; }
        render();
      } catch (error) {
        if (current !== generation || !root.contains(form)) return;
        const alert = root.querySelector<HTMLElement>('#message')!; alert.textContent = (error as Error).message; alert.hidden = false; alert.focus();
        const secret = form.querySelector<HTMLInputElement>('[name="password"]'); if (secret) secret.value = '';
      } finally { button.disabled = false; }
    });
  }
  render();
}

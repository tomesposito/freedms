import { TERMS_VERSION, PRIVACY_VERSION } from '@freedms/shared';
import type { Invite } from '@freedms/shared';
import { escapeHtml as e } from './format';
import { bindInviteCopies, inviteLinksHtml } from './invites';
interface InviteRow { name: string; email: string; role: string }
export interface Onboarding { name: string; email: string; dealership: string; address: string; phone: string; dealerType: string; invites: InviteRow[] }
export function onboardingError(data: Onboarding, step: number, accepted = false): string {
  const email = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) && value.trim().length <= 254;
  if (step === 0 && (!data.name.trim() || !email(data.email))) return 'Enter your name and a valid email address.';
  if (step === 1 && (![data.dealership, data.address, data.phone].every(v => v.trim()) || !['independent', 'franchise', 'other'].includes(data.dealerType))) return 'Enter your dealership name, address, phone, and dealer type.';
  if (step === 2) {
    if (data.invites.length > 10) return 'Enter at most 10 invites.';
    const seen = new Set([data.email.trim().toLowerCase()]);
    for (const row of data.invites) {
      if (!row.name.trim() || !email(row.email) || !['admin', 'staff'].includes(row.role)) return 'Each invite needs a name, valid email address, and role.';
      const address = row.email.trim().toLowerCase();
      if (seen.has(address)) return 'Invite emails must be unique and different from your account email.';
      seen.add(address);
    }
  }
  if (step === 3 && !accepted) return 'Agree to the Terms of Service and Privacy Notice to finish.';
  return '';
}
export function signupPayload(data: Onboarding) {
  return {...data, onboarding: true as const, acceptance: {termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION}};
}
export function acceptanceHtml(accepted: boolean): string {
  return `<p><strong>Draft — pending final legal review</strong></p><p>By accepting, you represent that the dealership exists and you have authority to bind it. If no dealership is bound because it does not exist or you lack authority, you agree personally to be bound as the Dealer, as described in Section 1.1.</p><label><input type="checkbox" name="termsAccepted" ${accepted ? 'checked' : ''}> I agree to the <a href="#/terms" target="_blank" rel="noopener noreferrer">Terms of Service</a> and <a href="#/privacy" target="_blank" rel="noopener noreferrer">Privacy Notice</a></label>`;
}
export function mountOnboarding(root: HTMLElement, finish: (data: ReturnType<typeof signupPayload>) => Promise<{invites: Invite[]}>, enter: () => void): void {
  const data: Onboarding = {name: '', email: '', dealership: '', address: '', phone: '', dealerType: '', invites: []};
  let step = 0, accepted = false;
  const field = (label: string, key: string, value: string, max = 120, type = 'text') => `<label>${label}<input name="${key}" value="${e(value)}" maxlength="${max}" type="${type}"></label>`;
  function render() {
    const titles = ['Your account', 'Your dealership', 'Invite your team (optional)', 'Review and finish'];
    root.innerHTML = `<p class="eyebrow">Step ${step + 1} of 4</p><h2>${titles[step]}</h2><form novalidate><div class="error" role="alert" tabindex="-1" hidden></div>${step === 0 ? field('Your name', 'name', data.name) + field('Email', 'email', data.email, 254, 'email') : step === 1 ? field('Dealership name', 'dealership', data.dealership) + field('Address', 'address', data.address, 500) + field('Phone', 'phone', data.phone, 50, 'tel') + `<label>Dealer type<select name="dealerType">${['', 'independent', 'franchise', 'other'].map(v => `<option value="${v}" ${data.dealerType === v ? 'selected' : ''}>${v || 'Choose a dealer type'}</option>`).join('')}</select></label>` : step === 2 ? `<p>Share invite links yourself. No email is sent. Up to 10 invites.</p>${data.invites.map((row, i) => `<fieldset><legend>Invite ${i + 1}</legend>${field('Name', `name-${i}`, row.name)}${field('Email', `email-${i}`, row.email, 254, 'email')}<label>Role<select name="role-${i}">${['staff', 'admin'].map(v => `<option ${row.role === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label><button type="button" data-remove="${i}">Remove invite ${i + 1}</button></fieldset>`).join('')}<button type="button" id="add-invite" ${data.invites.length >= 10 ? 'disabled' : ''}>Add invite</button>` : `<h3>Your account</h3><p>${e(data.name)} · ${e(data.email)}</p><h3>Your dealership</h3><p>${e(data.dealership)}<br>${e(data.address)}<br>${e(data.phone)} · ${e(data.dealerType)}</p><h3>Your team</h3>${data.invites.length ? `<ul>${data.invites.map(r => `<li>${e(r.name)} · ${e(r.email)} · ${e(r.role)}</li>`).join('')}</ul>` : '<p>No invites.</p>'}<p>Finish creates your empty workspace and pending invites. No email is sent.</p>${acceptanceHtml(accepted)}`}<div class="form-actions">${step ? '<button type="button" id="wizard-back">Back</button>' : ''}<button class="primary" type="submit" ${step === 3 && !accepted ? 'disabled' : ''}>${step === 3 ? 'Finish' : step === 2 && !data.invites.length ? 'Skip / Next' : 'Next'}</button></div></form>`;
    const form = root.querySelector('form')!;
    const checkbox = form.querySelector<HTMLInputElement>('[name=termsAccepted]');
    checkbox?.addEventListener('change', () => { accepted = checkbox.checked; form.querySelector<HTMLButtonElement>('[type=submit]')!.disabled = !accepted; });
    const save = () => {
      const values = new FormData(form);
      if (step === 0 || step === 1) for (const key of (step === 0 ? ['name', 'email'] : ['dealership', 'address', 'phone', 'dealerType']) as (keyof Omit<Onboarding, 'invites'>)[]) data[key] = String(values.get(key) ?? '');
      if (step === 2) data.invites.forEach((row, i) => { for (const key of ['name', 'email', 'role'] as const) row[key] = String(values.get(`${key}-${i}`) ?? ''); });
    };
    root.querySelector('#wizard-back')?.addEventListener('click', () => { save(); step--; render(); });
    root.querySelector('#add-invite')?.addEventListener('click', () => { save(); data.invites.push({name: '', email: '', role: 'staff'}); render(); });
    root.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(b => b.addEventListener('click', () => { save(); data.invites.splice(Number(b.dataset.remove), 1); render(); }));
    form.addEventListener('submit', async event => {
      event.preventDefault(); save();
      const error = root.querySelector<HTMLElement>('[role=alert]')!;
      const message = step === 3 ? [0, 1, 2, 3].map(s => onboardingError(data, s, accepted)).find(Boolean) : onboardingError(data, step);
      if (message) { error.textContent = message; error.hidden = false; error.focus(); return; }
      if (step < 3) { step++; render(); return; }
      form.querySelectorAll('button').forEach(b => { b.disabled = true; });
      try {
        const result = await finish(signupPayload(data));
        root.innerHTML = `<h2>Your workspace is ready</h2><p>No email was sent. Copy and share these invite links yourself. Invitees can open their link to set up a profile and join.</p>${inviteLinksHtml(result.invites)}<button id="enter-app" class="primary">Enter workspace</button>`;
        bindInviteCopies(root); root.querySelector('#enter-app')!.addEventListener('click', enter);
      } catch (reason) { error.textContent = reason instanceof Error ? reason.message : 'Unable to create workspace.'; error.hidden = false; error.focus(); form.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
    });
  }
  render();
}

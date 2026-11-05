import { assistantTiers } from '@freedms/shared';
import type { UI } from './desking';
import { escapeHtml as e } from './format';
import { showLoadError } from './load-error';

export const pendingBilling = "Billing isn't set up yet.";
export const assistantAccountCard = '<section class="card"><h2><a href="#/account/assistant">AI assistant</a></h2><p>Plan, credits, and controls for this dealership.</p></section>';
export interface AssistantAdminData {
  billingConfigured?: boolean;
  plan: null | {tier: string; tierName: string; pricePerUserCents: number; creditsPerUser: number; billedUserCount: number; monthlyTotalCents: number; renewalDate: string; status: string; accessUntil?: string};
  pool?: {allotmentCredits: number; topUpCredits: number; balanceCredits: number; usedCredits: number; cycleStart: string; cycleEnd: string};
  usage?: {userId: string; name: string; actions: number; credits: number; lastUsedAt: string | null; skills?: Record<string, {actions: number; credits: number}>}[];
  controls?: {disabled: boolean; overageEnabled: boolean; overageCapCredits: number; perRequestCreditCap: number};
}
const date = (value: string) => e(new Date(value.slice(0, 10) + 'T12:00:00Z').toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'}));
const dollars = (cents: number) => e((cents / 100).toLocaleString('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: 2, minimumFractionDigits: cents % 100 ? 2 : 0}));
export function assistantAdminHtml(data: AssistantAdminData, admin = true): string {
  if (!admin) return '<section class="card">Only a workspace admin can change assistant settings.</section>';
  const heading = '<h1>AI assistant</h1><p>Plan, credits, and controls for this dealership. Changes here apply to everyone in the store.</p>';
  const tiers = Object.entries(assistantTiers).map(([key, tier]) => `<div class="assistant-admin-row"><strong>${e(tier.name)}</strong><span>${dollars(tier.pricePerUserCents)} / user / mo</span><span>${tier.creditsPerUser} credits / user</span><button data-billing="checkout" data-tier="${key}">Subscribe to ${e(tier.name)}</button></div>`).join('');
  if (!data.plan) return `${heading}<section class="card empty"><h2>No AI assistant plan yet</h2>${data.billingConfigured ? tiers : `<p>${pendingBilling}</p>`}</section>`;
  const plan = data.plan, pool = data.pool!, controls = data.controls!, usage = data.usage ?? [];
  const total = pool.allotmentCredits + pool.topUpCredits;
  const percent = total ? Math.min(100, Math.max(0, pool.usedCredits / total * 100)) : 100;
  return `${heading}<section class="card"><h2 class="eyebrow">PLAN</h2><div class="assistant-admin-row">
    <span><strong>${e(plan.tierName)}</strong> — ${dollars(plan.pricePerUserCents)} / user / mo</span><span>${e(plan.billedUserCount)} users</span>
    <span>${dollars(plan.monthlyTotalCents)} / month</span><span>${plan.accessUntil ? `Cancels ${date(plan.accessUntil)}` : `Renews ${date(plan.renewalDate)}`}</span><span class="badge">${e(plan.status)}</span>
    <button data-billing="portal" ${data.billingConfigured ? '' : 'disabled'}>Manage billing</button></div>${plan.status === 'past_due' ? '<p role="status">Payment is past due. Use Manage billing to update payment and resume the assistant.</p>' : ''}${data.billingConfigured ? '' : `<p role="status">${pendingBilling}</p>`}${data.billingConfigured && plan.status === 'cancelled' ? tiers : ''}</section>
    <section class="card"><h2 class="eyebrow">CREDIT POOL</h2><div class="assistant-admin-row"><span>${e(pool.balanceCredits)} of ${e(total)} credits left</span>
    <span>${e(pool.usedCredits)} used</span><span>Resets ${date(pool.cycleEnd)}</span>${data.billingConfigured ? '<label>Credits to add<input data-topup-credits type="number" min="1" max="100000" step="1" value="100" required></label>' : ''}<button data-billing="topup" ${data.billingConfigured && plan.status === 'active' ? '' : 'disabled'}>Top up</button></div>
    <progress class="assistant-admin-progress" max="100" value="${percent}" aria-label="Credit pool used">${percent}%</progress>
    <p class="muted">Top-ups are 25¢ a credit. Failed assistant actions are never charged.</p></section>
    <section class="card"><h2 class="eyebrow">USAGE BY PERSON — THIS CYCLE</h2>${usage.length ? `<div class="table-wrap"><table><thead><tr><th>Person</th><th>Actions</th><th>Credits</th><th>Last used</th></tr></thead><tbody>${usage.map(row => `<tr><td>${e(row.name)}${Object.entries(row.skills ?? {}).map(([skill, usage]) => `<small>${e(skill.replace(/_/g, ' '))}: ${e(usage.actions)} actions · ${e(usage.credits)} credits</small>`).join('')}</td><td>${e(row.actions)}</td><td>${e(row.credits)}</td><td>${row.lastUsedAt ? e(new Date(row.lastUsedAt).toLocaleString()) : 'Never'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No assistant use yet this cycle.</p>'}</section>
    <section class="card"><h2 class="eyebrow">CONTROLS</h2>
    <div class="assistant-admin-control"><div><label for="assistant-enabled">Assistant for this dealership</label><p class="muted">Turning off stops all use and charging here. It does not cancel the plan.</p></div><input id="assistant-enabled" data-setting="disabled" type="checkbox" role="switch" ${controls.disabled ? '' : 'checked'}></div>
    <div class="assistant-admin-control"><div><label for="assistant-overage">Overage</label><p class="muted">Keep working past the pool at 25¢ a credit, up to the monthly cap.</p></div><input id="assistant-overage" data-setting="overageEnabled" type="checkbox" role="switch" ${controls.overageEnabled ? 'checked' : ''}><label>Monthly overage cap<input data-setting="overageCapCredits" type="number" min="0" max="100000" step="1" required value="${e(controls.overageCapCredits)}"></label></div>
    <div class="assistant-admin-control"><div><label for="assistant-request-cap">Per-request credit cap</label><p class="muted">One message can never spend more than this, however long the job runs.</p></div><input id="assistant-request-cap" data-setting="perRequestCreditCap" aria-label="Per-request credit cap" type="number" min="1" max="1000" step="1" required value="${e(controls.perRequestCreditCap ?? 25)}"></div></section>`;
}
export async function assistantAdminRoute(ui: UI): Promise<void> {
  if (!ui.admin) { ui.shell(assistantAdminHtml({plan: null}, false)); return; }
  ui.shell('<h1>AI assistant</h1><p>Loading plan and controls…</p>');
  try {
    const data = await ui.api<AssistantAdminData>('/assistant/admin');
    if (!ui.current()) return;
    ui.shell(assistantAdminHtml(data));
    document.querySelectorAll<HTMLButtonElement>('[data-billing]').forEach(button => button.addEventListener('click', async () => {
      const action = button.dataset.billing!;
      const input = document.querySelector<HTMLInputElement>('[data-topup-credits]');
      if (action === 'topup' && !input?.checkValidity()) { input?.reportValidity(); return; }
      button.disabled = true;
      try {
        const result = await ui.api<{url: string}>(`/assistant/admin/billing/${action}`, 'POST', action === 'checkout' ? {tier: button.dataset.tier} : action === 'topup' ? {credits: Number(input!.value)} : {});
        if (ui.current()) window.location.assign(result.url);
      } catch (error) { if (ui.current()) ui.flash(error); }
      finally { button.disabled = false; }
    }));
    document.querySelectorAll<HTMLInputElement>('[data-setting]').forEach(input => input.addEventListener('change', async () => {
      const key = input.dataset.setting!;
      if (!input.checkValidity()) { input.reportValidity(); ui.flash(new Error('Enter a whole number within the displayed limits.')); return; }
      if (key === 'disabled' && !confirm(`${input.checked ? 'Turn on' : 'Turn off'} the assistant for everyone at this dealership?`)) { input.checked = !input.checked; return; }
      const value = input.type === 'checkbox' ? (key === 'disabled' ? !input.checked : input.checked) : Number(input.value);
      const inputs = document.querySelectorAll<HTMLInputElement>('[data-setting]');
      inputs.forEach(control => {control.disabled = true;});
      try {
        await ui.api('/assistant/admin/settings', 'PUT', {[key]: value});
        if (ui.current()) ui.refresh();
      } catch (error) {
        if (input.type === 'checkbox') input.checked = !input.checked;
        else input.value = String(data.controls![key as 'overageCapCredits' | 'perRequestCreditCap']);
        if (ui.current()) ui.flash(error);
      } finally { inputs.forEach(control => {control.disabled = false;}); }
    }));
  } catch (error) { showLoadError(ui, error, () => { void assistantAdminRoute(ui); }); }
}

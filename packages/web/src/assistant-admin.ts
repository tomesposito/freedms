import { assistantTiers } from '@freedms/shared';
import type { UI } from './desking';
import { escapeHtml as e } from './format';
import { showLoadError } from './load-error';

export const pendingBilling = "Billing isn't set up yet.";
export const assistantAccountCard = '<section class="card"><h2><a href="#/account/assistant">AI assistant</a></h2><p>Plan, credits, and controls for this dealership.</p></section>';
export interface AssistantAdminData {
  billingConfigured?: boolean; billingTestMode?: boolean; billingHold?: string;
  waitlist?: null | {tier: string; tierName: string; pricePerUserCents: number; creditsPerUser: number; requestedAt: string; requestedByName: string};
  users?: {userId: string; name: string; assigned: boolean}[];
  plan: null | {tier: string; tierName: string; pricePerUserCents: number; creditsPerUser: number; billedUserCount: number; monthlyTotalCents: number; renewalDate: string; status: string; accessUntil?: string};
  pool?: {allotmentCredits: number; topUpCredits: number; balanceCredits: number; usedCredits: number; cycleStart: string; cycleEnd: string};
  usage?: {userId: string; name: string; actions: number; credits: number; lastUsedAt: string | null; skills?: Record<string, {actions: number; credits: number}>}[];
  controls?: {disabled: boolean; overageEnabled: boolean; overageCapCredits: number; perRequestCreditCap: number};
}
const date = (value: string) => e(new Date(value.slice(0, 10) + 'T12:00:00Z').toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'}));
const dollars = (cents: number) => e((cents / 100).toLocaleString('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: 2, minimumFractionDigits: cents % 100 ? 2 : 0}));
export function assistantAdminHtml(data: AssistantAdminData, admin = true): string {
  if (!admin) return '<section class="card">Only a workspace admin can change assistant settings.</section>';
  const heading = '<h1>AI assistant</h1><p>Only people assigned AI access are billed. Credits are shared by those people in this dealership.</p>' + (data.billingTestMode ? '<p class="assistant-note" role="status">Stripe test mode — available only to the app super admin. Use test payment details. No real payments are collected.</p>' : '');
  const seats = data.billingConfigured && data.users?.length ? `<section class="card"><h2>People with AI access</h2>${data.users.map(user => `<label class="check"><input type="checkbox" data-ai-user="${e(user.userId)}" ${user.assigned ? 'checked' : ''}>${e(user.name)}</label>`).join('')}<p class="muted">Choose at least one person. Adding paid seats or upgrading is prorated and requires successful payment. Removing seats reduces future charges without refunding this month's payment.</p>${data.plan && data.plan.status === 'active' ? `<label>Plan<select data-ai-tier>${Object.entries(assistantTiers).map(([id, tier]) => `<option value="${id}" ${id === data.plan!.tier ? 'selected' : ''}>${e(tier.name)} — ${dollars(tier.pricePerUserCents)} / AI user / month</option>`).join('')}</select></label><button data-billing="seats">Save AI access and plan</button>` : ''}</section>` : '';

  const tiers = Object.entries(assistantTiers).map(([key, tier]) => `<div class="assistant-admin-row"><strong>${e(tier.name)}</strong><span>${dollars(tier.pricePerUserCents)} / AI user / mo</span><span>${tier.creditsPerUser} credits / AI user</span><button data-billing="checkout" data-tier="${key}">Subscribe to ${e(tier.name)}</button></div>`).join('');
  const waitlistTiers = Object.entries(assistantTiers).map(([key, tier]) => `<div class="assistant-admin-row"><strong>${e(tier.name)}</strong><span>${dollars(tier.pricePerUserCents)} / AI user / mo</span><span>${tier.creditsPerUser} credits / AI user</span><button data-waitlist="join" data-tier="${key}">Join waiting list</button></div>`).join('');
  if (!data.plan) {
    if (!data.billingConfigured && data.waitlist) return `${heading}${seats}<section class="card"><h2>You're on the waiting list</h2><div class="assistant-admin-row"><span><strong>${e(data.waitlist.tierName)}</strong> — ${dollars(data.waitlist.pricePerUserCents)} / AI user / mo</span><span>${data.waitlist.creditsPerUser} credits / AI user</span><span>Requested ${date(data.waitlist.requestedAt)}</span></div><p>We'll reach out when paid plans open. Nothing is charged and no plan has started.</p><div class="form-actions"><button data-waitlist="change">Change plan</button><button data-waitlist="leave">Leave the list</button></div></section>`;
    return `${heading}${seats}<section class="card empty"><h2>No AI assistant plan yet</h2>${data.billingConfigured ? tiers : `<p>Paid plans are opening soon. Join the waiting list for the plan you want and we'll reach out when it opens. Joining doesn't start a plan or charge anything.</p>${waitlistTiers}`}</section>`;
  }
  const plan = data.plan, pool = data.pool!, controls = data.controls!, usage = data.usage ?? [];
  const total = pool.allotmentCredits + pool.topUpCredits;
  const percent = total ? Math.min(100, Math.max(0, pool.usedCredits / total * 100)) : 100;
  return `${heading}${seats}${data.billingHold ? '<p role="alert">AI access is paused for a refund or dispute review. Contact support before resuming use.</p>' : ''}<section class="card"><h2 class="eyebrow">PLAN</h2><div class="assistant-admin-row">
    <span><strong>${e(plan.tierName)}</strong> — ${dollars(plan.pricePerUserCents)} / AI user / mo</span><span>${e(plan.billedUserCount)} AI users</span>
    <span>${dollars(plan.monthlyTotalCents)} / month</span><span>${plan.accessUntil ? `Cancels ${date(plan.accessUntil)}` : `Renews ${date(plan.renewalDate)}`}</span><span class="badge">${e(plan.status)}</span>
    <button data-billing="portal" ${data.billingConfigured ? '' : 'disabled'}>Manage billing</button></div>${plan.status === 'past_due' ? '<p role="status">Payment is past due. Use Manage billing to update payment and resume the assistant.</p>' : ''}${data.billingConfigured ? '' : `<p role="status">${pendingBilling}</p>`}${data.billingConfigured && plan.status === 'cancelled' ? tiers : ''}</section>
    <section class="card"><h2 class="eyebrow">CREDIT POOL</h2><div class="assistant-admin-row"><span>${e(pool.balanceCredits)} of ${e(total)} credits left</span>
    <span>${e(pool.usedCredits)} used</span><span>Resets ${date(pool.cycleEnd)}</span>${data.billingConfigured ? '<label>Credits to add<input data-topup-credits type="number" min="2" max="100000" step="1" value="100" required></label>' : ''}<button data-billing="topup" ${data.billingConfigured && plan.status === 'active' ? '' : 'disabled'}>Top up</button></div>
    <progress class="assistant-admin-progress" max="100" value="${percent}" aria-label="Credit pool used">${percent}%</progress>
    <p class="muted">Top-ups are 25¢ a credit, with a 2-credit minimum. Unused purchased credits carry forward. Monthly included credits reset after successful renewal.</p></section>
    <section class="card"><h2 class="eyebrow">USAGE BY PERSON — THIS CYCLE</h2>${usage.length ? `<div class="table-wrap"><table><thead><tr><th>Person</th><th>Actions</th><th>Credits</th><th>Last used</th></tr></thead><tbody>${usage.map(row => `<tr><td>${e(row.name)}${Object.entries(row.skills ?? {}).map(([skill, usage]) => `<small>${e(skill.replace(/_/g, ' '))}: ${e(usage.actions)} actions · ${e(usage.credits)} credits</small>`).join('')}</td><td>${e(row.actions)}</td><td>${e(row.credits)}</td><td>${row.lastUsedAt ? e(new Date(row.lastUsedAt).toLocaleString()) : 'Never'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No assistant use yet this cycle.</p>'}</section>
    <section class="card"><h2 class="eyebrow">CONTROLS</h2>
    <div class="assistant-admin-control"><div><label for="assistant-enabled">Assistant for this dealership</label><p class="muted">Turning off stops all use and charging here. It does not cancel the plan.</p></div><input id="assistant-enabled" data-setting="disabled" type="checkbox" role="switch" ${controls.disabled ? '' : 'checked'}></div>
    <p class="muted">Usage stops when prepaid credits run out. Automatic overage billing is unavailable.</p>
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
      const userIds = [...document.querySelectorAll<HTMLInputElement>('[data-ai-user]:checked')].map(input => input.dataset.aiUser!);
      if (['checkout', 'seats'].includes(action) && !userIds.length) { ui.flash(new Error('Select at least one person for AI access.')); return; }
      const requestId = button.dataset.purchaseId ??= crypto.randomUUID();
      button.disabled = true;
      try {
        const result = await ui.api<{url: string}>(`/assistant/admin/billing/${action}`, 'POST', action === 'checkout' ? {tier: button.dataset.tier, userIds} : action === 'seats' ? {userIds, tier: document.querySelector<HTMLSelectElement>('[data-ai-tier]')!.value} : action === 'topup' ? {credits: Number(input!.value), requestId} : {});
        if (ui.current()) { if (result.url === window.location.href) ui.refresh(); else window.location.assign(result.url); }
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
    const bindWaitlist = () => {
      document.querySelectorAll<HTMLButtonElement>('[data-waitlist]').forEach(button => button.addEventListener('click', async () => {
        const action = button.dataset.waitlist!;
        if (action === 'change') { ui.shell(assistantAdminHtml({...data, waitlist: null})); bindWaitlist(); return; }
        button.disabled = true;
        try {
          if (action === 'join') await ui.api('/assistant/admin/waitlist', 'POST', {tier: button.dataset.tier});
          else await ui.api('/assistant/admin/waitlist', 'DELETE', {});
          if (ui.current()) ui.refresh();
        } catch (error) { if (ui.current()) ui.flash(error); }
        finally { button.disabled = false; }
      }));
    };
    bindWaitlist();
  } catch (error) { showLoadError(ui, error, () => { void assistantAdminRoute(ui); }); }
}

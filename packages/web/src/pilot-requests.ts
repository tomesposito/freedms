import { assistantTiers, type AccessRequest, type AssistantWaitlistEntry } from '@freedms/shared';
import type { UI } from './desking';
import { escapeHtml as e } from './format';
import { showLoadError } from './load-error';

const date = (value: string) => e(new Date(value).toLocaleString());
export type WaitlistRow = AssistantWaitlistEntry & {tenantName: string};
export function pilotRequestsHtml(requests: AccessRequest[], status: AccessRequest['status'], waitlist: WaitlistRow[] = []): string {
  return `<div class="heading"><div><p class="eyebrow">PILOT ADMINISTRATION</p><h1>Pilot requests</h1><p>Review dealership requests and follow up privately. Marking a request handled does not create an account or send an invitation.</p></div><button id="refresh-requests" type="button">Refresh</button></div>
    <nav class="filters" aria-label="Request status"><a class="button${status === 'pending' ? ' primary' : ''}" href="#/pilot-requests" ${status === 'pending' ? 'aria-current="page"' : ''}>Pending</a><a class="button${status === 'handled' ? ' primary' : ''}" href="#/pilot-requests/handled" ${status === 'handled' ? 'aria-current="page"' : ''}>Handled</a></nav>
    <p class="muted">${requests.length} ${status} request${requests.length === 1 ? '' : 's'}</p>
    ${requests.length ? requests.map(r => `<section class="card pilot-request"><h2>${e(r.dealershipName)}</h2><p><strong>${e(r.contactName)}</strong> · <a href="mailto:${e(encodeURIComponent(r.email))}">${e(r.email)}</a></p>
      <dl class="detail-grid"><div><dt>Phone</dt><dd>${e(r.phone || 'Not provided')}</dd></div><div><dt>Inventory</dt><dd>${e(r.inventorySize || 'Not provided')}</dd></div><div><dt>Current DMS</dt><dd>${e(r.currentDms || 'Not provided')}</dd></div><div><dt>Submitted</dt><dd>${date(r.createdAt)}</dd></div></dl>
      <h3>Message</h3><p class="pilot-request-message">${e(r.message || 'No message provided.')}</p>
      <p class="muted">Last updated: ${date(r.updatedAt)}${r.handledAt ? ` · Handled: ${date(r.handledAt)}` : ''}</p>
      ${r.status === 'pending' ? `<div class="form-actions"><button type="button" class="primary" data-handle-request="${e(r.id)}">Mark handled</button></div>` : '<span class="badge">Handled</span>'}</section>`).join('') : `<div class="empty"><h2>No ${status} requests</h2><p>${status === 'pending' ? 'New pilot requests will appear here.' : 'Requests you finish reviewing will appear here.'}</p></div>`}
    <section class="card"><h2>AI assistant waiting list</h2><p class="muted">Workspaces waiting for paid AI plans to open. Joining grants nothing — no plan, no credits.</p>${waitlist.length ? waitlist.map(w => `<div class="assistant-admin-row"><span><strong>${e(w.tenantName)}</strong></span><span>${e(assistantTiers[w.tier].name)}</span><span>${e(w.requestedByName)} · <a href="mailto:${e(encodeURIComponent(w.requestedByEmail))}">${e(w.requestedByEmail)}</a></span><span>${date(w.requestedAt)}</span></div>`).join('') : '<p class="muted">No one is on the AI waiting list yet.</p>'}</section>`;
}

export async function pilotRequestsRoute(ui: UI, allowed: boolean, filter?: string): Promise<void> {
  if (!allowed || !ui.admin) { ui.shell('<h1>Pilot requests</h1><p>Only the pilot operator can review access requests.</p>'); return; }
  const status = filter === 'handled' ? 'handled' : 'pending';
  ui.shell('<h1>Pilot requests</h1><p>Loading requests…</p>');
  try {
    const requests = await ui.api<AccessRequest[]>(`/admin/access-requests?status=${status}`);
    const waitlist = await ui.api<WaitlistRow[]>('/admin/assistant-waitlist').catch(() => [] as WaitlistRow[]);
    if (!ui.current()) return;
    ui.shell(pilotRequestsHtml(requests, status, waitlist));
    document.querySelector('#refresh-requests')?.addEventListener('click', ui.refresh);
    document.querySelectorAll<HTMLButtonElement>('[data-handle-request]').forEach(button => button.addEventListener('click', async () => {
      const request = requests.find(r => r.id === button.dataset.handleRequest);
      if (!request || button.disabled) return;
      button.disabled = true;
      try {
        await ui.api('/admin/access-requests/handled', 'POST', {email: request.email, version: request.version});
        if (ui.current()) ui.refresh();
      } catch (error) { if (ui.current()) ui.flash(error); }
      finally { button.disabled = false; }
    }));
  } catch (error) { showLoadError(ui, error, () => { void pilotRequestsRoute(ui, allowed, filter); }); }
}

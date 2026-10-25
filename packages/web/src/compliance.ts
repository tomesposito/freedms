import { anonymizationNotice, type PrivacyRequest, type Customer, type CustomerDataExport, type OutboxEvent } from '@freedms/shared';
import { complianceCheckResults, complianceCheckResultLabels, type ComplianceCheck, type DealCompliance } from '@freedms/shared';
import { escapeHtml as e } from './format';
import type { UI } from './desking';
export const complianceDisclaimer = 'Dealer-recorded checks and attestations — not an automated screening. These are records of the dealer’s own process; freeDMS did not run or verify checks against any external database.';
const manualItems = [['documentInspected', 'Identity document inspected'], ['addressDiscrepancy', 'Address discrepancy handling'], ['privacyNoticeGiven', 'Privacy notice given']] as const;
export function complianceHtml(view: DealCompliance): string {
  return `<section class="card"><h2>Compliance</h2><p>${complianceDisclaimer}</p><p>${view.complete ? 'All checklist items present.' : 'Incomplete — dealer attestation or supporting records still needed. You can continue working and printing this deal.'} Attestations are the dealer’s responsibility.</p>
    ${!view.record && !view.checks.length ? '<p>No compliance work recorded yet.</p>' : ''}
    <ul>${view.checklist.map(i => `<li>${e(i.label)}: <strong>${i.present ? 'Present' : 'Missing'}</strong> · ${e(i.source)}${i.by ? ` · By ${e(i.by)}` : ''}${i.at ? ` · ${e(i.at)}` : ''}${i.detail ? `<p>${e(i.detail)}</p>` : ''}</li>`).join('')}</ul>
    ${manualItems.map(([key, label]) => `<form data-attestation="${key}"><h3>${label}</h3><label>${key === 'addressDiscrepancy' ? 'Describe how the discrepancy was handled, or enter “no discrepancy found”' : 'Optional note'}<textarea name="note" maxlength="2000">${e(view.record?.[key]?.note ?? '')}</textarea></label><button name="action" value="attest">Attest</button>${view.record?.[key] ? '<button name="action" value="clear">Clear attestation</button>' : ''}</form>`).join('')}
    <h3>Record a dealer-performed OFAC / identity check</h3><p>Each submission adds an immutable history entry. Record corrections as new entries.</p><form id="compliance-check"><label>List / source the dealer used<input name="method" required maxlength="120"></label><label>Date performed<input type="date" name="checkedDate" required max="${new Date().toISOString().slice(0, 10)}"></label><label>Dealer-recorded result<select name="result">${complianceCheckResults.map(r => `<option value="${r}">${complianceCheckResultLabels[r]}</option>`).join('')}</select></label><label>Initials<input name="initials" required maxlength="10"></label><label>Notes<textarea name="notes" maxlength="2000"></textarea></label><button>Record check</button></form><a href="#/compliance">Compliance log</a></section>`;
}
export function bindCompliance(id: string, view: DealCompliance, ui: UI): void {
  const base = `/deals/${encodeURIComponent(id)}`;
  document.querySelectorAll<HTMLFormElement>('[data-attestation]').forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter as HTMLButtonElement; button.disabled = true;
    try {
      await ui.api(base + '/compliance', view.record ? 'PUT' : 'POST', {...(view.record ? {version: view.record.version} : {}), [form.dataset.attestation!]: button.value === 'clear' ? null : {note: String(new FormData(form).get('note') ?? '')}});
      if (ui.current()) ui.refresh();
    } catch (error) { if (ui.current()) ui.flash(error); button.disabled = false; }
  }));
  document.querySelector<HTMLFormElement>('#compliance-check')!.addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget as HTMLFormElement, button = form.querySelector('button')!; button.disabled = true;
    try { await ui.api(base + '/compliance-checks', 'POST', Object.fromEntries(new FormData(form))); if (ui.current()) ui.refresh(); }
    catch (error) { if (ui.current()) ui.flash(error); button.disabled = false; }
  });
}
export function complianceLogHtml(checks: ComplianceCheck[], search: string): string {
  return `<h1>Compliance log</h1><p>${complianceDisclaimer}</p><form id="compliance-search"><label>Search customer, source, initials or result<input name="search" type="search" maxlength="200" value="${e(search)}"></label><button>Search</button></form>${checks.length ? `<div class="table-wrap"><table><thead><tr><th>Customer</th><th>Date</th><th>List / source</th><th>Result</th><th>Initials</th><th>Recorded by / at</th><th>Deal</th></tr></thead><tbody>${checks.map(c => `<tr><td>${e(c.customerName)}</td><td>${e(c.checkedDate)}</td><td>${e(c.method)}</td><td>${e(complianceCheckResultLabels[c.result])}</td><td>${e(c.initials)}</td><td>${e(c.performedBy)} · ${e(c.performedAt)}</td><td>${c.dealId ? `<a href="#/deals/${e(c.dealId)}">Deal</a>` : '—'}</td></tr>`).join('')}</tbody></table></div>` : `<p class="empty">${search ? 'No matching checks.' : 'No checks recorded yet. Record a check from a deal jacket or the deal’s Compliance link.'}</p>`}`;
}
export async function complianceRoute(ui: UI, section?: string): Promise<void> {
  if (section === 'privacy') return privacyRoute(ui);
  if (section === 'audit') return auditRoute(ui);
  const render = async (search: string) => {
    const checks = await ui.api<ComplianceCheck[]>(`/compliance/checks?search=${encodeURIComponent(search)}`); if (!ui.current()) return;
    ui.shell(complianceNavigation(ui.admin) + complianceLogHtml(checks, search));
    document.querySelector<HTMLFormElement>('#compliance-search')!.addEventListener('submit', event => {
      event.preventDefault(); void render(String(new FormData(event.currentTarget as HTMLFormElement).get('search') ?? '')).catch(ui.flash);
    });
  };
  await render('');
}
export async function dealComplianceRoute(id: string, ui: UI): Promise<void> {
  const view = await ui.api<DealCompliance>(`/deals/${encodeURIComponent(id)}/compliance`); if (!ui.current()) return;
  ui.shell(`<a href="#/deals/${e(id)}">← Worksheet</a>${complianceHtml(view)}`); bindCompliance(id, view, ui);
}

export function complianceNavigation(admin: boolean): string {
  return `<nav class="form-actions" aria-label="Compliance"><a class="button" href="#/compliance">Check log</a><a class="button" href="#/compliance/privacy">Privacy requests</a>${admin ? '<a class="button" href="#/compliance/audit">Audit log</a>' : ''}</nav>`;
}
export function privacyHtml(requests: PrivacyRequest[], customers: Customer[]): string {
  return `<h1>Privacy requests</h1><p>Access exports include the customer record, leads, deals and document metadata. Deletion requests anonymize CRM personal fields; financial records the dealer must legally keep (deals, GL) are preserved.</p>
  <section class="card"><h2>Log a request</h2>${customers.length ? `<form id="privacy-create"><label>Customer<select name="customerId" required>${customers.map(c => `<option value="${e(c.id)}">${e(c.name)} · ${e(c.id)}</option>`).join('')}</select></label><label>Request type<select name="type"><option value="access">Access / export</option><option value="deletion">Deletion / anonymization</option></select></label><label>Due date<input name="dueDate" type="date" required></label><button class="primary">Log request</button></form>` : '<p>Create a customer in <a href="#/leads">CRM</a> before logging a request.</p>'}</section>
  ${requests.length ? requests.map(r => `<section class="card" data-request="${e(r.id)}"><h2>${e(customers.find(c => c.id === r.customerId)?.name ?? r.customerId)} · ${r.type === 'access' ? 'Access / export' : 'Deletion / anonymization'}</h2><p><strong>${e(r.status.replace('_', ' '))}</strong> · Due ${e(r.dueDate)}</p><details><summary>Step history (${r.history.length})</summary><ol>${r.history.map(s => `<li><strong>${e(s.action)}</strong> · ${e(s.actor)} · ${e(s.at)}<p>${e(s.note)}</p></li>`).join('')}</ol></details>${r.status === 'fulfilled' && r.type === 'deletion' ? `<p>${anonymizationNotice}</p>` : ''}${['fulfilled', 'denied'].includes(r.status) ? '' : `<form data-privacy-action="${e(r.id)}"><div class="form-actions">${r.status === 'received' ? '<button name="status" value="in_progress">Start progress</button>' : ''}<button class="primary" name="status" value="fulfilled">${r.type === 'access' ? 'Fulfil & download JSON' : 'Anonymize personal fields'}</button></div></form><form data-privacy-deny="${e(r.id)}"><label>Denial reason<textarea name="denialReason" required maxlength="2000"></textarea></label><button>Deny request</button></form>`}</section>`).join('') : '<p class="empty">No privacy requests yet.</p>'}`;
}
export function auditHtml(events: OutboxEvent[], filters: Record<string, string>): string {
  return `<h1>Audit log</h1><p>Read-only workspace events. Actor and target are recorded IDs.</p><form id="audit-filter" class="filters">${[['type', 'Action / event type'], ['actor', 'Actor ID (exact)'], ['target', 'Target ID (exact)'], ['search', 'Search events or date (YYYY-MM-DD)']].map(([key, label]) => `<label>${label}<input name="${key}" value="${e(filters[key] ?? '')}" maxlength="200"></label>`).join('')}<button>Filter</button></form>${events.length ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead><tbody>${events.map(ev => `<tr><td>${e(ev.occurredAt)}</td><td>${e(ev.actorId)}</td><td>${e(ev.action ?? ev.type)}</td><td>${e(ev.aggregateId)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No audit events match this view.</p>'}`;
}
async function privacyRoute(ui: UI): Promise<void> {
  const [requests, customers] = await Promise.all([ui.api<PrivacyRequest[]>('/compliance/privacy-requests'), ui.api<Customer[]>('/customers')]);
  if (!ui.current()) return;
  ui.shell(complianceNavigation(ui.admin) + privacyHtml(requests, customers));
  const bind = (selector: string, run: (form: HTMLFormElement, event: SubmitEvent) => Promise<void>) => document.querySelectorAll<HTMLFormElement>(selector).forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault(); const buttons = [...form.querySelectorAll('button')]; buttons.forEach(b => b.disabled = true);
    try { await run(form, event); if (ui.current()) ui.refresh(); }
    catch (error) { if (ui.current()) { ui.flash(error); buttons.forEach(b => b.disabled = false); } }
  }));
  bind('#privacy-create', async form => { await ui.api('/compliance/privacy-requests', 'POST', Object.fromEntries(new FormData(form))); });
  bind('[data-privacy-action], [data-privacy-deny]', async (form, event) => {
    const id = form.dataset.privacyAction ?? form.dataset.privacyDeny!, r = requests.find(r => r.id === id)!;
    const status = form.dataset.privacyDeny ? 'denied' : (event.submitter as HTMLButtonElement).value;
    const result = await ui.api<{request: PrivacyRequest; export?: CustomerDataExport}>(`/compliance/privacy-requests/${encodeURIComponent(id)}`, 'PUT', {version: r.version, status, ...(status === 'denied' ? {denialReason: new FormData(form).get('denialReason')} : {})});
    if (result.export && ui.current()) {
      const url = URL.createObjectURL(new Blob([JSON.stringify(result.export, null, 2)], {type: 'application/json'}));
      const a = document.createElement('a'); a.href = url; a.download = `customer-export-${id}.json`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  });
}
async function auditRoute(ui: UI): Promise<void> {
  if (!ui.admin) { ui.shell('<h1>Audit log</h1><p>Only administrators can read the audit log.</p>'); return; }
  const render = async (filters: Record<string, string>) => {
    const events = await ui.api<OutboxEvent[]>(`/compliance/audit?${new URLSearchParams(filters)}`); if (!ui.current()) return;
    ui.shell(complianceNavigation(ui.admin) + auditHtml(events, filters));
    document.querySelector<HTMLFormElement>('#audit-filter')!.addEventListener('submit', event => {
      event.preventDefault(); void render(Object.fromEntries(new FormData(event.currentTarget as HTMLFormElement)) as Record<string, string>).catch(ui.flash);
    });
  };
  await render({});
}

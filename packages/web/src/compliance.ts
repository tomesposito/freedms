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
export async function complianceRoute(ui: UI): Promise<void> {
  const render = async (search: string) => {
    const checks = await ui.api<ComplianceCheck[]>(`/compliance/checks?search=${encodeURIComponent(search)}`); if (!ui.current()) return;
    ui.shell(complianceLogHtml(checks, search));
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

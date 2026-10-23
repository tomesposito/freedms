import { adverseActionReasons, adverseActionReasonLabels, decisionOutcomes, housingStatuses, maskedSsn, type CreditApplication, type CreditApplicant, type DealJacket, type PayoffQuote } from '@freedms/shared';
import { cents, currency, escapeHtml as e } from './format';
import type { UI } from './desking';
export const creditBanner = '<p class="card">Not submitted anywhere. No credit bureau was pulled and no lender has received this application. Decisions are recorded manually by the dealer.</p>';
export function payoffHtml(quotes: PayoffQuote[]): string {
  return quotes.length ? '<ul>' + quotes.map(q => `<li>${e(q.lenderName)} · ${currency(q.payoffAmount)} · Good through ${e(q.goodThroughDate)} · Account ${e(q.accountLast4 ? '••••' + q.accountLast4 : 'Not on file')}<p>${e(q.notes)}</p></li>`).join('') + '</ul>' : '<p>No payoff quotes on file.</p>';
}
export function adverseActionHtml(a: DealJacket['adverseAction']): string {
  return a ? `<article class="card jacket-document"><h1>Adverse action notice</h1><p>Applicant: ${e(a.applicantName)} · Decision date: ${e(a.decidedAt)}</p>${a.lenderName ? `<p>Lender: ${e(a.lenderName)}</p>` : ''}<p>The dealer recorded a declined credit decision for this application. Dealer-recorded reasons:</p><ul>${a.reasons.map(r => `<li>${e(adverseActionReasonLabels[r])}</li>`).join('')}</ul><p>This notice records the dealer’s manual decision. No credit bureau was pulled and this application was not submitted anywhere.</p></article>` : '';
}
const fields = [
  ['fullName', 'Full name', 'text'], ['dateOfBirth', 'Date of birth', 'date'], ['address', 'Address', 'text'], ['phone', 'Phone', 'tel'], ['email', 'Email', 'email'],
  ['monthlyHousingPayment', 'Monthly housing payment (USD)', 'money'], ['yearsAtAddress', 'Years at address', 'number'],
  ['employerName', 'Employer', 'text'], ['jobTitle', 'Job title', 'text'], ['yearsEmployed', 'Years employed', 'number'],
  ['grossMonthlyIncome', 'Gross monthly income (USD)', 'money'], ['otherMonthlyIncome', 'Other monthly income (USD)', 'money'], ['otherIncomeSource', 'Other income source', 'text'],
] as const;
function applicantHtml(prefix: string, a?: CreditApplicant | null): string {
  return `<div class="form-grid">${fields.map(([key, label, type]) => `<label>${label}<input name="${prefix}.${key}" type="${type === 'money' ? 'number' : type}" value="${e(type === 'money' ? ((a?.[key] as number ?? 0) / 100).toFixed(2) : a?.[key] ?? (type === 'number' ? 0 : ''))}" ${['fullName', 'dateOfBirth', 'address'].includes(key) ? 'required' : ''} ${type === 'money' ? 'min="0" step="0.01"' : type === 'number' ? 'min="0" max="100" step="1"' : ''}></label>`).join('')}
    <label>Housing status<select name="${prefix}.housingStatus">${housingStatuses.map(h => `<option ${h === a?.housingStatus ? 'selected' : ''}>${h}</option>`).join('')}</select></label>
    <label>SSN · ${e(maskedSsn(a?.ssnLast4 ?? ''))}<input name="${prefix}.ssn" type="password" autocomplete="off" placeholder="Only last 4 are kept; leave blank to retain"></label></div>`;
}
export function creditHtml(a: CreditApplication | null, quotes: PayoffQuote[]): string {
  const locked = a?.status === 'decision-recorded';
  return `<h1>Credit application</h1>${creditBanner}${a ? `<p>Status: ${e(a.status)}</p>` : '<p class="empty">No credit application on file. Enter applicant details and consent to create a local draft.</p>'}
    <form id="credit-form"><fieldset ${locked ? 'disabled' : ''}><h2>Applicant</h2>${applicantHtml('applicant', a?.applicant)}
    <label><input id="has-co" type="checkbox" ${a?.coApplicant ? 'checked' : ''}> Include co-applicant</label>
    <fieldset id="co-fields" ${a?.coApplicant ? '' : 'hidden disabled'}><h2>Co-applicant</h2>${applicantHtml('coApplicant', a?.coApplicant)}</fieldset>
    <label>Consent timestamp (UTC ISO)<input name="consentAt" required placeholder="2026-10-23T12:00:00Z" value="${e(a?.consentAt ?? '')}"></label>
    <button name="action" value="save">Save application</button>${a ? '<button name="action" value="ready">Mark ready</button><button name="action" value="draft">Return to draft</button>' : ''}
    ${a?.status === 'ready' ? `<section><h2>Record manual decision</h2><label>Outcome<select name="outcome">${decisionOutcomes.map(o => `<option>${o}</option>`).join('')}</select></label><label>Lender<input name="lenderName"></label><label>Terms note<textarea name="termsNote"></textarea></label><fieldset id="adverse-reasons" hidden><legend>Dealer-recorded reasons</legend>${adverseActionReasons.map(r => `<label><input type="checkbox" name="reason" value="${r}">${e(adverseActionReasonLabels[r])}</label>`).join('')}</fieldset><button name="action" value="decision-recorded">Record final decision</button></section>` : ''}</fieldset></form>
    ${a?.decision ? `<section><h2>Recorded decision</h2><p>${e(a.decision.outcome)} · ${e(a.decision.lenderName)} · ${e(a.decision.decidedAt)} · ${e(a.decision.decidedBy)}</p><p>${e(a.decision.termsNote)}</p><ul>${a.decision.adverseReasons.map(r => `<li>${e(adverseActionReasonLabels[r])}</li>`).join('')}</ul><p>This application is locked.</p></section>` : ''}
    <h2>Payoff quotes</h2>${payoffHtml(quotes)}<form id="payoff-form"><label>Lender<input name="lenderName" required></label><label>Amount (USD)<input name="payoffAmount" type="number" min="0" step="0.01" required></label><label>Good through<input name="goodThroughDate" type="date" required></label><label>Account number<input name="accountNumber" type="password" autocomplete="off" placeholder="Only last 4 are kept"></label><label>Notes<textarea name="notes"></textarea></label><button>Add payoff quote</button></form>`;
}
export async function creditRoute(id: string, ui: UI) {
  ui.shell('<p>Loading credit application…</p>');
  const base = `/deals/${encodeURIComponent(id)}`;
  // Verify the deal separately: only an absent application is an empty state.
  await ui.api(base);
  const [a, quotes] = await Promise.all([ui.api<CreditApplication>(base + '/credit-application').catch(error => {
    if ((error as {status?: number}).status === 404) return null; throw error;
  }), ui.api<PayoffQuote[]>(base + '/payoff-quotes')]);
  if (!ui.current()) return;
  ui.shell(`<a href="#/deals/${e(id)}">← Worksheet</a>${creditHtml(a, quotes)}`);
  const form = document.querySelector<HTMLFormElement>('#credit-form')!;
  document.querySelector('#has-co')!.addEventListener('change', event => {
    const co = document.querySelector<HTMLFieldSetElement>('#co-fields')!;
    co.hidden = co.disabled = !(event.target as HTMLInputElement).checked;
  });
  form.querySelector('[name="outcome"]')?.addEventListener('change', event => {
    document.querySelector<HTMLElement>('#adverse-reasons')!.hidden = (event.target as HTMLSelectElement).value !== 'declined';
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const data = new FormData(form), value = (key: string) => String(data.get(key) ?? '');
    const person = (prefix: string) => Object.fromEntries([...fields.map(([key, , type]) => [key, type === 'money' ? cents(value(prefix + '.' + key)) : type === 'number' ? Number(value(prefix + '.' + key)) : value(prefix + '.' + key)]), ['housingStatus', value(prefix + '.housingStatus')], ...(value(prefix + '.ssn') ? [['ssn', value(prefix + '.ssn')]] : [])]);
    try {
      const action = (event.submitter as HTMLButtonElement).value;
      await ui.api(base + '/credit-application', a ? 'PUT' : 'POST', {applicant: person('applicant'), coApplicant: (document.querySelector('#has-co') as HTMLInputElement).checked ? person('coApplicant') : null, consentAt: value('consentAt'),
        ...(a ? {version: a.version, status: action === 'save' ? a.status : action} : {}),
        ...(action === 'decision-recorded' ? {decision: {outcome: value('outcome'), lenderName: value('lenderName'), termsNote: value('termsNote'), adverseReasons: value('outcome') === 'declined' ? data.getAll('reason') : []}} : {})});
      form.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach(input => { input.value = ''; });
      if (ui.current()) ui.refresh();
    } catch (error) { if (ui.current()) ui.flash(error); }
  });
  document.querySelector<HTMLFormElement>('#payoff-form')!.addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget as HTMLFormElement, data = new FormData(form);
    try {
      await ui.api(base + '/payoff-quotes', 'POST', {lenderName: data.get('lenderName'), payoffAmount: cents(String(data.get('payoffAmount'))), goodThroughDate: data.get('goodThroughDate'), notes: data.get('notes'), ...(data.get('accountNumber') ? {accountNumber: data.get('accountNumber')} : {})});
      form.reset(); if (ui.current()) ui.refresh();
    } catch (error) { if (ui.current()) ui.flash(error); }
  });
}

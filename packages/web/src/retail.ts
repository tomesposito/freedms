/// <reference types="vite/client" />
import { documentTypes, maxDocumentBytes, type BuyerDealView, type BuyerPaymentOption, type ShareResponse } from '@freedms/shared';
import { currency, escapeHtml as e } from './format';
import type { UI } from './desking';
const unavailableText = 'This link is no longer available. Ask your dealer for a new one.';
export async function publicApi<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`${import.meta.env.VITE_API_URL || '/api'}${path}`, {method, credentials: 'omit', headers: {'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error?.message || 'Unable to complete your request.'), {code: data.error?.code});
  return data.data;
}
export function optionSummary(o: Pick<BuyerPaymentOption, 'termMonths' | 'down' | 'monthlyPayment' | 'amountDue'>): string {
  return `${o.termMonths === null ? 'Cash' : `${e(o.termMonths)} months`} · Down ${currency(o.down)}${o.monthlyPayment === null ? '' : ` · Monthly ${currency(o.monthlyPayment)}`}${o.amountDue === null ? '' : ` · Due ${currency(o.amountDue)}`}`;
}
export function buyerHtml(d: BuyerDealView, local = false): string {
  const v = d.vehicle;
  return `<header><span class="brand"><img src="/logo.svg" alt="freeDMS"></span></header><main><h1>${e(d.dealershipName)}</h1><p>${e(d.customerName)}</p><p>This is a private link your dealer sent you for one deal. It expires ${e(new Date(d.expiresAt).toLocaleString())}.</p>${local ? '<p>Local development link</p>' : ''}<div id="buyer-message" role="status"></div><section class="card"><h2>Vehicle</h2><p>${e(v.year)} ${e(v.make)} ${e(v.model)} ${e(v.trim)}</p><p>Stock # ${e(v.stockNumber)} · VIN ${e(v.vin)}</p></section><section class="card"><h2>Your numbers</h2><p>Buyer's order: ${d.buyersOrderSignature === 'signed' ? 'signed' : 'awaiting signature'}</p>${d.documentsAwaitingSignature > 0 ? `<p>${e(d.documentsAwaitingSignature)} document(s) awaiting signature. Signing happens in store at the dealership.</p>` : ''}<p>Price ${currency(d.price)} · Doc fee ${currency(d.docFee)} · Sales tax ${currency(d.salesTax)}</p><ul>${d.fiProducts.map(p => `<li>${e(p.name)} · ${currency(p.retailPrice)} · ${e(p.termNotes)}</li>`).join('')}</ul><p>F&I total ${currency(d.fiRetailTotal)}</p>${d.trade ? `<p>Trade: ${e(d.trade.year)} ${e(d.trade.make)} ${e(d.trade.model)} · Allowance ${currency(d.trade.allowance)} · Payoff ${currency(d.trade.payoff)} · Net equity ${currency(d.trade.netEquity)}</p>` : ''}<p>Down payment ${currency(d.down)}</p>${d.dealType === 'cash' ? `<p>Cash due ${currency(d.cashDue)}</p>` : `<p>${d.dealType === 'lease' ? 'Adjusted lease balance' : 'Amount financed'} ${currency(d.amountFinanced)} · Monthly payment ${currency(d.monthlyPayment)} · ${e(d.termMonths)} months</p><p>${d.dealType === 'lease' ? 'Equivalent APR' : 'APR'} ${e((d.aprBps / 100).toFixed(2))}% · Total payments ${currency(d.totalPayments)} · ${d.dealType === 'lease' ? 'Total rent charge' : 'Finance charge'} ${currency(d.financeCharge)}</p>${d.dealType === 'lease' ? `<p>Drive-off ${currency(d.cashDue)}</p>` : ''}`}</section><section class="card"><h2>Payment options</h2>${d.paymentOptions.map(o => `<p>${optionSummary(o)} <button data-option="${e(o.id)}">Choose</button></p>`).join('')}</section><section class="card"><h2>Request a change</h2><form id="buyer-change"><label>Message<textarea name="message" required maxlength="1000"></textarea></label><button>Send</button></form></section><section class="card"><h2>Upload documents</h2><p>Local uploads are limited to 40 KiB per file. For pay stubs, choose Other.</p><form id="buyer-upload"><label>Type<select name="type">${documentTypes.map(t => `<option value="${t}">${e(({id: 'ID', insurance: 'Insurance', title: 'Title', registration: 'Registration', 'signed-form': 'Signed form', other: 'Other'})[t])}</option>`).join('')}</select></label><label>File<input name="file" type="file" required></label><label>Name<input name="name" required maxlength="160"></label><button>Upload</button></form></section></main>`;
}
export function responsesHtml(responses: ShareResponse[]): string {
  return responses.length ? responses.map(r => `<article><h3>${r.responseKind === 'payment-choice' ? 'Chose a payment option' : 'Requested a change'}</h3><p>${r.responseKind === 'payment-choice' ? optionSummary(r) : e(r.message)}</p><small>${e(new Date(r.createdAt).toLocaleString())}</small></article>`).join('') : '<p>No buyer responses yet.</p>';
}
export async function buyerRoute(token: string) {
  const app = document.querySelector<HTMLDivElement>('#app')!, hash = location.hash;
  const current = () => location.hash === hash;
  const path = `/share/${encodeURIComponent(token)}`;
  const fail = (error: unknown) => {
    if (!current()) return;
    if ((error as {code?: string}).code === 'SHARE_UNAVAILABLE') app.innerHTML = `<main><p>${unavailableText}</p></main>`;
    else { const target = document.querySelector('#buyer-message') ?? app; target.textContent = error instanceof Error ? error.message : 'Unable to complete your request.'; }
  };
  app.innerHTML = '<main>Loading…</main>';
  try {
    const d = await publicApi<BuyerDealView>(path), {localMode} = await import('./auth'); if (!current()) return;
    app.innerHTML = buyerHtml(d, localMode);
    const send = async (suffix: string, body: unknown, button: HTMLButtonElement) => {
      button.disabled = true;
      try { await publicApi(path + suffix, 'POST', body); if (current()) document.querySelector('#buyer-message')!.textContent = 'Your dealer can see this on the deal.'; } catch (error) { fail(error); } finally { button.disabled = false; }
    };
    app.querySelectorAll<HTMLButtonElement>('[data-option]').forEach(button => button.addEventListener('click', () => { void send('/respond', {optionId: button.dataset.option}, button); }));
    app.querySelector<HTMLFormElement>('#buyer-change')!.addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget as HTMLFormElement; void send('/respond', {message: new FormData(form).get('message')}, form.querySelector('button')!); });
    const form = app.querySelector<HTMLFormElement>('#buyer-upload')!, file = form.elements.namedItem('file') as HTMLInputElement;
    file.addEventListener('change', () => { (form.elements.namedItem('name') as HTMLInputElement).value = file.files?.[0]?.name ?? ''; });
    form.addEventListener('submit', async event => {
      event.preventDefault(); const selected = file.files?.[0]; if (!selected) return;
      if (!selected.size || selected.size > maxDocumentBytes) { fail(new Error('Choose a nonempty file of at most 40 KiB.')); return; }
      try {
        const content = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).replace(/^data:.*?;base64,/, '')); reader.onerror = () => reject(new Error('Could not read the file.')); reader.readAsDataURL(selected); });
        if (!current()) return;
        const data = new FormData(form); await send('/documents', {name: data.get('name'), type: data.get('type'), content}, form.querySelector('button')!);
      } catch (error) { fail(error); }
    });
  } catch (error) { fail(error); }
}
interface ShareStatus { share: {id: string; createdAt: string; expiresAt: string; revokedAt: string | null; active: boolean} | null; responses: ShareResponse[] }
export async function mountSharePanel(ui: UI, dealId: string, dealStatus: string) {
  const path = `/deals/${encodeURIComponent(dealId)}/share`, closed = ['sold', 'dead'].includes(dealStatus);
  let url = '';
  const render = async () => {
    const data = await ui.api<ShareStatus>(path); if (!ui.current()) return;
    const panel = document.querySelector('#share-panel'); if (!panel) return;
    const s = data.share;
    panel.innerHTML = `${s ? `<p>${s.active ? 'Active' : s.revokedAt ? 'Revoked' : 'Unavailable'} · Created ${e(new Date(s.createdAt).toLocaleString())} · Expires ${e(new Date(s.expiresAt).toLocaleString())}</p><p>The link itself is shown only once, when created. Create a new link to replace it.</p>` : '<p>Not shared yet. Create a private link to send this buyer their numbers.</p>'}${closed ? '' : `<button id="share-create">${s ? 'Create new link' : 'Create link'}</button>${s?.active ? ' <button id="share-revoke">Revoke</button>' : ''}`}${url ? `<label>Copy it now — it won't be shown again.<input id="share-url" readonly value="${e(url)}"></label><button id="share-copy">Copy</button><p id="share-copy-status" role="status"></p>` : ''}<h3>Buyer responses</h3>${responsesHtml(data.responses)}`;
    const bind = (id: string, action: () => Promise<void>) => panel.querySelector<HTMLButtonElement>(id)?.addEventListener('click', async event => { const button = event.currentTarget as HTMLButtonElement; button.disabled = true; try { await action(); } catch (error) { if (ui.current()) ui.flash(error); } finally { button.disabled = false; } });
    bind('#share-create', async () => { const created = await ui.api<{token: string}>(path, 'POST', {}); url = `${location.origin}${location.pathname}#/share/${created.token}`; await render(); });
    bind('#share-revoke', async () => { await ui.api(path + '/revoke', 'POST', {}); url = ''; await render(); });
    bind('#share-copy', async () => { await navigator.clipboard.writeText(url); panel.querySelector('#share-copy-status')!.textContent = 'Copied.'; });
  };
  try { await render(); } catch (error) { if (ui.current()) ui.flash(error); }
}

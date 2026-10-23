import type { Aging, GlAccount, RegisterEntry, ReconciliationView, StatementPreview } from '@freedms/shared';
import { currency, escapeHtml as e } from './format';
import type { UI } from './desking';
const table = (headers: string[], rows: string) => `<div class="table-wrap"><table><thead><tr>${headers.map(h => `<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
const input = (name: string, label: string, type = 'text', extra = '') => `<label>${label}<input name="${name}" type="${type}" required ${extra}></label>`;
const options = (accounts: GlAccount[]) => accounts.map(a => `<option value="${e(a.id)}">${e(a.code)} · ${e(a.name)}</option>`).join('');
const select = (name: string, label: string, accounts: GlAccount[]) => `<label>${label}<select name="${name}" required>${options(accounts)}</select></label>`;
export const treasuryNav = '<nav class="filters"><a href="#/accounting">General ledger</a><a href="#/accounting/ap">Accounts payable</a><a href="#/accounting/ar">Accounts receivable</a><a href="#/accounting/cash">Cash & bank</a><a href="#/accounting/reconciliations">Bank reconciliation</a></nav>';
export function agingHtml(report: Aging): string {
  return `<p>As of ${e(report.asOf)} · Open balance ${currency(report.total)} · GL balance ${currency(report.glBalance)}</p>${table(report.buckets.map(b => b.label), `<tr>${report.buckets.map(b => `<td>${currency(b.amount)}</td>`).join('')}</tr>`)}${report.rows.length ? table(['Party / reference', 'Due', 'Account', 'Open', 'Aging', 'Payment'], report.rows.map(i => `<tr><td>${e(i.party)}<br>${e(i.reference)}${i.vehicleId ? `<br>Vehicle: ${e(i.vehicleId)}` : ''}</td><td>${e(i.dueDate)}</td><td>${e(i.accountCode)}</td><td>${currency(i.balance)}</td><td>${e(i.bucket)}</td><td>${i.balance > 0 ? `<button data-pay="${e(i.id)}">Record payment</button>` : 'Credit balance'}</td></tr>`).join('')) : '<p class="empty">No open items.</p>'}`;
}
export function registerHtml(rows: RegisterEntry[]): string {
  return rows.length ? table(['Date', 'Memo', 'Amount', 'Running balance'], rows.map(r => `<tr><td>${e(r.date)}</td><td>${e(r.memo)}</td><td>${currency(r.amount)}</td><td>${currency(r.balance)}</td></tr>`).join('')) : '<p class="empty">No cash entries yet.</p>';
}
export function statementPreviewHtml(p: StatementPreview): string {
  return `<p>${p.validCount} valid · ${p.errorCount} errors · ${p.duplicateCount} duplicates</p>${table(['Row', 'Status', 'Date', 'Description', 'Amount / error'], p.rows.map(r => `<tr><td>${r.rowNumber}</td><td>${e(r.status)}</td><td>${e(r.line?.date ?? '')}</td><td>${e(r.line?.description ?? '')}</td><td>${e(r.error ?? '')}${r.line ? currency(r.line.amount) : ''}</td></tr>`).join(''))}`;
}
function bindForm(id: string, ui: UI, save: (data: FormData) => Promise<void>) {
  document.querySelector<HTMLFormElement>(`#${id}`)?.addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget as HTMLFormElement, button = form.querySelector('button')!; button.disabled = true;
    try { await save(new FormData(form)); } catch (error) { if (ui.current()) ui.flash(error); } finally { button.disabled = false; }
  });
}
const string = (d: FormData, key: string) => String(d.get(key) ?? '');
const number = (d: FormData, key: string) => Number(string(d, key));
export async function treasuryRoute(parts: string[], ui: UI): Promise<void> {
  const section = parts[1], id = parts[2];
  ui.shell('<p>Loading accounting…</p>');
  const [accounts, cash] = await Promise.all([ui.api<GlAccount[]>('/accounting/accounts'), ui.api<GlAccount[]>('/accounting/cash')]);
  if (!ui.current()) return;
  if (section === 'ap' || section === 'ar') {
    const report = await ui.api<Aging>(`/accounting/${section}`); if (!ui.current()) return;
    const ap = section === 'ap';
    const offsets = accounts.filter(a => a.active && (ap ? a.type === 'expense' || (a.type === 'asset' && !cash.some(c => c.id === a.id) && a.code !== '1100') : a.type === 'income'));
    ui.shell(`${treasuryNav}<h1>Accounts ${ap ? 'payable' : 'receivable'}</h1>${agingHtml(report)}<div id="payment"></div><section class="card"><h2>${ap ? 'Enter vendor bill' : 'Enter receivable'}</h2><p>Amounts are integer cents. Posts today. Corrections use journal reversals.${ap ? ' Inventory and recon bills post to the selected GL account; maintain vehicle cost records separately.' : ' Sold-deal balances already appear here; record their receipts without creating another receivable.'}</p><form id="item"><div class="form-grid">${input('party', ap ? 'Vendor / supplier' : 'Customer / lender')}${input('reference', 'Invoice / reference')}${input('amount', 'Amount (cents)', 'number', 'min="1" step="1"')}${input('dueDate', 'Due date', 'date')}${select('offsetAccountId', ap ? 'Inventory / recon / expense account' : 'Income account', offsets)}<label>Vehicle ID (optional)<input name="vehicleId"></label></div><button>Post ${ap ? 'bill' : 'receivable'}</button></form></section>`);
    bindForm('item', ui, async d => { await ui.api(`/accounting/${section}`, 'POST', {party: string(d, 'party'), reference: string(d, 'reference'), amount: number(d, 'amount'), dueDate: string(d, 'dueDate'), offsetAccountId: string(d, 'offsetAccountId'), vehicleId: string(d, 'vehicleId')}); if (ui.current()) ui.refresh(); });
    document.querySelectorAll<HTMLButtonElement>('[data-pay]').forEach(button => button.addEventListener('click', () => {
      const item = report.rows.find(i => i.id === button.dataset.pay)!;
      document.querySelector('#payment')!.innerHTML = `<section class="card"><h2>Payment · ${e(item.party)}</h2><form id="pay"><div class="form-grid">${input('amount', 'Amount (cents)', 'number', `min="1" max="${item.balance}" step="1" value="${item.balance}"`)}${select('cashAccountId', 'Cash / bank account', cash.filter(c => c.active))}${input('reference', 'Payment reference')}</div><button>Post payment</button></form></section>`;
      bindForm('pay', ui, async d => { await ui.api(`/accounting/${section}/${encodeURIComponent(item.id)}/payments`, 'POST', {amount: number(d, 'amount'), cashAccountId: string(d, 'cashAccountId'), reference: string(d, 'reference')}); if (ui.current()) ui.refresh(); });
      document.querySelector('#payment')!.scrollIntoView({behavior: 'smooth'});
    })); return;
  }
  if (section === 'cash') {
    const selected = id ?? cash[0]?.id;
    const rows = selected ? await ui.api<RegisterEntry[]>(`/accounting/cash/${encodeURIComponent(selected)}`) : []; if (!ui.current()) return;
    ui.shell(`${treasuryNav}<h1>Cash & bank register</h1><p>All cash journal entries, including payments and reversals.</p><div class="filters">${cash.map(a => `<a href="#/accounting/cash/${e(a.id)}">${e(a.name)}</a>`).join('')}</div><h2>${e(cash.find(a => a.id === selected)?.name ?? 'Cash')}</h2>${registerHtml(rows)}<section class="card"><h2>Add bank account</h2><form id="bank"><div class="form-grid">${input('code', 'GL code', 'text', 'pattern="[0-9]{3,10}"')}${input('name', 'Bank account name')}</div><button>Add account</button></form></section>`);
    bindForm('bank', ui, async d => { await ui.api('/accounting/cash', 'POST', {code: string(d, 'code'), name: string(d, 'name')}); if (ui.current()) ui.refresh(); }); return;
  }
  if (!id) {
    const periods = await ui.api<ReconciliationView[]>('/accounting/reconciliations'); if (!ui.current()) return;
    ui.shell(`${treasuryNav}<h1>Bank reconciliation</h1>${periods.length ? table(['Account', 'Period', 'Status', 'Difference'], periods.map(p => `<tr><td>${e(accounts.find(a => a.id === p.accountId)?.name ?? '')}</td><td><a href="#/accounting/reconciliations/${e(p.id)}">${e(p.from)} – ${e(p.to)}</a></td><td>${e(p.status)}</td><td>${currency(p.difference)}</td></tr>`).join('')) : '<p class="empty">No statement periods yet.</p>'}<section class="card"><h2>Start statement period</h2><p>Use completed days. Start with a zero opening balance; subsequent periods follow the last closed period and carry its closing balance.</p><form id="period"><div class="form-grid">${select('accountId', 'Bank account', cash.filter(c => c.active))}${input('from', 'From', 'date')}${input('to', 'Through', 'date')}${input('opening', 'Opening balance (cents)', 'number', 'step="1"')}${input('closing', 'Closing balance (cents)', 'number', 'step="1"')}</div><button>Start period</button></form></section>`);
    bindForm('period', ui, async d => { const p = await ui.api<ReconciliationView>('/accounting/reconciliations', 'POST', {accountId: string(d, 'accountId'), from: string(d, 'from'), to: string(d, 'to'), opening: number(d, 'opening'), closing: number(d, 'closing')}); if (ui.current()) location.hash = `#/accounting/reconciliations/${p.id}`; }); return;
  }
  const p = await ui.api<ReconciliationView>(`/accounting/reconciliations/${encodeURIComponent(id)}`);
  const register = await ui.api<RegisterEntry[]>(`/accounting/cash/${encodeURIComponent(p.accountId)}`); if (!ui.current()) return;
  const open = p.status === 'open', endpoint = `/accounting/reconciliations/${encodeURIComponent(id)}`;
  ui.shell(`${treasuryNav}<h1>Statement · ${e(p.from)} – ${e(p.to)}</h1><p>${e(accounts.find(a => a.id === p.accountId)?.name ?? '')} · ${e(p.status)}</p><div class="card"><p>Book balance ${currency(p.bookBalance)} · Outstanding register entries ${currency(p.outstanding)}</p><p>Unmatched difference ${currency(p.difference)} · Statement arithmetic difference ${currency(p.statementDifference)} · Unmatched statement lines ${p.unmatchedCount}</p><p>Opening ${currency(p.opening)} · Closing ${currency(p.closing)}</p></div>${p.lines.length ? table(['Date / bank ID', 'Description', 'Amount', 'Match'], p.lines.map(l => `<tr><td>${e(l.date)}<br>${e(l.id)}</td><td>${e(l.description)}</td><td>${currency(l.amount)}</td><td>${open ? `<select data-match="${e(l.id)}"><option value="">Unmatched</option>${register.filter(r => r.date <= p.to && r.amount === l.amount).map(r => `<option value="${e(r.id)}" ${r.id === l.registerId ? 'selected' : ''}>${e(r.date)} · ${e(r.memo)}</option>`).join('')}</select><button data-remove="${e(l.id)}">Remove line</button>` : e(l.registerId ?? '')}</td></tr>`).join('')) : '<p class="empty">No statement lines. Enter a line or preview a CSV below.</p>'}${open ? `<section class="card"><h2>Add statement line</h2><form id="line"><div class="form-grid">${input('id', 'Bank transaction ID')}${input('date', 'Date', 'date')}${input('description', 'Description')}${input('amount', 'Signed amount (cents)', 'number', 'step="1"')}</div><button>Add line</button></form></section><section class="card"><h2>Import statement CSV</h2><p>Headers: id,date,description,amountCents. Positive deposits, negative withdrawals. Preview first; fix errors and duplicate bank IDs before importing.</p><form id="csv"><label>CSV file<input name="file" type="file" accept=".csv,text/csv" required></label><button>Preview CSV</button></form><div id="preview"></div></section><form id="amend"><div class="form-grid">${input('closing', 'Correct closing balance (cents)', 'number', `step="1" value="${p.closing}"`)}</div><button>Save closing balance</button></form><form id="close"><button ${p.difference || p.statementDifference || p.unmatchedCount ? 'disabled' : ''}>Mark reconciled</button></form>` : ''}<h2>Register through period end</h2>${registerHtml(register.filter(r => r.date <= p.to))}`);
  bindForm('line', ui, async d => { await ui.api(`${endpoint}/lines`, 'POST', {version: p.version, line: {id: string(d, 'id'), date: string(d, 'date'), description: string(d, 'description'), amount: number(d, 'amount')}}); if (ui.current()) ui.refresh(); });
  bindForm('csv', ui, async d => {
    const csv = await (d.get('file') as File).text();
    const preview = await ui.api<StatementPreview & {previewToken: string}>(`${endpoint}/preview`, 'POST', {csv}); if (!ui.current()) return;
    document.querySelector('#preview')!.innerHTML = `${statementPreviewHtml(preview)}<form id="confirm-import"><button ${preview.errorCount || preview.duplicateCount || !preview.validCount ? 'disabled' : ''}>Confirm import</button></form>`;
    bindForm('confirm-import', ui, async () => { await ui.api(`${endpoint}/import`, 'POST', {csv, version: p.version, previewToken: preview.previewToken}); if (ui.current()) ui.refresh(); });
  });
  document.querySelectorAll<HTMLSelectElement>('[data-match]').forEach(select => select.addEventListener('change', async () => {
    select.disabled = true;
    try { await ui.api(`${endpoint}/match`, 'POST', {version: p.version, lineId: select.dataset.match, registerId: select.value || null}); if (ui.current()) ui.refresh(); }
    catch (error) { if (ui.current()) ui.flash(error); select.disabled = false; }
  }));
  bindForm('amend', ui, async d => { await ui.api(`${endpoint}/amend`, 'POST', {version: p.version, closing: number(d, 'closing')}); if (ui.current()) ui.refresh(); });
  document.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    try { await ui.api(`${endpoint}/remove`, 'POST', {version: p.version, lineId: button.dataset.remove}); if (ui.current()) ui.refresh(); }
    catch (error) { if (ui.current()) ui.flash(error); button.disabled = false; }
  }));
  bindForm('close', ui, async () => { await ui.api(`${endpoint}/close`, 'POST', {version: p.version}); if (ui.current()) ui.refresh(); });
}

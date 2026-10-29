import { showLoadError } from './load-error';
import type { DepartmentalStatement } from '@freedms/shared';
import { treasuryNav, treasuryRoute } from './treasury';
import { accountTypes, type AccountBalance, type Commissions, type DealPack, type GlAccount, type JournalView, type TrialBalance } from '@freedms/shared';
import { currency, escapeHtml as e } from './format';
import type { UI } from './desking';
const table = (headers: string[], body: string) => `<div class="table-wrap"><table><thead><tr>${headers.map(h => `<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
const packLink = (id: string, label: string) => `<a href="#/accounting/deals/${e(encodeURIComponent(id))}">${e(label)}</a>`;
export function balanceRows(rows: AccountBalance[]): string {
  return rows.map(r => `<tr><td>${e(r.code)} · ${e(r.name)}</td><td>${currency(r.debit)}</td><td>${currency(r.credit)}</td><td>${currency(r.balance)}</td></tr>`).join('');
}
export function trialHtml(data: TrialBalance): string {
  return table(['Account', 'Debit', 'Credit', 'Normal balance'], balanceRows(data.rows) + `<tr><th>Total · ${data.totals.balanced ? 'Balanced' : 'Unbalanced'}</th><td>${currency(data.totals.debit)}</td><td>${currency(data.totals.credit)}</td><td></td></tr>`);
}
export function accountRows(accounts: GlAccount[], balances: AccountBalance[]): string {
  return accounts.map(a => `<tr><td>${e(a.code)}</td><td>${e(a.name)}</td><td>${e(a.type)}</td><td>${a.active ? 'Active' : 'Inactive'}</td><td>${currency(balances.find(b => b.accountId === a.id)?.balance ?? 0)}</td><td><button data-edit="${e(a.id)}">Edit</button></td></tr>`).join('');
}
export function journalHtml(entries: JournalView[], allowReverse = true): string {
  if (!entries.length) return '<p class="empty">No journal entries match this selection.</p>';
  return entries.map(entry => `<article class="card"><h3>${e(entry.memo)}</h3><p>${e(entry.date)} · ${e(entry.source)}${entry.dealId ? ` · ${packLink(entry.dealId, 'Deal pack')}` : ''}${entry.repairOrderId ? ` · <a href="#/service/repair-orders/${e(encodeURIComponent(entry.repairOrderId))}">Repair order ${e(entry.repairOrderId)}</a>` : ''}${entry.partsSaleId ? ` · <a href="#/parts">Counter sale ${e(entry.partsSaleId)}</a>` : ''}${entry.reversed ? ' · Reversed' : ''}</p>${table(['Account', 'Debit', 'Credit', 'Explanation'], entry.lines.map(l => `<tr><td>${e(l.accountCode)} · ${e(l.accountName)}</td><td>${currency(l.debit)}</td><td>${currency(l.credit)}</td><td>${e(l.explanation)}</td></tr>`).join('') + `<tr><th>Total</th><td>${currency(entry.lines.reduce((s, l) => s + l.debit, 0))}</td><td>${currency(entry.lines.reduce((s, l) => s + l.credit, 0))}</td><td></td></tr>`)}${allowReverse && !entry.reversed && entry.source !== 'reversal' ? `<button data-reverse="${e(entry.id)}">Reverse</button>` : ''}</article>`).join('');
}
export function commissionsHtml(data: Commissions): string {
  return `<p>Commission: ${e((data.rateBps / 100).toFixed(2))}% of positive front gross. <a href="#/deals/settings">Workspace settings</a></p>${data.rows.length ? table(['Sold date', 'Buyer / deal', 'Vehicle', 'Front gross', 'Commission'], data.rows.map(r => `<tr><td>${e(r.soldDate)}</td><td>${packLink(r.dealId, r.buyer)}</td><td>${e(r.vehicle)}</td><td>${currency(r.frontGross)}</td><td>${currency(r.commission)}</td></tr>`).join('') + `<tr><th>Total</th><td></td><td></td><td>${currency(data.totals.frontGross)}</td><td>${currency(data.totals.commission)}</td></tr>`) : '<p class="empty">No sold deals in this period.</p>'}`;
}
export function packHtml(pack: DealPack): string {
  const labels: Record<Exclude<keyof DealPack['numbers'], 'lease'>, string> = {fiRetailTotal: 'F&I retail', fiCostTotal: 'F&I cost', fiGross: 'F&I gross', taxableBase: 'Taxable base', salesTax: 'Sales tax', netEquity: 'Trade net equity', balance: 'Balance owed', amountFinanced: 'Amount financed', payment: 'Monthly payment', totalPayments: 'Total payments', financeCharge: 'Finance charge', totalCost: 'Total cost', frontGross: 'Front gross', tradeOverallowance: 'Trade overallowance', cashDue: 'Cash due', creditDue: 'Customer credit due'};
  if (pack.numbers.lease) { labels.taxableBase = 'Monthly payment tax base (payment-based)'; labels.salesTax = 'Total lease tax'; labels.financeCharge = 'Total rent charge'; labels.cashDue = 'Drive-off'; }
  return `<a href="#/accounting">← Accounting</a><h1>Deal accounting pack</h1><p><a href="#/deals/${e(encodeURIComponent(pack.dealId))}">Deal worksheet</a> · Commission ${currency(pack.commission)}</p><h2>Working pencil numbers</h2>${table(['Number', 'Amount'], (Object.keys(labels) as (keyof typeof labels)[]).map(k => `<tr><th>${labels[k]}</th><td>${currency(pack.numbers[k])}</td></tr>`).join(''))}<h2>Posted entries and explanations</h2>${pack.entries.length ? journalHtml(pack.entries) : '<p class="empty">Nothing has posted for this deal.</p>'}`;
}
function bindReversals(ui: UI) {
  document.querySelectorAll<HTMLButtonElement>('[data-reverse]').forEach(button => button.addEventListener('click', async () => {
    if (!button.dataset.armed) { button.dataset.armed = 'yes'; button.textContent = 'Confirm reversal'; return; }
    button.disabled = true;
    try { await ui.api(`/accounting/journal/${encodeURIComponent(button.dataset.reverse!)}/reverse`, 'POST', {}); if (ui.current()) ui.refresh(); }
    catch (error) { if (ui.current()) ui.flash(error); button.disabled = false; }
  }));
}
let filters = {from: '', to: '', accountId: '', dealId: ''};
export async function accountingRoute(parts: string[], ui: UI): Promise<void> {
  try { await loadAccounting(parts, ui); }
  catch (error) { showLoadError(ui, error); }
}
async function loadAccounting(parts: string[], ui: UI): Promise<void> {
  if (['ap', 'ar', 'cash', 'reconciliations'].includes(parts[1])) return treasuryRoute(parts, ui);
  ui.shell('<p>Loading accounting…</p>');
  if (parts[1] === 'deals' && parts[2]) {
    const pack = await ui.api<DealPack>(`/accounting/deals/${encodeURIComponent(parts[2])}`); if (!ui.current()) return;
    ui.shell(packHtml(pack)); bindReversals(ui); return;
  }
  const period = new URLSearchParams(Object.entries(filters).filter(([key, value]) => ['from', 'to'].includes(key) && value));
  const journalQuery = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
  const [accounts, balances, trial, entries, commissions, allEntries, departmental] = await Promise.all([
    ui.api<GlAccount[]>('/accounting/accounts'), ui.api<AccountBalance[]>('/accounting/balances'), ui.api<TrialBalance>(`/accounting/trial-balance?${period}`),
    ui.api<JournalView[]>(`/accounting/journal?${journalQuery}`), ui.api<Commissions>(`/accounting/commissions?${period}`), ui.api<JournalView[]>('/accounting/journal'), ui.api<DepartmentalStatement>(`/accounting/departmental?${period}`),
  ]); if (!ui.current()) return;
  ui.shell(`${treasuryNav}<h1>Accounting</h1>${allEntries.length ? '' : '<p class="empty">No journal entries yet. Post a bill, receivable, or sold deal to begin.</p>'}<form id="accounting-filter" class="filters"><label>From<input name="from" type="date" value="${e(filters.from)}"></label><label>To<input name="to" type="date" value="${e(filters.to)}"></label><label>Journal account<select name="accountId"><option value="">All accounts</option>${accounts.map(a => `<option value="${e(a.id)}" ${filters.accountId === a.id ? 'selected' : ''}>${e(a.code)} · ${e(a.name)}</option>`).join('')}</select></label><label>Journal deal ID<input name="dealId" value="${e(filters.dealId)}"></label><button>Apply filters</button></form><h2>Trial balance for period</h2>${trialHtml(trial)}<h2>Departmental statements</h2>${departmentalHtml(departmental)}<h2>All-account balances · all dates</h2>${table(['Account', 'Debit', 'Credit', 'Normal balance'], balanceRows(balances))}<h2>Chart of accounts</h2>${table(['Code', 'Name', 'Type', 'Status', 'Balance', 'Edit'], accountRows(accounts, balances))}<section class="card"><h3 id="account-heading">Add account</h3><form id="account-form"><div class="form-grid"><label>Code<input name="code" required pattern="[0-9]{3,10}" maxlength="10"></label><label>Name<input name="name" required maxlength="120"></label><label>Type<select name="type">${accountTypes.map(t => `<option>${t}</option>`).join('')}</select></label><label><input name="active" type="checkbox" checked> Active</label></div><button>Save account</button><button type="button" id="account-cancel">Cancel edit</button></form></section><h2>Journal</h2>${journalHtml(entries)}<h2>Commissions for period</h2>${commissionsHtml(commissions)}`);
  document.querySelector<HTMLFormElement>('#accounting-filter')!.addEventListener('submit', event => {
    event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement);
    filters = {from: String(data.get('from')), to: String(data.get('to')), accountId: String(data.get('accountId')), dealId: String(data.get('dealId')).trim()}; ui.refresh();
  });
  let editing: GlAccount | undefined;
  const form = document.querySelector<HTMLFormElement>('#account-form')!;
  const control = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  document.querySelectorAll<HTMLButtonElement>('[data-edit]').forEach(button => button.addEventListener('click', () => {
    editing = accounts.find(a => a.id === button.dataset.edit)!;
    for (const key of ['code', 'name', 'type'] as const) control(key).value = editing[key];
    control('active').checked = editing.active; control('code').disabled = control('type').disabled = true;
    document.querySelector('#account-heading')!.textContent = 'Edit account'; control('name').focus();
  }));
  document.querySelector('#account-cancel')!.addEventListener('click', () => { editing = undefined; form.reset(); control('code').disabled = control('type').disabled = false; document.querySelector('#account-heading')!.textContent = 'Add account'; });
  form.addEventListener('submit', async event => {
    event.preventDefault(); const button = form.querySelector('button')!; button.disabled = true;
    try { await ui.api(`/accounting/accounts${editing ? `/${encodeURIComponent(editing.id)}` : ''}`, editing ? 'PUT' : 'POST', {name: control('name').value, active: control('active').checked, ...(editing ? {version: editing.version} : {code: control('code').value, type: control('type').value})}); if (ui.current()) ui.refresh(); }
    catch (error) { if (ui.current()) ui.flash(error); button.disabled = false; }
  });
  bindReversals(ui);
}

export function departmentalHtml(data: DepartmentalStatement): string {
  if (!data.departments.some(d => d.rows.length)) return '<p class="empty">No income or expense entries in this period.</p>';
  return data.departments.map(d => `<section class="card"><h3>${e(d.department[0].toUpperCase()+d.department.slice(1))}</h3><p>Income ${currency(d.income)} · Expenses ${currency(d.expenses)} · Gross profit ${currency(d.grossProfit)}</p>${table(['Account','Debit','Credit','Normal balance'],balanceRows(d.rows))}</section>`).join('') + `<p><strong>Total income ${currency(data.totals.income)} · Total expenses ${currency(data.totals.expenses)} · Total gross profit ${currency(data.totals.grossProfit)}</strong></p>`;
}

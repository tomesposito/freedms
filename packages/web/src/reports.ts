import type { InventoryReport, LeadReport, SalesReport } from '@freedms/shared';
import { currency, escapeHtml as e } from './format';
import type { UI } from './desking';
const table = (headers: string[], rows: (string | number)[][]) => `<div class="table-wrap"><table><thead><tr>${headers.map(h => `<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${e(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const exportButton = (name: string, label = 'Export CSV') => `<button type="button" data-export="${e(name)}">${e(label)}</button>`;
let from = '', to = '';
export async function reportsRoute(ui: UI & {download: (path: string, filename: string) => Promise<void>}): Promise<void> {
  ui.shell('<p>Loading reports…</p>');
  const params = new URLSearchParams(); if (from) params.set('from', from); if (to) params.set('to', to);
  const query = params.size ? `?${params}` : '';
  // Keep the controls usable even when a range is rejected by the API.
  const controls = `<h1>Reports</h1><form id="report-range" class="filters"><label>From<input type="date" name="from" value="${e(from)}"></label><label>To<input type="date" name="to" value="${e(to)}"></label><button>Apply</button><button type="button" id="clear-range">Clear</button></form>`;
  const bindRange = () => {
    document.querySelector<HTMLFormElement>('#report-range')!.addEventListener('submit', event => { event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement); from = String(data.get('from') || ''); to = String(data.get('to') || ''); ui.refresh(); });
    document.querySelector('#clear-range')!.addEventListener('click', () => { from = ''; to = ''; ui.refresh(); });
  };
  try {
    const [inventory, sales, leads] = await Promise.all([ui.api<InventoryReport>('/reports/inventory'), ui.api<SalesReport>(`/reports/sales${query}`), ui.api<LeadReport>('/reports/leads')]);
    if (!ui.current()) return;
    ui.shell(`${controls}<p class="muted">Sales and accounting range (inclusive, UTC): ${e(sales.from ?? 'Beginning')} to ${e(sales.to ?? 'present')} ${!sales.from && !sales.to ? '· All time' : ''}</p>
      <section class="card"><div class="heading"><h2>Inventory</h2>${exportButton('inventory')}</div>
      ${table(['Age bucket', 'Vehicles', 'Total cost'], inventory.buckets.map(b => [b.bucket, b.count, currency(b.totalCost)]))}
      <p class="total">${e(inventory.totals.count)} vehicles · Total inventory cost ${currency(inventory.totals.totalCost)} · Total list price ${currency(inventory.totals.totalListPrice)}</p>
      ${inventory.rows.length ? table(['Stock', 'Vehicle', 'Status', 'Date stocked', 'Age (days)', 'Bucket', 'List price', 'Cost', 'Recon', 'Total cost'], inventory.rows.map(r => [r.stockNumber, r.vehicle, r.status, r.dateStocked, r.agingDays, r.bucket, ...[r.listPrice, r.cost, r.reconTotal, r.totalCost].map(currency)])) : '<p class="empty">No vehicles in inventory yet.</p>'}</section>
      <section class="card"><div class="heading"><h2>Sales</h2>${exportButton('sales')}</div><div class="metrics report-metrics">${[['Deals sold', String(sales.totals.dealsSold)], ['Total front gross', currency(sales.totals.totalFrontGross)], ['Total F&I gross', currency(sales.totals.totalFiGross)], ['Average gross', currency(sales.totals.averageGross)]].map(([label, value]) => `<div><span>${e(label)}</span><strong>${e(value)}</strong></div>`).join('')}</div>
      ${sales.rows.length ? table(['Sold date (UTC)', 'Deal', 'Buyer', 'Vehicle', 'Selling price', 'Front gross', 'F&I gross'], sales.rows.map(r => [r.soldDate, r.dealId, r.buyer, r.vehicle, currency(r.price), currency(r.frontGross), currency(r.fiGross)])) : '<p class="empty">No deals sold in this range.</p>'}</section>
      <section class="card"><div class="heading"><div><h2>Lead pipeline</h2><p>Current snapshot · ${e(leads.total)} total leads · Not date-filtered</p></div>${exportButton('leads')}</div>${!leads.total ? '<p>No leads yet.</p>' : ''}<div class="detail-grid">${table(['Stage', 'Count'], leads.byStage.map(r => [r.stage, r.count]))}${table(['Source', 'Count'], leads.bySource.map(r => [r.source, r.count]))}</div></section>
      <section class="card"><h2>Accounting export</h2><p>This CSV is the QuickBooks bridge until the full general ledger lands.</p>${exportButton('accounting', 'Download accounting CSV')}</section>`);
    bindRange();
    document.querySelectorAll<HTMLButtonElement>('[data-export]').forEach(button => button.addEventListener('click', async () => {
      const name = button.dataset.export!; button.disabled = true;
      try { await ui.download(`/reports/${name}.csv${['sales', 'accounting'].includes(name) ? query : ''}`, `${name === 'leads' ? 'lead-pipeline' : name}.csv`); }
      catch (error) { if (ui.current()) ui.flash(error); }
      finally { button.disabled = false; }
    }));
  } catch (error) { if (ui.current()) { ui.shell(controls); bindRange(); ui.flash(error); } }
}

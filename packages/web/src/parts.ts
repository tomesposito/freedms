import { showLoadError } from './load-error';
import { reservationsHtml, depthHtml, bindDepth, bindProposal } from './parts-depth';
import type { PartsReservation, Part, PartsSale, Customer, JournalView, PartsPurchaseOrder, PartsReturn, PricingMatrix, RepairOrder } from '@freedms/shared';
import { escapeHtml as e, currency, cents } from './format';
import type { UI } from './desking';
export function partsTableHtml(rows: Part[]): string {
  if (!rows.length) return '<p class="empty">No parts stocked yet (or no matching parts).</p>';
  return `<div class="table-wrap"><table><thead><tr><th>Part number</th><th>Description</th><th>Bin</th><th>Location</th><th>Cost</th><th>Retail</th><th>On hand</th><th>Reserved</th><th>Reorder point</th><th>Stock</th></tr></thead><tbody>${rows.map(p=>`<tr><td><a href="#/parts/${encodeURIComponent(p.id)}">${e(p.partNumber)}</a></td><td>${e(p.description)}</td><td>${e(p.binLocation)}</td><td>${e(p.location ?? '')}</td><td>${currency(p.costCents)}</td><td>${currency(p.retailPriceCents)}</td><td>${p.quantityOnHand}</td><td>${p.quantityReserved ?? 0}</td><td>${p.reorderPoint}</td><td>${p.quantityOnHand<=p.reorderPoint ? '<strong>Reorder</strong>' : 'In stock'}</td></tr>`).join('')}</tbody></table></div>`;
}
export function salesHtml(rows: PartsSale[], journal: JournalView[] = []): string {
  const postings = new Map(journal.filter(e => e.source === 'parts-posting').map(e => [e.partsSaleId, e]));
  return rows.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Part</th><th>Customer</th><th>Quantity</th><th>Unit price</th><th>Total</th><th>Journal</th></tr></thead><tbody>${rows.map(s=>`<tr><td>${e(s.createdAt.slice(0,10))}</td><td>${e(s.partNumber)} · ${e(s.description)}${s.stockWarning ? `<p role="alert">${e(s.stockWarning)}</p>` : ''}</td><td>${e(s.customerName ?? 'Walk-in')}</td><td>${s.quantity}</td><td>${currency(s.unitPriceCents)}</td><td>${currency(s.totalCents)}</td><td>${postings.has(s.id) ? `<a href="#/accounting">${postings.get(s.id)!.reversed ? 'Reversed' : 'Posted'}</a>` : 'Not posted'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No counter sales yet.</p>';
}
const field=(label:string,name:string,value:unknown,attrs='')=>`<label>${label}<input name="${name}" value="${e(value)}" ${attrs}></label>`;
export async function partsRoute(route: string[], ui: UI): Promise<void> {
  try { await loadParts(route, ui); }
  catch (error) { showLoadError(ui, error); }
}
async function loadParts(route: string[], ui: UI): Promise<void> {
  if (route[1]) {
    const part=route[1]==='new' ? undefined : await ui.api<Part>(`/parts/${encodeURIComponent(route[1])}`);
    if(!ui.current()) return;
    ui.shell(`<a href="#/parts">← Parts</a><h1>${part ? 'Edit' : 'Add'} part</h1><form id="part-form" class="card"><div class="form-grid">${field('Part number','partNumber',part?.partNumber ?? '','required maxlength="100"')}${field('Description','description',part?.description ?? '','required maxlength="200"')}${field('Bin location','binLocation',part?.binLocation ?? '','maxlength="100"')}${field('Location','location',part?.location ?? '','maxlength="100"')}${field('Cost (USD)','cost',((part?.costCents ?? 0)/100).toFixed(2),'type="number" min="0" step="0.01" required')}${field('Retail (USD)','retail',((part?.retailPriceCents ?? 0)/100).toFixed(2),'type="number" min="0" step="0.01" required')}${field('Quantity on hand','quantityOnHand',part?.quantityOnHand ?? 0,'type="number" min="0" step="1" required')}${field('Reorder point','reorderPoint',part?.reorderPoint ?? 0,'type="number" min="0" step="1" required')}</div><p>Reserved: ${part?.quantityReserved ?? 0}</p><div id="pricing-proposal" aria-live="polite"></div><button>Save part</button></form>`);
    bindProposal(ui);
    let saving=false;
    document.querySelector<HTMLFormElement>('#part-form')!.onsubmit=async event=>{
      event.preventDefault(); if(saving) return; saving=true;
      try { const d=new FormData(event.currentTarget as HTMLFormElement); const body={partNumber:d.get('partNumber'),description:d.get('description'),binLocation:d.get('binLocation'),location:d.get('location'),costCents:cents(String(d.get('cost'))),retailPriceCents:cents(String(d.get('retail'))),quantityOnHand:Number(d.get('quantityOnHand')),reorderPoint:Number(d.get('reorderPoint')),...(part ? {version:part.version} : {})};
        await ui.api(part ? `/parts/${encodeURIComponent(part.id)}` : '/parts',part ? 'PUT':'POST',body); if(ui.current()) location.hash='#/parts';
      } catch(error) { if(ui.current()) ui.flash(error); } finally {saving=false;}
    }; return;
  }
  const [parts,reorder,sales,customers,journal,pos,returns,matrix,repairOrders,reservations]=await Promise.all([ui.api<Part[]>('/parts'),ui.api<Part[]>('/parts?reorder=true'),ui.api<PartsSale[]>('/parts/sales'),ui.api<Customer[]>('/customers'),ui.api<JournalView[]>('/accounting/journal'),ui.api<PartsPurchaseOrder[]>('/parts/purchase-orders'),ui.api<PartsReturn[]>('/parts/returns'),ui.api<PricingMatrix>('/parts/pricing-matrix'),ui.api<RepairOrder[]>('/service/repair-orders'),ui.api<PartsReservation[]>('/parts/reservations')]);
  if(!ui.current()) return;
  ui.shell(`<h1>Parts</h1><p><a class="button" href="#/parts/new">Add part</a></p><section class="card"><h2>Catalog</h2><label>Search part number, description, bin or location<input id="parts-search" type="search"></label><label>Location<select id="parts-location"><option value="*">All locations</option>${[...new Set(parts.map(p=>p.location ?? ''))].sort().map(l=>`<option value="${e(l)}">${e(l || 'Unspecified')}</option>`).join('')}</select></label><div id="parts-table">${partsTableHtml(parts)}</div></section>${reservationsHtml(reservations,parts,customers,repairOrders)}<section class="card"><h2>Reorder list</h2>${reorder.length ? partsTableHtml(reorder)+reorder.map(p=>`<button type="button" data-order="${e(p.id)}">Order ${e(p.partNumber)}</button>`).join('') : '<p class="empty">No parts need reordering.</p>'}</section><section class="card"><h2>Counter sale</h2>${parts.length ? `<form id="sale-form"><div class="form-grid"><label>Part<select name="partId" required>${parts.map(p=>`<option value="${e(p.id)}">${e(p.partNumber)} · ${e(p.description)} (${p.quantityOnHand} on hand, ${p.quantityReserved ?? 0} reserved)</option>`).join('')}</select></label>${field('Quantity','quantity',1,'type="number" min="1" step="1" required')}${field('Unit price (USD)','price',(parts[0].retailPriceCents/100).toFixed(2),'type="number" min="0" step="0.01" required')}<label>Customer<select name="customerId"><option value="">Walk-in</option>${customers.map(c=>`<option value="${e(c.id)}">${e(c.name)}</option>`).join('')}</select></label></div><label class="stock-override"><input type="checkbox" name="allowNegativeStock"> Explicitly allow negative stock</label><button>Record sale</button></form>` : '<p>Stock a part before recording a sale.</p>'}</section><section class="card"><h2>Recent sales</h2>${salesHtml(sales.slice(0,20),journal)}</section>${depthHtml(parts,customers,repairOrders,pos,returns,matrix)}`);
  bindDepth(ui,parts,customers,repairOrders,pos,matrix,reservations);
  const filter=()=>{const query=document.querySelector<HTMLInputElement>('#parts-search')!.value.toLowerCase(),location=document.querySelector<HTMLSelectElement>('#parts-location')!.value;document.querySelector('#parts-table')!.innerHTML=partsTableHtml(parts.filter(p=>(location==='*'||(p.location ?? '')===location)&&[p.partNumber,p.description,p.binLocation,p.location ?? ''].some(v=>v.toLowerCase().includes(query))));};
  document.querySelector<HTMLInputElement>('#parts-search')!.oninput=filter;
  document.querySelector<HTMLSelectElement>('#parts-location')!.onchange=filter;
  const form=document.querySelector<HTMLFormElement>('#sale-form'); if(!form) return;
  form.querySelector<HTMLSelectElement>('[name="partId"]')!.onchange=event=>{ const p=parts.find(p=>p.id===(event.target as HTMLSelectElement).value)!; form.querySelector<HTMLInputElement>('[name="price"]')!.value=(p.retailPriceCents/100).toFixed(2); };
  let saving=false;
  form.onsubmit=async event=>{event.preventDefault(); if(saving) return; saving=true; try {const d=new FormData(form); await ui.api('/parts/sales','POST',{partId:d.get('partId'),quantity:Number(d.get('quantity')),unitPriceCents:cents(String(d.get('price'))),customerId:d.get('customerId')||null,...(d.has('allowNegativeStock') ? {allowNegativeStock:true} : {})}); if(ui.current()) ui.refresh();} catch(error) {if(ui.current()) ui.flash(error);} finally {saving=false;}};
}

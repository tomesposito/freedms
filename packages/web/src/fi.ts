import { fiCategories, fiCategoryLabels, type FiProduct, type FiSelection } from '@freedms/shared';
import { cents, currency, escapeHtml as e } from './format';
import type { UI } from './desking';
export function catalogRows(products: FiProduct[]): string {
  return products.map(p => `<tr><td>${e(p.name)}</td><td>${e(fiCategoryLabels[p.category])}</td><td>${currency(p.cost)}</td><td>${currency(p.retailPrice)}</td><td>${currency(p.retailPrice - p.cost)}</td><td>${e(p.termNotes)}</td><td>${p.active ? 'Active' : 'Inactive'}</td><td><button data-edit="${e(p.id)}">Edit</button></td></tr>`).join('');
}
export function menuHtml(products: FiProduct[], selections: FiSelection[]): string {
  const items = [...selections, ...products.filter(p => p.active && !selections.some(s => s.productId === p.id)).map(p => ({...p, productId: p.id, status: 'undecided'}))];
  if (!items.length) return '<p>No active F&I products to present. <a href="#/fi-products">Add or activate a product</a> to build a menu.</p>';
  return items.map(s => `<div class="card"><strong>${e(s.name)}</strong> · ${e(fiCategoryLabels[s.category])} · ${currency(s.retailPrice)}<p>${e(s.termNotes)}</p><p>${e(s.status)}${products.some(p => p.id === s.productId && !p.active) ? ' · Inactive catalog product' : ''}${s.status === 'accepted' ? ` · F&I gross ${currency(s.retailPrice - s.cost)}` : ''}</p>${['accepted', 'declined', 'undecided'].map(status => `<button type="button" data-product="${e(s.productId)}" data-status="${status}" ${s.status === status ? 'disabled' : ''}>${status === 'accepted' ? 'Accept' : status === 'declined' ? 'Decline' : 'Undecided'}</button>`).join(' ')}</div>`).join('');
}
export async function fiRoute(ui: UI) {
  ui.shell('<p>Loading F&I products…</p>');
  const products = await ui.api<FiProduct[]>('/fi-products'); if (!ui.current()) return;
  let editing: FiProduct | undefined;
  ui.shell(`<h1>F&I products</h1><p>Products your store offers on the deal menu. Native menu tooling only; no lender or signature connection exists.</p>${products.length ? `<div class="table-wrap"><table><thead><tr>${['Name', 'Category', 'Cost', 'Retail price', 'Gross', 'Term/coverage notes', 'Status', 'Edit'].map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${catalogRows(products)}</tbody></table></div>` : '<p class="empty">No F&I products yet — add one.</p>'}<section class="card"><h2 id="fi-heading">Add product</h2><form id="fi-form"><div class="form-grid"><label>Name<input name="name" required maxlength="120"></label><label>Category<select name="category">${fiCategories.map(c => `<option value="${c}">${e(fiCategoryLabels[c])}</option>`).join('')}</select></label><label>Cost (USD)<input name="cost" type="number" min="0" max="100000000" step="0.01" required></label><label>Retail price (USD)<input name="retailPrice" type="number" min="0" max="100000000" step="0.01" required></label><label>Term/coverage notes<textarea name="termNotes" maxlength="500"></textarea></label><label><input name="active" type="checkbox" checked> Active</label></div><button class="primary">Save product</button><button type="button" id="fi-cancel">Cancel edit</button></form></section>`);
  const form = document.querySelector<HTMLFormElement>('#fi-form')!;
  const control = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  document.querySelectorAll<HTMLButtonElement>('[data-edit]').forEach(button => button.addEventListener('click', () => {
    editing = products.find(p => p.id === button.dataset.edit)!;
    for (const key of ['name', 'category', 'cost', 'retailPrice', 'termNotes'] as const) control(key).value = key === 'cost' || key === 'retailPrice' ? (editing[key] / 100).toFixed(2) : editing[key];
    control('active').checked = editing.active; document.querySelector('#fi-heading')!.textContent = 'Edit product'; control('name').focus();
  }));
  document.querySelector('#fi-cancel')!.addEventListener('click', () => { editing = undefined; form.reset(); document.querySelector('#fi-heading')!.textContent = 'Add product'; });
  form.addEventListener('submit', async event => {
    event.preventDefault(); const button = form.querySelector('button')!; button.disabled = true;
    try {
      await ui.api(`/fi-products${editing ? `/${encodeURIComponent(editing.id)}` : ''}`, editing ? 'PUT' : 'POST', {name: control('name').value, category: control('category').value, cost: cents(control('cost').value), retailPrice: cents(control('retailPrice').value), termNotes: control('termNotes').value, active: control('active').checked, ...(editing ? {version: editing.version} : {})});
      if (ui.current()) ui.refresh();
    } catch (error) { if (ui.current()) { await fiRoute(ui); ui.flash(error); } } finally { button.disabled = false; }
  });
}

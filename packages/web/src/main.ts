import { brandIconUrl, brandLogoUrl, brandReversedLogoUrl } from './brand';
import { legalPageHtml } from './legal';
import { mountOnboarding } from './onboarding';
import { inviteLandingHtml, invitedEmailMatches, inviteSignInHtml, welcomeHtml, welcomeDismissed, dismissWelcome, type InviteView } from './invites';
import { publicApi } from './retail';
import type { Invite } from '@freedms/shared';
import { icon, sidebarUserHtml, sidebarToggleIcon, sidebarNavigation, readSidebarPreference, writeSidebarPreference } from './sidebar';
import { partsRoute } from './parts';
import { serviceRoute, serviceHistoryHtml } from './service';
import type { RepairOrderView } from '@freedms/shared';
import { complianceRoute, dealComplianceRoute } from './compliance';
import { buyerRoute } from './retail';
import { usersRoute } from './users';
import { creditRoute } from './credit';
import { accountingRoute } from './accounting';
import { documentsRoute } from './documents';
import { accountRoute } from './mfa';
import { webhooksRoute } from './webhooks';
import { fiRoute } from './fi';
import { feedRoute } from './feed';
import { importRoute } from './import';
import { bindDraftOutcome, quickEntryCard, bindQuickEntry, takeVehicleDraft, fillDraft, reviewNote, clearDrafts } from './quick-entry';
import { reportsRoute } from './reports';
import { jacketRoute } from './jacket';
import { dealsRoute } from './desking';
import { crmRoute } from './crm';
import { vehicleStatuses, type ApiEnvelope, type DecodedVin, type Session, type VehicleInput, type VehicleView } from '@freedms/shared';
import { cents, currency, escapeHtml as e } from './format';
import { finishSignIn, getToken, localMode, setToken, signIn, signOut } from './auth';
import './style.css';
const app = document.querySelector<HTMLDivElement>('#app')!;
const base = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');
let session: Session;
let search = ''; let status = ''; let offset = 0; let routeSequence = 0;
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  return (await apiEnvelope<T>(path, method, body)).data;
}
async function apiEnvelope<T>(path: string, method = 'GET', body?: unknown): Promise<Extract<ApiEnvelope<T>, {data: T}>> {
  const response = await fetch(`${base}${path}`, {method, headers: {'content-type': 'application/json', ...(getToken() ? {authorization: `Bearer ${getToken()}`} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  const result = await response.json() as ApiEnvelope<T>;
  if ('error' in result) {
    if (response.status === 401 && result.error.code !== 'MFA_INVALID') sessionStorage.removeItem('freedms-token');
    throw Object.assign(new Error(result.error.message), {status: response.status});
  }
  if (!response.ok) throw new Error('The request could not be completed.');
  return result;
}
async function download(path: string, filename: string): Promise<void> {
  const token = getToken();
  const result = await fetch(`${base}${path}`, {headers: token ? {authorization: `Bearer ${token}`} : {}});
  if (!result.ok) {
    const body = await result.json() as {error?: {message: string}};
    throw new Error(body.error?.message || 'The download could not be completed.');
  }
  const url = URL.createObjectURL(await result.blob());
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'Something went wrong. Please retry.'; }
function flash(error: unknown): void { const el = document.querySelector<HTMLElement>('#message')!; el.textContent = errorMessage(error); el.hidden = false; el.focus(); }
function shell(content: string): void {
  const section = location.hash.replace(/^#\//, '').split('/')[0];
  const active = ['', 'new', 'import', 'vehicles'].includes(section) ? '' : section;
  const slim = readSidebarPreference();
  app.innerHTML = `<aside class="sidebar${slim ? ' is-slim' : ''}">
    <div class="sidebar-heading"><a class="brand" href="#/" aria-label="freeDMS" title="freeDMS"><img class="brand-mark" src="${brandIconUrl}" alt="freeDMS"><img class="brand-name" src="${brandReversedLogoUrl}" alt="freeDMS"></a><button type="button" class="menu-toggle" aria-expanded="false" aria-controls="nav-panel">Menu</button></div>
    <div id="nav-panel" class="nav-panel">
      <div class="workspace">${e(session?.tenant?.name || 'Your dealership')}</div>
      <nav aria-label="Main navigation">
        ${sidebarNavigation(session?.principal.role === 'admin')}
      </nav>
      <div class="sidebar-footer">${sidebarUserHtml(session?.user)}${localMode ? '<span class="local-label">Local workspace</span>' : ''}<button type="button" id="sidebar-toggle" class="quiet" aria-expanded="${!slim}" aria-label="${slim ? 'Expand sidebar' : 'Collapse sidebar'}" title="${slim ? 'Expand sidebar' : 'Collapse sidebar'}">${sidebarToggleIcon(slim)}</button><button id="signout" class="quiet" title="Sign out" aria-label="Sign out">${icon('<path d="M9 3H3v18h6m6-14 5 5-5 5m-7-5h12"/>')}<span class="nav-text">Sign out</span></button></div>
    </div>
  </aside><main class="app-main"><div id="message" class="error" role="alert" tabindex="-1" hidden></div>${content}</main>`;
  app.querySelectorAll<HTMLAnchorElement>('.sidebar nav a').forEach(anchor => {
    if (anchor.getAttribute('href') === `#/${active}`) anchor.setAttribute('aria-current', 'page');
  });
  const sidebar = app.querySelector<HTMLElement>('.sidebar')!;
  const slimToggle = app.querySelector<HTMLButtonElement>('#sidebar-toggle')!;
  slimToggle.addEventListener('click', () => {
    const slim = sidebar.classList.toggle('is-slim');
    writeSidebarPreference(slim);
    slimToggle.setAttribute('aria-expanded', String(!slim));
    slimToggle.innerHTML = sidebarToggleIcon(slim);
    const label = slim ? 'Expand sidebar' : 'Collapse sidebar';
    slimToggle.setAttribute('aria-label', label);
    slimToggle.title = label;
  });
  const toggle = app.querySelector<HTMLButtonElement>('.menu-toggle')!;
  const setMenu = (open: boolean) => {
    sidebar.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => setMenu(toggle.getAttribute('aria-expanded') !== 'true'));
  sidebar.querySelectorAll('a').forEach(anchor => anchor.addEventListener('click', () => setMenu(false)));
  sidebar.addEventListener('keydown', event => {
    if (event.key === 'Escape') { setMenu(false); toggle.focus(); }
  });
  document.querySelector('#signout')?.addEventListener('click', () => { clearDrafts(); signOut(); });
}
function badge(value: string): string { return `<span class="badge ${value.replace(' ', '-')}">${e(value)}</span>`; }
async function login(): Promise<void> {
  app.innerHTML = `<main class="login"><a class="brand" href="#/"><img src="${brandLogoUrl}" alt="freeDMS"></a><h1>Your inventory, in one place.</h1><p>${localMode ? 'Create an empty local workspace to start stocking vehicles. This development session lasts one hour; data is cleared when the API restarts.' : 'Invite-only pilot. Sign in with the account provided by your pilot operator.'}</p><div id="message" class="error" role="alert" tabindex="-1" hidden></div>${localMode ? '<section id="onboarding"></section><h2>Join an existing local workspace</h2><form id="join"><label>Workspace ID<input name="tenantId" required maxlength="128"></label><label>Email<input name="email" type="email" required maxlength="254"></label><label>Authenticator or recovery code (if MFA enabled)<input name="code" autocomplete="one-time-code" maxlength="32"></label><button>Sign in locally</button></form>' : '<button id="cognito" class="primary">Sign in</button>'}</main>`;
  if (localMode) mountOnboarding(document.querySelector<HTMLElement>('#onboarding')!, async data => {
    const result = await api<{token: string; invites: Invite[]}>('/local/session', 'POST', data);
    setToken(result.token);
    document.querySelector('#join')?.remove();
    document.querySelector('.login > h2')?.remove();
    return result;
  }, () => { void start(); });
  const joinParams = new URLSearchParams(location.hash.split('?')[1]);
  for (const field of ['tenantId', 'email']) { const input = document.querySelector<HTMLInputElement>(`#join [name=${field}]`); if (input) input.value = joinParams.get(field) ?? ''; }
  document.querySelector('#cognito')?.addEventListener('click', () => { void signIn().catch(flash); });
  document.querySelectorAll<HTMLFormElement>('#join').forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget as HTMLFormElement; const button = form.querySelector('button')!; button.disabled = true;
    try { const data = Object.fromEntries(new FormData(form)); const result = await api<{token: string}>('/local/session', 'POST', data); setToken(result.token); history.replaceState(null, '', '#/'); await start(); }
    catch (error) { flash(error); button.disabled = false; }
  }));
}
async function list(sequence: number): Promise<void> {
  shell(`<div class="heading"><div><p class="eyebrow">YOUR LOT</p><h1>Inventory</h1><p class="muted">Stock, price, and track every vehicle.</p></div><div class="form-actions"><a class="button" href="#/import">Import CSV</a><a class="button primary" href="#/new">+ Add vehicle</a></div></div>${quickEntryCard}<form id="filters" class="filters"><label class="search">Search inventory<input name="search" type="search" maxlength="200" placeholder="Stock number, VIN, make, model, location" value="${e(search)}"></label><label>Status<select name="status"><option value="">All statuses</option>${vehicleStatuses.map(s => `<option ${s === status ? 'selected' : ''}>${s}</option>`).join('')}</select></label><button>Search</button></form><section id="results" aria-live="polite"><p class="muted">Loading inventory…</p></section>`);
  void bindQuickEntry('vehicle', api, () => sequence === routeSequence);
  document.querySelector<HTMLFormElement>('#filters')!.addEventListener('submit', event => { event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement); search = String(data.get('search') || '').trim(); status = String(data.get('status') || ''); offset = 0; void route(); });
  document.querySelector<HTMLSelectElement>('[name=status]')!.addEventListener('change', () => document.querySelector<HTMLFormElement>('#filters')!.requestSubmit());
  const params = new URLSearchParams(); if (search) params.set('search', search); if (status) params.set('status', status);
  params.set('limit', '100'); params.set('offset', String(offset));
  const {data: vehicles, total = 0} = await apiEnvelope<VehicleView[]>(`/vehicles?${params}`); if (sequence !== routeSequence) return;
  if (total && offset >= total) { offset = Math.floor((total - 1) / 100) * 100; await route(); return; }
  const results = document.querySelector('#results')!;
  if (!total) {
    results.innerHTML = `<div class="empty"><div class="empty-icon" aria-hidden="true">◇</div><h2>${search || status ? 'No matching vehicles' : 'Your lot starts here'}</h2><p>${search || status ? 'Try a different search or status filter.' : 'Add your first vehicle to track pricing, reconditioning, and time on the lot.'}</p>${search || status ? '<button id="clear">Clear filters</button>' : '<a class="button primary" href="#/new">Add your first vehicle</a>'}</div>`;
    document.querySelector('#clear')?.addEventListener('click', () => { search = ''; status = ''; offset = 0; void route(); }); return;
  }
  results.innerHTML = `<p class="muted count">Showing ${vehicles.length ? offset + 1 : 0}–${offset + vehicles.length} of ${total} vehicles</p><div class="table-wrap"><table><thead><tr><th>Vehicle / stock</th><th>Status</th><th>Mileage</th><th>List price</th><th>Recon</th><th>Age</th><th>Location</th></tr></thead><tbody>${vehicles.map(v => `<tr><td><a class="vehicle-link" href="#/vehicles/${v.id}">${e(`${v.year} ${v.make} ${v.model}`)}</a><small>${e(v.stockNumber)} · ${e(v.trim)}</small></td><td>${badge(v.status)}</td><td>${v.mileage == null ? '—' : v.mileage.toLocaleString('en-US')}</td><td>${currency(v.listPrice)}</td><td>${currency(v.reconTotal)}</td><td>${v.agingDays} days</td><td>${e(v.location) || '—'}</td></tr>`).join('')}</tbody></table></div><div class="form-actions"><button id="prev" ${offset === 0 ? 'disabled' : ''}>Prev</button><button id="next" ${offset + vehicles.length >= total ? 'disabled' : ''}>Next</button></div>`;
  document.querySelector('#prev')!.addEventListener('click', () => { offset = Math.max(0, offset - 100); void route(); });
  document.querySelector('#next')!.addEventListener('click', () => { offset += 100; void route(); });
}
async function detail(id: string, sequence: number): Promise<void> {
  shell('<p>Loading vehicle…</p>'); const v = await api<VehicleView>(`/vehicles/${encodeURIComponent(id)}`); if (sequence !== routeSequence) return;
  const serviceHistory = await api<RepairOrderView[]>(`/service/repair-orders?vehicleId=${encodeURIComponent(id)}`); if (sequence !== routeSequence) return;
  shell(`<a class="back" href="#/">← Inventory</a><div class="heading"><div><p class="eyebrow">STOCK ${e(v.stockNumber)}</p><h1>${e(`${v.year} ${v.make} ${v.model}`)}</h1><p class="muted">${e(v.trim)} · <span class="mono">${e(v.vin)}</span></p></div><div class="form-actions">${v.status !== 'sold' ? `<a class="button primary" href="#/deals/new/vehicle/${v.id}">Start deal</a>` : ''}<a class="button" href="#/vehicles/${v.id}/edit">Edit vehicle</a></div></div><div class="metrics"><div><span>Status</span>${badge(v.status)}</div><div><span>List price</span><strong>${currency(v.listPrice)}</strong></div><div><span>Acquisition cost</span><strong>${currency(v.cost)}</strong></div><div><span>Time on lot</span><strong>${v.agingDays} days</strong></div></div><div class="detail-grid"><section class="card"><h2>Vehicle details</h2><dl><dt>Mileage</dt><dd>${v.mileage == null ? 'Not set' : v.mileage.toLocaleString('en-US')}</dd><dt>Date stocked</dt><dd>${e(v.dateStocked)}</dd><dt>Location</dt><dd>${e(v.location) || 'Not set'}</dd><dt>Notes</dt><dd class="notes">${e(v.notes) || 'No notes added.'}</dd></dl></section><section class="card"><h2>Reconditioning</h2>${v.reconCosts.length ? `<ul class="recon-summary">${v.reconCosts.map(item => `<li><span>${e(item.description)}</span><strong>${currency(item.amount)}</strong></li>`).join('')}</ul>` : '<p class="muted">No recon costs added.</p>'}<div class="total"><span>Recon total</span><strong>${currency(v.reconTotal)}</strong></div><div class="total"><span>Cost + recon</span><strong>${currency(v.cost + v.reconTotal)}</strong></div></section></div><section class="card"><h2>Service history</h2>${serviceHistoryHtml(serviceHistory)}</section>${session.principal.role === 'admin' ? '<div class="danger-zone"><button id="delete" class="danger">Delete vehicle</button><p class="muted">Removes the vehicle from inventory. The audit event is retained.</p></div>' : ''}`);
  document.querySelector<HTMLButtonElement>('#delete')?.addEventListener('click', async event => {
    if (!confirm(`Delete stock ${v.stockNumber}? This cannot be undone.`)) return;
    const button = event.currentTarget as HTMLButtonElement; button.disabled = true;
    try { await api(`/vehicles/${v.id}`, 'DELETE', {version: v.version}); location.hash = '#/'; }
    catch (error) { flash(error); button.disabled = false; }
  });
}
function field(label: string, name: string, value: unknown, attributes = ''): string {
  return `<label>${label}<input name="${name}" value="${e(value)}" ${attributes}></label>`;
}
async function form(id: string | undefined, sequence: number): Promise<void> {
  const draft = id ? undefined : takeVehicleDraft();
  let v: VehicleView | undefined;
  if (id) { shell('<p>Loading vehicle…</p>'); v = await api<VehicleView>(`/vehicles/${encodeURIComponent(id)}`); if (sequence !== routeSequence) return; }
  shell(`<a class="back" href="${v ? `#/vehicles/${v.id}` : '#/'}">← ${v ? 'Vehicle details' : 'Inventory'}</a><div class="heading"><div><p class="eyebrow">INVENTORY</p><h1>${v ? 'Edit vehicle' : 'Add vehicle'}</h1><p class="muted">Decode the VIN, then verify the details before saving.</p></div></div>${draft ? reviewNote : ''}<form id="vehicle-form"><section class="card"><h2>Vehicle identity</h2><div class="vin-row">${field('VIN', 'vin', v?.vin || '', 'required minlength="17" maxlength="17" pattern="[A-HJ-NPR-Za-hj-npr-z0-9]{17}" autocapitalize="characters"')}<button type="button" id="decode">Decode VIN</button></div><p id="decode-status" class="muted" role="status"></p><div class="form-grid">${field('Stock number', 'stockNumber', v?.stockNumber || '', 'required maxlength="50"')}${field('Year', 'year', v?.year || '', 'type="number" required min="1886" max="' + (new Date().getUTCFullYear() + 2) + '"')}${field('Make', 'make', v?.make || '', 'required maxlength="120"')}${field('Model', 'model', v?.model || '', 'required maxlength="120"')}${field('Trim', 'trim', v?.trim || '', 'maxlength="120"')}</div></section><section class="card"><h2>Stock & pricing</h2><div class="form-grid"><label>Status<select name="status">${vehicleStatuses.map(s => `<option ${s === (v?.status || 'available') ? 'selected' : ''}>${s}</option>`).join('')}</select></label>${field('Date stocked (UTC)', 'dateStocked', v?.dateStocked || new Date().toISOString().slice(0, 10), 'type="date" required max="' + new Date().toISOString().slice(0, 10) + '"')}${field('Mileage', 'mileage', v?.mileage ?? '', 'type="number" min="0" max="10000000" step="1"')}${field('List price (USD)', 'listPrice', v ? (v.listPrice / 100).toFixed(2) : '', 'type="number" min="0" max="100000000" step="0.01" required')}${field('Acquisition cost (USD)', 'cost', v ? (v.cost / 100).toFixed(2) : '', 'type="number" min="0" max="100000000" step="0.01" required')}${field('Location', 'location', v?.location || '', 'maxlength="200"')}</div></section><section class="card"><h2>Reconditioning</h2><p class="muted">Add actual work and costs as they occur.</p><div id="recon-items"></div><button type="button" id="add-recon">+ Add recon cost</button><p id="recon-total" class="total" aria-live="polite"></p></section><section class="card"><label>Notes<textarea name="notes" rows="4" maxlength="10000">${e(v?.notes || '')}</textarea></label></section><div class="form-actions"><a class="button" href="${v ? `#/vehicles/${v.id}` : '#/'}">Cancel</a><button id="save" class="primary">${v ? 'Save changes' : 'Add vehicle'}</button></div></form>`);
  const formEl = document.querySelector<HTMLFormElement>('#vehicle-form')!;
  if (draft) fillDraft(formEl, draft, ['listPrice', 'cost']);
  const draftSaved = draft ? bindDraftOutcome(formEl, 'inventory', api) : () => {};
  const input = (name: string) => formEl.elements.namedItem(name) as HTMLInputElement;
  const total = () => {
    try { document.querySelector('#recon-total')!.textContent = `Recon total: ${currency([...formEl.querySelectorAll<HTMLInputElement>('[name=reconAmount]')].reduce((sum, el) => sum + cents(el.value || '0'), 0))}`; }
    catch { document.querySelector('#recon-total')!.textContent = 'Enter valid recon amounts to calculate the total.'; }
  };
  const addRecon = (description = '', amount = '') => {
    if (formEl.querySelectorAll('.recon-row').length >= 100) { flash(new Error('At most 100 recon items are supported.')); return; }
    const row = document.createElement('div'); row.className = 'recon-row';
    row.innerHTML = `${field('Work description', 'reconDescription', description, 'required maxlength="200"')}${field('Cost (USD)', 'reconAmount', amount, 'type="number" min="0" max="100000000" step="0.01" required')}<button type="button" aria-label="Remove recon item">Remove</button>`;
    row.querySelector('button')!.addEventListener('click', () => { row.remove(); total(); }); row.addEventListener('input', total);
    document.querySelector('#recon-items')!.append(row); total();
  };
  v?.reconCosts.forEach(item => addRecon(item.description, (item.amount / 100).toFixed(2))); total();
  document.querySelector('#add-recon')!.addEventListener('click', () => addRecon());
  document.querySelector<HTMLButtonElement>('#decode')!.addEventListener('click', async event => {
    const button = event.currentTarget as HTMLButtonElement; const requestedVin = input('vin').value.trim().toUpperCase();
    const message = document.querySelector('#decode-status')!; button.disabled = true; message.textContent = 'Decoding VIN…';
    try {
      const decoded = await api<DecodedVin>(`/vin/${encodeURIComponent(requestedVin)}`);
      if (sequence !== routeSequence || input('vin').value.trim().toUpperCase() !== requestedVin) return;
      for (const key of ['year', 'make', 'model', 'trim'] as const) input(key).value = String(decoded[key] ?? '');
      message.textContent = decoded.warnings.length ? decoded.warnings.join(' ') : 'VIN decoded. Verify the vehicle details before saving.';
    } catch (error) { message.textContent = errorMessage(error); } finally { button.disabled = false; }
  });
  formEl.addEventListener('submit', async event => {
    event.preventDefault(); const button = document.querySelector<HTMLButtonElement>('#save')!; button.disabled = true;
    try {
      const data: VehicleInput = {mileage: input('mileage').value === '' ? null : Number(input('mileage').value), stockNumber: input('stockNumber').value, vin: input('vin').value, year: Number(input('year').value), make: input('make').value, model: input('model').value, trim: input('trim').value,
        status: input('status').value as VehicleInput['status'], dateStocked: input('dateStocked').value, listPrice: cents(input('listPrice').value), cost: cents(input('cost').value), location: input('location').value, notes: input('notes').value,
        reconCosts: [...formEl.querySelectorAll('.recon-row')].map(row => ({description: row.querySelector<HTMLInputElement>('[name=reconDescription]')!.value, amount: cents(row.querySelector<HTMLInputElement>('[name=reconAmount]')!.value)}))};
      const saved = await api<VehicleView>(v ? `/vehicles/${v.id}` : '/vehicles', v ? 'PUT' : 'POST', {...data, ...(v ? {version: v.version} : {})});
      draftSaved();
      location.hash = `#/vehicles/${saved.id}`;
    } catch (error) { flash(error); button.disabled = false; }
  });
}
async function route(): Promise<void> {
  if (location.hash === '#/terms' || location.hash === '#/privacy') { ++routeSequence; app.innerHTML = legalPageHtml(location.hash === '#/terms' ? 'terms' : 'privacy'); return; }
  if (location.hash.startsWith('#/join')) { ++routeSequence; await login(); return; }
  if (location.hash.startsWith('#/invite/')) {
    const sequence = ++routeSequence;
    app.innerHTML = '<main class="login"><p>Loading invite…</p></main>';
    try {
      const view = await publicApi<InviteView>(`/invite/${encodeURIComponent(location.hash.slice(9))}`);
      if (sequence !== routeSequence) return;
      app.innerHTML = inviteLandingHtml(view, !localMode, !!getToken());
      document.querySelector('#invite-signin')?.addEventListener('click', () => { void signIn(); });
      if (view.valid) {
        const form = app.querySelector<HTMLFormElement>('#accept-invite')!;
        const email = form.querySelector<HTMLInputElement>('[name=email]')!;
        email.addEventListener('input', () => { form.querySelector<HTMLElement>('#email-warning')!.hidden = invitedEmailMatches(email.value, view.email); });
        const path = `/invite/${encodeURIComponent(location.hash.slice(9))}/accept`;
        form.addEventListener('submit', async event => {
          event.preventDefault(); const button = form.querySelector('button')!; button.disabled = true;
          const message = form.querySelector<HTMLElement>('#invite-message')!;
          try {
            const result = await (localMode ? publicApi : api)<{outcome: string; reason?: 'expired' | 'revoked' | 'accepted'; message?: string; tenantId: string; email: string}>(path, 'POST', Object.fromEntries(new FormData(form)));
            if (sequence !== routeSequence) return;
            if (result.outcome === 'email-mismatch') { message.textContent = result.message!; return; }
            if (result.outcome === 'refused') { app.innerHTML = inviteLandingHtml({valid: false, reason: result.reason}); if (result.message) app.querySelector('main')!.append(Object.assign(document.createElement('p'), {textContent: result.message})); return; }
            if (result.outcome === 'already-member') { app.innerHTML = inviteSignInHtml(result.tenantId, result.email, true, !localMode); return; }
            app.innerHTML = inviteSignInHtml(result.tenantId, result.email, false, !localMode);
            if (localMode) {
              try {
                const signed = await publicApi<{token: string}>('/local/session', 'POST', {tenantId: result.tenantId, email: result.email});
                if (sequence !== routeSequence) return;
                setToken(signed.token); session = await api('/session');
                history.replaceState(null, '', '#/welcome'); await route();
              } catch { /* The accepted panel provides a manual sign-in path. */ }
            }
          } catch (error) { message.textContent = errorMessage(error); }
          finally { button.disabled = false; }
        });
      }
    } catch {
      if (sequence === routeSequence) app.innerHTML = '<main class="login"><h1>Unable to check this invite</h1><p>Please reload to try again.</p></main>';
    }
    return;
  }
  if (location.hash.startsWith('#/share/')) { ++routeSequence; await buyerRoute(location.hash.slice(8)); return; }
  if (!session) { await start(); return; } const sequence = ++routeSequence;
  try {
    const parts = location.hash.replace(/^#\//, '').split('/');
    if (parts[0] === 'welcome') {
      const {tenantId, userId, role} = session.principal;
      if (welcomeDismissed(localStorage, tenantId, userId)) { location.hash = '#/'; return; }
      shell(welcomeHtml(role, session.tenant?.name || 'Your dealership', !localMode));
      app.querySelectorAll<HTMLButtonElement>('[data-welcome]').forEach(button => button.addEventListener('click', () => { dismissWelcome(localStorage, tenantId, userId); location.hash = `#${button.dataset.welcome}`; }));
    }
    else if (parts[0] === 'deals') {
      const ui = {api, shell, flash, current: () => sequence === routeSequence, refresh: () => { void route(); }, admin: session.principal.role === 'admin'};
      if (parts[2] === 'compliance' && parts[1]) await dealComplianceRoute(parts[1], ui);
      else if (parts[2] === 'credit' && parts[1]) await creditRoute(parts[1], ui);
      else if (parts[2] === 'jacket' && parts[1]) await jacketRoute(parts[1], ui);
      else await dealsRoute(parts, ui);
    }
    else if (parts[0] === 'import') await importRoute({api, shell, flash, current: () => sequence === routeSequence, refresh: () => { void route(); }, admin: session.principal.role === 'admin'});
    else if (parts[0] === 'reports') await reportsRoute({api, download, shell, flash, current: () => sequence === routeSequence, refresh: () => { void route(); }, admin: session.principal.role === 'admin'});
    else if (parts[0] === 'parts') await partsRoute(parts, {api, shell, flash, current: () => sequence === routeSequence, refresh: () => { void route(); }, admin: session.principal.role === 'admin'});
    else if (parts[0] === 'service') await serviceRoute(parts, {api, apiEnvelope, shell, flash, current: () => sequence === routeSequence, refresh: () => { void route(); }, admin: session.principal.role === 'admin'});
    else if (parts[0] === 'compliance') await complianceRoute({api, shell, flash, current: () => sequence === routeSequence, refresh: () => { void route(); }, admin: session.principal.role === 'admin'}, parts[1]);
    else if (parts[0] === 'documents') await documentsRoute({api, shell, flash, current: () => sequence === routeSequence, refresh: () => { void route(); }, admin: session.principal.role === 'admin'});
    else if (parts[0] === 'users') await usersRoute({api, shell, flash, current: () => sequence === routeSequence, refresh: () => { void start(); }, admin: session.principal.role === 'admin'}, session.principal.tenantId, !localMode);
    else if (parts[0] === 'webhooks') await webhooksRoute({api, shell, flash, current: () => sequence === routeSequence, refresh: () => { void route(); }, admin: session.principal.role === 'admin'});
    else if (parts[0] === 'account') await accountRoute({api, shell, flash, current: () => sequence === routeSequence, refresh: () => { void route(); }, admin: session.principal.role === 'admin'}, {}, !localMode);
    else if (parts[0] === 'feeds') await feedRoute({api, download, shell, flash, current: () => sequence === routeSequence, refresh: () => { void route(); }, admin: session.principal.role === 'admin'});
    else if (parts[0] === 'accounting') await accountingRoute(parts, {api, shell, flash, current: () => sequence === routeSequence, refresh: () => { void route(); }, admin: session.principal.role === 'admin'});
    else if (parts[0] === 'fi-products') await fiRoute({api, shell, flash, current: () => sequence === routeSequence, refresh: () => { void route(); }, admin: session.principal.role === 'admin'});
    else if (parts[0] === 'leads') await crmRoute(parts, {api, apiEnvelope, shell, flash, current: () => sequence === routeSequence, refresh: () => { void route(); }, admin: session.principal.role === 'admin'});
    else if (parts[0] === 'new') await form(undefined, sequence);
    else if (parts[0] === 'vehicles' && parts[1]) { if (parts[2] === 'edit') await form(parts[1], sequence); else await detail(parts[1], sequence); }
    else await list(sequence);
  } catch (error) { if (sequence === routeSequence) { if (!getToken()) await login(); flash(error); } }
}
async function start(): Promise<void> {
  try {
    if (location.hash === '#/terms' || location.hash === '#/privacy') { await route(); return; }
    await finishSignIn();
    if (location.hash.startsWith('#/share/') || location.hash.startsWith('#/invite/')) { await route(); return; }
    if (!getToken()) { await login(); return; }
    session = await api('/session');
    await route();
  }
  catch (error) { await login(); flash(error); }
}
window.addEventListener('hashchange', () => { void route(); });
void start();

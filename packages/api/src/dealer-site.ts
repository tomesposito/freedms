import { projectedPhotoUrls, publiclyVisibleVehicles } from './vehicle-photos.js';
import { randomUUID } from 'node:crypto';
import type { Principal, Tenant, Vehicle, WebsiteSettings } from '@freedms/shared';
import { createLead } from './crm.js';
import { ApiError, missing } from './errors.js';
import { parseBody, response, type ApiRequest, type ApiResponse } from './handler.js';
import { buildPublicInventory, escapeHtml as e } from './public-inventory.js';
import type { RepositoryFactory, TenantRepository } from './repository.js';
import { invalid, onlyKeys, text } from './validation.js';
import { siteCss } from './dealer-site.css.js';

export const websiteFields = ['storeName', 'logoUrl', 'phone', 'address', 'hours', 'about', 'primaryColor', 'storePhotoUrl'] as const;
export function websiteDefaults(tenant: Tenant) {
  return {storeName: tenant.name, logoUrl: '', phone: tenant.phone ?? '', address: tenant.address ?? '', hours: '', about: '', primaryColor: '#ff6a00', storePhotoUrl: ''};
}
function safeUrl(value: string): string { return /^https?:\/\//i.test(value) ? value : ''; }
export async function websiteSettings(request: ApiRequest, principal: Principal, repo: TenantRepository, now: Date): Promise<ApiResponse> {
  if (principal.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', 'Only administrators can manage the website.');
  onlyKeys(request.query ?? {}, []);
  const tenant = await repo.tenant(); if (!tenant) throw missing();
  const old = await repo.crmGet('website-settings', 'website');
  const defaults = websiteDefaults(tenant);
  if (request.method.toUpperCase() === 'GET') return response(200, {data: {...defaults, ...old, version: old?.version ?? 0, siteUrl: `/public/${principal.tenantId}/site/`}});
  if (request.method.toUpperCase() !== 'PUT') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  const b = parseBody(request.body); onlyKeys(b, [...websiteFields, 'version']);
  if (!Number.isSafeInteger(b.version) || b.version !== (old?.version ?? 0)) throw new ApiError(409, 'CONFLICT', 'Settings changed. Reload and try again.');
  const values = Object.fromEntries(websiteFields.map(key => [key, text(b[key], key, key === 'about' ? 2000 : key.endsWith('Url') ? 2000 : 500, key !== 'primaryColor')])) as ReturnType<typeof websiteDefaults>;
  for (const key of ['logoUrl', 'storePhotoUrl'] as const) if (values[key] && !safeUrl(values[key])) throw invalid('Images must use HTTP(S) URLs.');
  if (!/^#[0-9a-f]{6}$/i.test(values.primaryColor)) throw invalid('Primary color must be a six-digit hex color.');
  const date = now.toISOString();
  const record: WebsiteSettings = {...values, id: 'website', tenantId: principal.tenantId, kind: 'website-settings', version: (old?.version ?? 0) + 1, createdAt: old?.createdAt ?? date, updatedAt: date};
  await repo.crmWrite([{record, expectedVersion: old?.version ?? 0, event: {id: randomUUID(), tenantId: principal.tenantId, actorId: principal.userId, aggregateId: record.id, aggregateVersion: record.version, type: old ? 'website-settings.updated' : 'website-settings.created', occurredAt: date, deliveryStatus: 'pending'}}]);
  return response(200, {data: record});
}
const title = (v: Vehicle) => [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ');
const price = (v: Vehicle) => new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: v.listPrice % 100 ? 2 : 0}).format(v.listPrice / 100);
const safePhotoUrl = (url: string) => safeUrl(url) || /^\/public\/[\w-]+\/photos\/[\w-]+$/.test(url);
function photo(url: string | undefined, label: string, big = false, index = 0) {
  return `<div class="${big ? 'bigph' : 'ph'} p${index % 6 + 1}">${url && safePhotoUrl(url) ? `<img src="${e(url)}" alt="${e(label)}" ${big ? '' : 'loading="lazy"'}>` : 'PHOTO COMING SOON'}</div>`;
}
function leadForm(action: string, dealer: string, success: boolean, error: string, values: Record<string, string>) {
  if (success) return '<div class="lead success" role="status">Thank you. Your message has been sent to the store. We will reply during open hours.</div>';
  return `<form class="lead" action="${e(action)}" method="post"><h2>Get in touch</h2>${error ? `<p class="error" role="alert">${e(error)}</p>` : ''}<label>Your name<input name="name" autocomplete="name" required maxlength="200" value="${e(values.name ?? '')}"></label><label>Phone or email<input name="contact" required maxlength="254" value="${e(values.contact ?? '')}"></label><label>Message<textarea name="message" rows="3" maxlength="2000">${e(values.message ?? '')}</textarea></label><button class="btn">Send to ${e(dealer)}</button><p class="note">Goes straight to the store. We reply during open hours.</p></form>`;
}
export function createDealerSiteHandler(photoBase = '') {
  // Best effort per-process fixed windows, like the public inventory surface.
  const buckets = new Map<string, {start: number; count: number}>();
  return async (request: ApiRequest, repositories: RepositoryFactory, now: Date): Promise<ApiResponse> => {
    const match = /^\/public\/([\w-]{1,128})\/site(?:\/(inventory|about|contact|vehicles\/([\w-]{1,128})))?\/?$/.exec(request.path);
    if (!match) throw missing();
    const [, tenantId, page = 'home', vehicleId] = match;
    const repo = repositories.forTenant(tenantId), tenant = await repo.tenant(); if (!tenant) throw missing();
    const method = request.method.toUpperCase(), canSubmit = page === 'contact' || !!vehicleId;
    if (method !== 'GET' && !(method === 'POST' && canSubmit)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    const time = now.getTime();
    for (const [key, bucket] of buckets) if (time - bucket.start >= 60000) buckets.delete(key);
    const key = `${tenantId}:${request.sourceIp ?? 'shared'}:${method}`;
    const bucket = buckets.get(key) ?? {start: time, count: 0}; buckets.set(key, bucket);
    if (++bucket.count > (method === 'POST' ? 10 : 120)) throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Try again later.');
    const query = request.query ?? {}; onlyKeys(query, page === 'inventory' ? ['q', 'make', 'under', 'sort'] : []);
    const settings = await repo.crmGet('website-settings', 'website');
    const s = {...websiteDefaults(tenant), ...settings};
    // An empty identity override falls back to the tenant's identity.
    s.storeName ||= tenant.name; s.phone ||= tenant.phone ?? ''; s.address ||= tenant.address ?? '';
    const all = publiclyVisibleVehicles(await repo.list({})).sort((a, b) => a.stockNumber.localeCompare(b.stockNumber) || a.id.localeCompare(b.id));
    const vehicle = vehicleId ? all.find(v => v.id === vehicleId) : undefined;
    if (vehicleId && !vehicle) throw missing();
    const base = `/public/${tenantId}/site`, action = vehicle ? `${base}/vehicles/${vehicle.id}` : `${base}/contact`;
    let success = false, error = '', status = 200; let values: Record<string, string> = {};
    if (method === 'POST') {
      try {
        if (Buffer.byteLength(request.body ?? '') > 12000) throw invalid('Message is too large.');
        const form = new URLSearchParams(request.body ?? '');
        for (const key of new Set(form.keys())) if (form.getAll(key).length !== 1) throw invalid('Duplicate form fields.');
        values = Object.fromEntries(form); onlyKeys(values, ['name', 'contact', 'message']);
        const contact = text(values.contact, 'Phone or email', 254), message = text(values.message ?? '', 'Message', 2000, true);
        await createLead(repo, {tenantId, userId: 'intake', role: 'staff'}, {customer: {name: values.name, phone: contact.includes('@') ? '' : contact, email: contact.includes('@') ? contact : '', address: '', notes: message, consent: {status: 'unknown', timestamp: null, source: 'Dealer website inquiry'}}, vehicleId: vehicle?.id ?? null, source: 'website', sourceDetail: 'Dealer website', vehicleDescription: vehicle ? title(vehicle) : ''}, now);
        success = true;
      } catch (err) { if (!(err instanceof ApiError) || err.status !== 400) throw err; error = err.message; status = 400; }
    }
    const info = `<div><b>${e(s.storeName)}</b><p class="info">${s.address ? `<a href="https://www.google.com/maps/search/?api=1&amp;query=${e(encodeURIComponent(s.address))}">${e(s.address)} · Directions</a>` : 'Contact us for directions.'}</p><p class="info">${e(s.hours || 'Call for current hours.')}</p></div><div><b>Call</b><p>${s.phone ? `<a href="tel:${e(s.phone.replace(/[^+\d]/g, ''))}">${e(s.phone)}</a>` : 'Contact us below.'}</p></div>`;
    const search = `<form class="search" action="${base}/inventory"><input name="q" aria-label="Search inventory" placeholder="Search make, model, or keyword" value="${e(query.q ?? '')}" maxlength="200"><button class="btn">Search</button></form>`;
    const cards = (vehicles: Vehicle[]) => vehicles.length ? `<div class="grid">${vehicles.map((v, i) => `<article class="card"><a href="${base}/vehicles/${e(v.id)}">${photo(projectedPhotoUrls(v, photoBase, 'thumb')[0], title(v), false, i)}<div class="cb"><h3>${e(title(v))}</h3><p class="meta">${v.mileage === null ? 'Mileage available on request' : `${e(v.mileage.toLocaleString('en-US'))} mi`}</p><div class="row"><span class="price">${e(price(v))}</span><span class="view">View details →</span></div></div></a></article>`).join('')}</div>` : '<p>No vehicles are currently available matching your search.</p>';
    let schemaVehicles = vehicle ? [vehicle] : all;
    let content: string;
    let pageTitle = s.storeName;
    if (vehicle) {
      pageTitle = `${title(vehicle)} — ${s.storeName}`;
      content = `<div class="detail"><div>${photo(projectedPhotoUrls(vehicle, photoBase, 'hero')[0], title(vehicle), true)}<div class="gallery">${projectedPhotoUrls(vehicle, photoBase).slice(1).filter(safePhotoUrl).map(url => `<img src="${e(url)}" alt="${e(title(vehicle))}" loading="lazy">`).join('')}</div><h1 style="font-size:27px;margin-top:16px">${e(title(vehicle))}</h1><p class="meta">Stock ${e(vehicle.stockNumber)} · VIN ${e(vehicle.vin)} · On the lot today</p>${vehicle.listingDescription ? `<p>${e(vehicle.listingDescription)}</p>` : ''}<div class="specs" style="margin-top:16px"><b>The vehicle</b><table>${[['Mileage', vehicle.mileage?.toLocaleString('en-US') ?? 'Ask us'], ['Year', vehicle.year], ['Make', vehicle.make], ['Model', vehicle.model], ['Trim', vehicle.trim]].map(([k, v]) => `<tr><td>${e(k!)}</td><td>${e(v!)}</td></tr>`).join('')}</table></div></div><div><div class="specs"><p class="note">OUR PRICE</p><div style="font-size:31px;font-weight:800">${e(price(vehicle))}</div><p class="note">Price updates live from the store’s system. Contact us for tax, title, license, and any applicable fees.</p></div>${leadForm(action, s.storeName, success, error, values)}</div></div>`;
    } else if (page === 'inventory') {
      pageTitle = `Inventory — ${s.storeName}`;
      const q = text(query.q ?? '', 'Search', 200, true).toLowerCase(), make = text(query.make ?? '', 'Make', 200, true);
      if (query.under && query.under !== '20000') throw invalid('Invalid price filter.');
      if (query.sort && query.sort !== 'price') throw invalid('Invalid sort.');
      let vehicles = all.filter(v => (!q || title(v).toLowerCase().includes(q)) && (!make || v.make === make) && (!query.under || v.listPrice < 2000000));
      if (query.sort === 'price') vehicles = vehicles.sort((a, b) => a.listPrice - b.listPrice || a.id.localeCompare(b.id));
      schemaVehicles = vehicles;
      const chip = (label: string, changes: Record<string, string | undefined>, on: boolean) => {const params = new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined)); for (const [k, v] of Object.entries(changes)) {if (v === undefined) params.delete(k); else params.set(k, v);} return `<a class="chip${on ? ' on' : ''}" href="${base}/inventory?${e(params.toString())}">${e(label)}</a>`;};
      content = `<section class="sec"><h1>Inventory — ${vehicles.length} vehicles</h1>${search}<div class="filters" style="margin-top:16px">${chip('All', {q: undefined, make: undefined, under: undefined, sort: undefined}, !Object.keys(query).length)}${chip('Under $20k', {under: query.under ? undefined : '20000'}, !!query.under)}${[...new Set(all.map(v => v.make))].sort().map(m => chip(m, {make: make === m ? undefined : m}, make === m)).join('')}${chip('Sort: Price low → high', {sort: query.sort ? undefined : 'price'}, !!query.sort)}</div>${cards(vehicles)}</section>`;
    } else if (page === 'about') {
      pageTitle = `About — ${s.storeName}`;
      content = `<section class="sec"><h1>About ${e(s.storeName)}</h1><p class="info" style="margin:16px 0">${e(s.about || `Welcome to ${s.storeName}. Browse our current inventory and contact us to learn more or plan a visit.`)}</p>${s.storePhotoUrl ? photo(s.storePhotoUrl, s.storeName, true) : ''}<div class="ft">${info}</div></section>`;
    } else if (page === 'contact') {
      pageTitle = `Contact — ${s.storeName}`;
      content = `<section class="detail"><div><h1>Contact ${e(s.storeName)}</h1><div class="ft">${info}</div></div><div>${leadForm(action, s.storeName, success, error, values)}</div></section>`;
    } else content = `<section class="hero"><h1>Used cars, priced plainly.</h1><p>Every car on this page is on our lot today, at the price shown. Browse live inventory at ${e(s.storeName)}.</p>${search}</section><section class="sec"><h2>Featured vehicles</h2>${cards(all.slice(0, 3))}</section><div class="strip"><div><b>Real prices</b>Prices update when we change them in the store.</div><div><b>Know your vehicle</b>Ask us about condition, inspection, and vehicle history.</div><div><b>Here to help</b>Send a question from any vehicle page, or visit the store.</div></div>`;
    const schema = buildPublicInventory(s.storeName, schemaVehicles, photoBase);
    const result = response(status, null); result.headers['content-type'] = 'text/html; charset=utf-8';
    result.headers['content-security-policy'] = "default-src 'none'; img-src https: http:; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
    result.body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(pageTitle)}</title><link rel="alternate" type="text/plain" href="/public/${tenantId}/llms.txt" title="Agent index"><style>:root{--primary:${/^#[0-9a-f]{6}$/i.test(s.primaryColor) ? s.primaryColor : '#ff6a00'}}${siteCss}</style><script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script></head><body><header class="hd"><a class="logo" href="${base}/">${s.logoUrl ? `<img src="${e(safeUrl(s.logoUrl))}" alt="${e(s.storeName)}">` : e(s.storeName)}</a><nav aria-label="Site">${[['', 'Home'], ['inventory', 'Inventory'], ['about', 'About'], ['contact', 'Contact']].map(([path, label]) => `<a href="${base}/${path}"${page === (path || 'home') ? ' class="on" aria-current="page"' : ''}>${label}</a>`).join('')}</nav><a class="phone" href="tel:${e(s.phone.replace(/[^+\d]/g, ''))}">${e(s.phone)}</a></header><main>${content}</main><footer class="ft">${info}<div><b>Site</b><p>Inventory updates live from the store.</p><p>Powered by freeDMS. Free with the DMS.</p><a href="/public/${tenantId}/llms.txt">Agent index</a></div></footer></body></html>`;
    return result;
  };
}

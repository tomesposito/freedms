import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VehicleInput } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler, type ApiRequest } from '../src/handler.js';
import { gatewayHandler } from '../src/gateway.js';
const start = new Date('2026-11-16T12:00:00Z');
const input: VehicleInput = {stockNumber: 'A1', vin: '1HGCM82633A004352', year: 2020, make: 'Ford', model: 'F-150', trim: 'XLT', mileage: 62410, status: 'available', listPrice: 3199500, cost: 1111000, reconCosts: [], dateStocked: '2026-11-01', location: 'Private location', notes: 'Private notes'};
async function setup() {
  const repositories = new MemoryRepositories(); let now = start;
  for (const id of ['A', 'B']) await repositories.forTenant(id).provision({id, name: `Dealer ${id}`, address: `${id} Street`, phone: '555-123-4567', createdAt: start.toISOString()}, {id: 'admin', name: 'Owner'}, {tenantId: id, userId: 'admin', role: 'admin', active: true}, {id: 'provision', tenantId: id, actorId: 'admin', aggregateId: id, aggregateVersion: 1, type: 'tenant.created', occurredAt: start.toISOString(), deliveryStatus: 'pending'});
  const handler = createHandler(repositories, {decode: async () => {throw new Error('Offline only');}}, () => now);
  const admin = (path: string, method = 'GET', body?: unknown, tenant = 'A') => handler({path, method, claims: {sub: 'admin', 'custom:tenant_id': tenant, iss: '', aud: '', exp: 0, token_use: 'id'}, body: JSON.stringify(body)});
  const add = async (changes: Partial<VehicleInput> = {}, tenant = 'A') => {const r = await admin('/vehicles', 'POST', {...input, ...changes}, tenant); assert.equal(r.statusCode, 201, r.body); return JSON.parse(r.body).data;};
  const get = (suffix = '/', query?: ApiRequest['query'], tenant = 'A') => handler({path: `/public/${tenant}/site${suffix}`, method: 'GET', query});
  const submit = (suffix: string, values: Record<string, string>, ip = 'form') => handler({path: `/public/A/site${suffix}`, method: 'POST', body: new URLSearchParams(values).toString(), sourceIp: ip});
  return {repositories, handler, admin, add, get, submit, advance: () => { now = new Date(now.getTime() + 60000); }};
}
test('all five public pages are live, tenant scoped, read only, escaped and agent readable', async () => {
  const {add, get, admin, repositories} = await setup();
  const v = await add({trim: '</script><b>unsafe</b>'}); await add({stockNumber: 'B-SECRET', model: 'B-SECRET'}, 'B');
  const defaults = JSON.parse((await admin('/settings/website')).body).data;
  assert.equal(defaults.storeName, 'Dealer A'); assert.equal(defaults.phone, '555-123-4567');
  await admin('/settings/website', 'PUT', {...defaults, siteUrl: undefined, storeName: 'A <script>alert(1)</script>', about: 'About A'});
  const before = await repositories.forTenant('A').events();
  for (const page of ['/', '/inventory', `/vehicles/${v.id}`, '/about', '/contact']) {
    const r = await get(page); assert.equal(r.statusCode, 200, r.body);
    assert.match(r.headers['content-type'], /text\/html/); assert.equal(r.headers['cache-control'], 'no-store');
    assert.match(r.body, /A &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    for (const secret of ['B-SECRET', 'Private notes', 'Private location', '1111000']) assert.ok(!r.body.includes(secret), secret);
    assert.match(r.body, /\/public\/A\/llms.txt/); assert.match(r.body, /application\/ld\+json/);
    const block = r.body.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1];
    assert.ok(!block.includes('<'));
    // #170: JSON-LD carries only the vehicles the page renders — about and
    // contact render none; the other pages render the one available vehicle.
    assert.equal(JSON.parse(block).numberOfItems, page === '/about' || page === '/contact' ? 0 : 1);
    assert.match(r.body, /name="viewport"/);
  }
  assert.deepEqual(await repositories.forTenant('A').events(), before);
  assert.ok(!(await get('/', undefined, 'B')).body.includes('About A'));
  assert.match((await get(`/vehicles/${v.id}`)).body, /PHOTO COMING SOON/);
  const changed = await admin(`/vehicles/${v.id}`, 'PUT', {...input, version: v.version, listPrice: 2099500}); assert.equal(changed.statusCode, 200);
  assert.match((await get('/inventory')).body, /\$20,995/);
  await admin(`/vehicles/${v.id}`, 'PUT', {...input, version: v.version + 1, status: 'sold'});
  assert.equal((await get(`/vehicles/${v.id}`)).statusCode, 404);
  assert.ok(!(await get('/inventory')).body.includes('F-150'));
  assert.equal((await get('/vehicles/unknown')).statusCode, 404);
  assert.equal((await get('/', undefined, 'missing')).statusCode, 404);
});
test('website settings require admin, validate controls and use versioned outbox storage', async () => {
  const {repositories, handler, admin} = await setup();
  await repositories.forTenant('A').saveMember({id: 'staff', name: 'Staff', email: 'staff@example.com'}, {tenantId: 'A', userId: 'staff', role: 'staff', active: true, version: 1}, 0, {id: 'staff-event', tenantId: 'A', actorId: 'admin', aggregateId: 'staff', aggregateVersion: 1, type: 'user.added', occurredAt: start.toISOString(), deliveryStatus: 'pending'});
  for (const method of ['GET', 'PUT']) assert.equal((await handler({path: '/settings/website', method, claims: {sub: 'staff', 'custom:tenant_id': 'A', iss: '', aud: '', exp: 0, token_use: 'id'}, body: '{}'})).statusCode, 403);
  assert.equal((await handler({path: '/settings/website', method: 'GET'})).statusCode, 401);
  const d = JSON.parse((await admin('/settings/website')).body).data; delete d.siteUrl;
  for (const changes of [{primaryColor: 'red;}'}, {logoUrl: 'javascript:alert(1)'}, {storePhotoUrl: 'data:image/svg+xml,evil'}, {customHtml: '<b>x</b>'}]) assert.equal((await admin('/settings/website', 'PUT', {...d, ...changes})).statusCode, 400);
  assert.equal((await admin('/settings/website', 'PUT', {...d, primaryColor: '#123456', hours: 'Mon–Sat 9–6'})).statusCode, 200);
  assert.equal((await admin('/settings/website', 'PUT', d)).statusCode, 409);
  assert.equal((await repositories.forTenant('A').crmGet('website-settings', 'website'))?.primaryColor, '#123456');
  assert.equal(await repositories.forTenant('B').crmGet('website-settings', 'website'), undefined);
  assert.ok((await repositories.forTenant('A').events()).some(e => e.type === 'website-settings.created'));
});
test('public vehicle and contact inquiries create validated CRM leads and events only for their site', async () => {
  const {add, submit, repositories, handler} = await setup(); const v = await add(); const other = await add({stockNumber: 'B'}, 'B');
  const values = {name: 'Shopper', contact: 'shopper@example.com', message: 'Can I visit Saturday?'};
  const r = await submit(`/vehicles/${v.id}`, values); assert.equal(r.statusCode, 200, r.body); assert.match(r.body, /Your message has been sent/);
  const repo = repositories.forTenant('A'), leads = await repo.crmList('lead');
  assert.equal(leads.length, 1); assert.equal(leads[0].vehicleId, v.id); assert.equal(leads[0].source, 'website');
  assert.equal((await repo.crmGet('customer', leads[0].customerId))?.notes, values.message);
  assert.equal((await repositories.forTenant('B').crmList('lead')).length, 0);
  assert.ok((await repo.events()).some(e => e.type === 'lead.created'));
  assert.equal((await submit(`/vehicles/${other.id}`, values)).statusCode, 404);
  assert.equal((await submit('/contact', {...values, vehicleId: other.id})).statusCode, 400);
  for (const invalid of [{...values, name: ''}, {...values, contact: 'x'}, {...values, contact: 'bad@'}, {...values, message: 'x'.repeat(2001)}]) {
    const bad = await submit('/contact', invalid); assert.equal(bad.statusCode, 400, bad.body); assert.match(bad.body, /role="alert"/);
  }
  assert.equal((await repo.crmList('lead')).length, 1);
  assert.equal((await submit('/contact', {...values, contact: '555-123-4567'})).statusCode, 200);
  assert.equal((await repo.crmList('lead')).find(l => l.vehicleId === null)?.source, 'website');
  const gateway = gatewayHandler(handler, 'issuer', 'audience');
  assert.equal((await gateway({rawPath: '/public/A/site/contact', body: new URLSearchParams(values).toString(), requestContext: {http: {method: 'POST', sourceIp: 'gateway'}}})).statusCode, 200);
});
test('server filters and photo rendering use public inventory fields', async () => {
  const {add, get} = await setup();
  await add({photoUrls: ['https://example.test/photo?a=1&b=2', 'https://example.test/second']});
  const h = await add({stockNumber: 'H', make: 'Honda', model: 'Accord', listPrice: 1500000});
  assert.ok(!(await get('/inventory', {under: '20000'})).body.includes('F-150'));
  assert.ok(!(await get('/inventory', {q: 'f-150'})).body.includes('Accord'));
  assert.ok(!(await get('/inventory', {make: 'Honda'})).body.includes('F-150'));
  const sorted = (await get('/inventory', {sort: 'price'})).body.split('<main>')[1]; assert.ok(sorted.indexOf('Accord') < sorted.indexOf('F-150'));
  assert.match((await get('/')).body, /https:\/\/example.test\/photo\?a=1&amp;b=2/);
  assert.equal((await get(`/vehicles/${h.id}`)).statusCode, 200);
  assert.equal((await get('/inventory', {sort: 'evil'})).statusCode, 400);
});
test('public site limits reads and submissions per tenant and source and expires windows', async () => {
  const {get, submit, handler, advance} = await setup();
  for (let i = 0; i < 120; i++) assert.equal((await get('/')).statusCode, 200);
  assert.equal((await get('/about')).statusCode, 429);
  assert.equal((await get('/', undefined, 'B')).statusCode, 200);
  assert.equal((await handler({path: '/public/A/site/', method: 'GET', sourceIp: 'other'})).statusCode, 200);
  for (let i = 0; i < 10; i++) assert.equal((await submit('/contact', {name: '', contact: ''})).statusCode, 400);
  assert.equal((await submit('/contact', {name: '', contact: ''})).statusCode, 429);
  advance(); assert.equal((await get('/')).statusCode, 200);
  assert.equal((await submit('/contact', {name: 'A', contact: 'a@example.com'})).statusCode, 200);
  assert.equal((await handler({path: '/public/A/site/', method: 'PUT'})).statusCode, 405);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VehicleInput } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler } from '../src/handler.js';
import type { RepositoryFactory, TenantRepository, VehicleQuery } from '../src/repository.js';

// #170: public inventory and dealer-site requests must not enumerate the full
// tenant inventory for responses that render few or no vehicles. These tests
// wrap the tenant repository and record every vehicle read, so the access
// pattern itself is under test, not just the rendered output.
const start = new Date('2026-11-21T12:00:00Z');
const input: VehicleInput = {stockNumber: 'A1', vin: '1HGCM82633A004352', year: 2020, make: 'Ford', model: 'F-150', trim: 'XLT', mileage: 62410, status: 'available', listPrice: 3199500, cost: 1111000, reconCosts: [], dateStocked: '2026-11-01', location: 'Private location', notes: 'Private notes'};

type Reads = {list: VehicleQuery[]; listPage: {limit: number; offset: number; status?: string}[]; get: string[]};
async function setup() {
  const inner = new MemoryRepositories();
  for (const id of ['A', 'B']) await inner.forTenant(id).provision({id, name: `Dealer ${id}`, createdAt: start.toISOString()}, {id: 'admin', name: 'Owner'}, {tenantId: id, userId: 'admin', role: 'admin', active: true}, {id: 'provision', tenantId: id, actorId: 'admin', aggregateId: id, aggregateVersion: 1, type: 'tenant.created', occurredAt: start.toISOString(), deliveryStatus: 'pending'});
  const reads: Reads = {list: [], listPage: [], get: []};
  const wrap = (repo: TenantRepository): TenantRepository => ({...repo,
    list: async query => { reads.list.push(query); return repo.list(query); },
    listPage: async query => { reads.listPage.push(query); return repo.listPage(query); },
    get: async id => { reads.get.push(id); return repo.get(id); }});
  const repositories: RepositoryFactory = {forTenant: tenantId => wrap(inner.forTenant(tenantId))};
  const handler = createHandler(repositories, {decode: async () => { throw new Error('Offline only'); }}, () => start);
  const admin = (path: string, method = 'GET', body?: unknown, tenant = 'A') => handler({path, method, claims: {sub: 'admin', 'custom:tenant_id': tenant, iss: '', aud: '', exp: 0, token_use: 'id'}, body: JSON.stringify(body)});
  const add = async (changes: Partial<VehicleInput> = {}, tenant = 'A') => { const r = await admin('/vehicles', 'POST', {...input, ...changes}, tenant); assert.equal(r.statusCode, 201, r.body); return JSON.parse(r.body).data; };
  const reset = () => { reads.list = []; reads.listPage = []; reads.get = []; };
  const noReads = () => { assert.deepEqual(reads, {list: [], listPage: [], get: []}); };
  const schemaItems = (body: string) => JSON.parse(body.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1]).numberOfItems as number;
  return {inner, handler, add, reads, reset, noReads, schemaItems};
}

test('agent index, about and contact pages, and contact submissions never read vehicles (#170)', async () => {
  const {inner, handler, add, reset, noReads, schemaItems} = await setup();
  await add(); await add({stockNumber: 'A2', vin: '1HGCM82633A004353', status: 'sold'});
  reset();
  const index = await handler({path: '/public/A/llms.txt', method: 'GET', sourceIp: 'one'});
  assert.equal(index.statusCode, 200); assert.match(index.body, /inventory\.json/); noReads();
  const about = await handler({path: '/public/A/site/about', method: 'GET', sourceIp: 'one'});
  assert.equal(about.statusCode, 200); assert.equal(schemaItems(about.body), 0); noReads();
  const contact = await handler({path: '/public/A/site/contact', method: 'GET', sourceIp: 'one'});
  assert.equal(contact.statusCode, 200); assert.equal(schemaItems(contact.body), 0); noReads();
  const submit = await handler({path: '/public/A/site/contact', method: 'POST', sourceIp: 'form', body: new URLSearchParams({name: 'Shopper', contact: 'shopper@example.com', message: 'Hello'}).toString()});
  assert.equal(submit.statusCode, 200, submit.body); assert.match(submit.body, /Your message has been sent/);
  assert.equal(schemaItems(submit.body), 0); noReads();
  assert.equal((await inner.forTenant('A').crmList('lead')).length, 1);
});

test('vehicle pages resolve one vehicle by point read and stay scoped (#170)', async () => {
  const {handler, add, reads, reset, schemaItems} = await setup();
  const v = await add(); const sold = await add({stockNumber: 'A2', vin: '1HGCM82633A004353', status: 'sold'});
  const other = await add({stockNumber: 'B1', vin: '1HGCM82633A004354'}, 'B');
  reset();
  const page = await handler({path: `/public/A/site/vehicles/${v.id}`, method: 'GET', sourceIp: 'one'});
  assert.equal(page.statusCode, 200); assert.equal(schemaItems(page.body), 1);
  assert.deepEqual(reads, {list: [], listPage: [], get: [v.id]});
  reset();
  const submit = await handler({path: `/public/A/site/vehicles/${v.id}`, method: 'POST', sourceIp: 'form', body: new URLSearchParams({name: 'Shopper', contact: 'shopper@example.com', message: 'Hello'}).toString()});
  assert.equal(submit.statusCode, 200, submit.body);
  // The page handler and lead intake each point-read the one vehicle; no list reads.
  assert.deepEqual(reads.list, []); assert.deepEqual(reads.listPage, []);
  assert.ok(reads.get.length >= 1 && reads.get.every(id => id === v.id));
  reset();
  for (const id of [sold.id, other.id, 'unknown']) {
    assert.equal((await handler({path: `/public/A/site/vehicles/${id}`, method: 'GET', sourceIp: 'one'})).statusCode, 404);
  }
  assert.deepEqual(reads.list, []); assert.deepEqual(reads.listPage, []);
  // A sold vehicle cannot take inquiries either, and creates no lead.
  const soldSubmit = await handler({path: `/public/A/site/vehicles/${sold.id}`, method: 'POST', sourceIp: 'form', body: new URLSearchParams({name: 'Shopper', contact: 'shopper@example.com', message: 'Hello'}).toString()});
  assert.equal(soldSubmit.statusCode, 404);
  assert.deepEqual(reads.list, []); assert.deepEqual(reads.listPage, []);
});

test('home page uses one bounded page query; public lists ask for available vehicles only (#170)', async () => {
  const {handler, add, reads, reset, schemaItems} = await setup();
  const added = [];
  for (let i = 1; i <= 5; i++) added.push(await add({stockNumber: `A${i}`, vin: `1HGCM82633A00435${i}`}));
  await add({stockNumber: 'SOLD', vin: '1HGCM82633A004359', status: 'sold'});
  reset();
  const home = await handler({path: '/public/A/site/', method: 'GET', sourceIp: 'one'});
  assert.equal(home.statusCode, 200);
  assert.deepEqual(reads.list, []);
  assert.equal(reads.listPage.length, 1);
  assert.deepEqual([reads.listPage[0].limit, reads.listPage[0].offset, reads.listPage[0].status], [3, 0, 'available']);
  assert.equal((home.body.match(/<article/g) ?? []).length, 3);
  assert.equal(schemaItems(home.body), 3);
  // All fixtures share a creation timestamp, so listPage's page is the first
  // three by id; cards and JSON-LD must show exactly those, in stock order.
  const expected = [...added].sort((a, b) => a.id < b.id ? -1 : 1).slice(0, 3)
    .sort((a, b) => a.stockNumber.localeCompare(b.stockNumber));
  assert.deepEqual([...home.body.matchAll(/site\/vehicles\/([\w-]+)"/g)].map(m => m[1]), expected.map(v => v.id));
  const schema = JSON.parse(home.body.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1]);
  assert.deepEqual(schema.itemListElement.map((row: any) => row.item.itemOffered.sku), expected.map(v => v.stockNumber));
  reset();
  const site = await handler({path: '/public/A/site/inventory', method: 'GET', sourceIp: 'one'});
  assert.equal(site.statusCode, 200); assert.deepEqual(reads.list, [{status: 'available'}]);
  assert.equal(schemaItems(site.body), 5); assert.ok(!site.body.includes('SOLD'));
  reset();
  const doc = await handler({path: '/public/A/inventory.json', method: 'GET', sourceIp: 'one'});
  assert.equal(doc.statusCode, 200); assert.deepEqual(reads.list, [{status: 'available'}]);
  assert.equal(JSON.parse(doc.body).numberOfItems, 5);
  reset();
  const html = await handler({path: '/public/A/inventory.html', method: 'GET', sourceIp: 'one'});
  assert.equal(html.statusCode, 200); assert.deepEqual(reads.list, [{status: 'available'}]);
});

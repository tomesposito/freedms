import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pencilMath, maxDocumentBytes, type DealView, type DealJacket } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { MemoryDocumentStore } from '../src/document-store.js';
import { createHandler, type ApiRequest } from '../src/handler.js';
import { LocalTokens } from '../src/auth.js';
import { renderPacket } from '../../web/src/jacket.js';
const vehicle = {cost: 700000, reconCosts: [{description: 'Repair', amount: 50000}]};
const now = new Date('2026-10-19T12:00:00Z');
async function setup(role: 'admin' | 'staff' = 'admin') {
  const repositories = new MemoryRepositories(); const tokens = new LocalTokens('desking-test-secret-at-least-32-characters', () => now.getTime());
  for (const tenantId of ['A', 'B']) await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: now.toISOString()}, {id: `user${tenantId}`, name: tenantId}, {tenantId, userId: `user${tenantId}`, role, active: true}, {id: 'provision', tenantId, actorId: `user${tenantId}`, aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  const store = new MemoryDocumentStore();
  const handler = createHandler(repositories, {decode: async () => { throw new Error('No network'); }}, () => now, store);
  const call = async (tenant: string, method = 'GET', path = '/deals', body?: unknown, query?: ApiRequest['query']) => {
    const r = await handler({method, path, body: body === undefined ? undefined : JSON.stringify(body), query, claims: tokens.verify(tokens.issue(`user${tenant}`, tenant))});
    return {status: r.statusCode, ...JSON.parse(r.body)};
  };
  const v = (await call('A', 'POST', '/vehicles', {stockNumber: 'test', vin: '1HGCM82633A004352', year: 2003, make: 'Test', model: 'Test', trim: '', status: 'available', listPrice: 1000000, ...vehicle, dateStocked: '2026-10-19', location: '', notes: ''})).data;
  const lead = (await call('A', 'POST', '/leads', {customer: {name: 'Buyer', phone: '', email: '', address: '', notes: '', consent: {status: 'unknown', timestamp: null, source: ''}}, source: 'walk-in', vehicleId: v.id})).data.lead;
  const create = async (overrides = {}) => { const r = await call('A', 'POST', '/deals', {vehicleId: v.id, customerId: lead.customerId, leadId: lead.id, type: 'finance', ...overrides}); assert.equal(r.status, 201); return r.data as DealView; };
  return {call, create, v, lead, repositories, handler, store};
}
const upload = {name: 'license.bin', type: 'id', content: Buffer.from([0, 255, 1, 128, 10]).toString('base64')};
for (const type of ['finance', 'cash'] as const) test(`sold ${type} jacket matches every worksheet field and prints buyer fields only`, async () => {
  const {call, create} = await setup();
  await call('A', 'PUT', '/settings', {version: 0, taxRateBps: 625, taxTradeDifference: true, docFee: 29900});
  let d = await create({type});
  const pencil = {...d.pencils[0], price: 1234567, down: 12345, aprBps: 725, term: 48};
  const trade = {year: '2011', make: 'Trade', model: 'Car', vin: 'trade-vin', allowance: 200000, payoff: 250000, actualCashValue: 175000};
  d = (await call('A', 'PUT', `/deals/${d.id}`, {version: 1, pencils: [pencil], trade, status: 'approved'})).data;
  await call('A', 'PUT', '/settings', {version: 1, taxRateBps: 0, taxTradeDifference: false, docFee: 0});
  const approved = (await call('A', 'GET', `/deals/${d.id}/jacket`)).data as DealJacket;
  assert.deepEqual(approved.checklist.map(c => c.present), [true, true, false, false]);
  d = (await call('A', 'PUT', `/deals/${d.id}`, {version: 2, status: 'sold'})).data;
  const result = await call('A', 'GET', `/deals/${d.id}/jacket`); assert.equal(result.status, 200);
  const j = result.data as DealJacket;
  assert.deepEqual(j.numbers, pencilMath(pencil, trade, d, d.vehicle, type)); assert.deepEqual(j.pencil, pencil);
  assert.deepEqual(j.buyersGuide, {vehicle: {year: d.vehicle.year, make: d.vehicle.make, model: d.vehicle.model, vin: d.vehicle.vin, stockNumber: d.vehicle.stockNumber}, asIs: true, dealerWarranty: null, manufacturerWarranty: null});
  const html = renderPacket(j); assert.doesNotMatch(html, /front gross|Vehicle cost|Recon/i);
  assert.match(html, /AS IS — NO DEALER WARRANTY/); assert.match(html, /Actual cash value/);
  if (type === 'cash') { assert.match(html, /Remaining cash due/); assert.doesNotMatch(html, /Monthly payment|Amount financed|APR|Finance charge|Total of payments/); }
  else { for (const label of ['Monthly payment', 'Amount financed', 'APR', 'Finance charge', 'Total of payments', 'Term']) assert.ok(html.includes(label)); }
  j.deal.customer.name = '<script>bad()</script>'; j.deal.vehicle.trim = '<img src=x>'; assert.doesNotMatch(renderPacket(j), /<script>|<img/);
});
test('working and dead jackets reject honestly while attachments work in either state', async () => {
  const {call, create} = await setup(); const d = await create();
  for (const status of ['working', 'dead']) {
    if (status === 'dead') await call('A', 'PUT', `/deals/${d.id}`, {version: 1, status});
    const r = await call('A', 'GET', `/deals/${d.id}/jacket`); assert.equal(r.status, 400); assert.match(r.error.message, /approved or sold/);
    assert.equal((await call('A', 'POST', `/deals/${d.id}/documents`, upload)).status, 201);
  }
});
test('attachment round-trip, minimal atomic event and derived completeness', async () => {
  const {call, create, repositories} = await setup(); const d = await create(); const base = `/deals/${d.id}`;
  await call('A', 'PUT', base, {version: 1, status: 'approved'});
  assert.deepEqual((await call('A', 'GET', `${base}/documents`)).data, []);
  const count = repositories.eventsForTest('A').length;
  const attached = await call('A', 'POST', `${base}/documents`, upload); assert.equal(attached.status, 201);
  const record = attached.data; assert.equal(record.uploadedBy, 'userA'); assert.equal(record.uploadedAt, now.toISOString()); assert.equal(record.name, upload.name); assert.equal(record.type, 'id'); assert.equal(record.size, 5); assert.equal(record.content, undefined);
  assert.deepEqual((await call('A', 'GET', `${base}/documents`)).data, [record]);
  assert.equal((await call('A', 'GET', `${base}/documents/${record.id}/content`)).data.content, upload.content);
  const events = repositories.eventsForTest('A').slice(count); assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0]).sort(), ['id', 'tenantId', 'actorId', 'aggregateId', 'aggregateVersion', 'type', 'occurredAt', 'deliveryStatus'].sort()); assert.equal(events[0].type, 'document.created'); assert.equal(events[0].aggregateId, record.id);
  assert.deepEqual((await call('A', 'GET', `${base}/jacket`)).data.checklist.map((c: {present: boolean}) => c.present), [true, true, true, false]);
  await call('A', 'POST', `${base}/documents`, {...upload, type: 'insurance'});
  assert.ok((await call('A', 'GET', `${base}/jacket`)).data.checklist.every((c: {present: boolean}) => c.present));
});
test('jacket, document list, attach and content are tenant and deal isolated', async () => {
  const {call, create, repositories, store} = await setup(); const d = await create(), other = await create(); const base = `/deals/${d.id}`;
  await call('A', 'PUT', base, {version: 1, status: 'approved'});
  const doc = (await call('A', 'POST', `${base}/documents`, upload)).data;
  const before = repositories.eventsForTest('B');
  for (const path of [`${base}/jacket`, `${base}/documents`, `${base}/documents/${doc.id}/content`]) assert.equal((await call('B', 'GET', path)).status, 404);
  assert.equal((await call('B', 'POST', `${base}/documents`, upload)).status, 404);
  assert.equal((await call('A', 'GET', `/deals/${other.id}/documents/${doc.id}/content`)).status, 404);
  assert.equal(await store.forTenant('B').get(doc.id), undefined);
  assert.deepEqual(await repositories.forTenant('B').crmList('document'), []); assert.deepEqual(repositories.eventsForTest('B'), before);
});
test('invalid attachments and unauthenticated requests leave metadata and outbox unchanged', async () => {
  const {call, create, repositories, handler} = await setup(); const d = await create(), base = `/deals/${d.id}/documents`;
  const before = repositories.eventsForTest('A');
  for (const fields of [{type: 'bad'}, {name: ''}, {name: 'x'.repeat(161)}, {content: ''}, {content: '%%%='}, {content: 'YQ='}, {content: 'YR=='}, {content: 42}, {content: Buffer.alloc(maxDocumentBytes + 1).toString('base64')}, {content: 'A'.repeat(65536)}, {tenantId: 'B'}, {uploadedBy: 'forged'}]) assert.equal((await call('A', 'POST', base, {...upload, ...fields})).status, 400);
  assert.equal((await call('A', 'POST', '/deals/missing/documents', upload)).status, 404);
  for (const path of [base, `/deals/${d.id}/jacket`, `${base}/missing/content`]) assert.equal((await handler({method: 'GET', path})).statusCode, 401);
  assert.equal((await handler({method: 'POST', path: base, body: JSON.stringify(upload)})).statusCode, 401);
  assert.equal((await call('A', 'GET', base, undefined, {tenantId: 'B'})).status, 400);
  assert.deepEqual(await repositories.forTenant('A').crmList('document'), []); assert.deepEqual(repositories.eventsForTest('A'), before);
});
test('document store copies bytes and isolates identical keys between tenants', async () => {
  const store = new MemoryDocumentStore(), bytes = new Uint8Array([1, 2]);
  await store.forTenant('A').put('same', bytes); bytes[0] = 9;
  await store.forTenant('B').put('same', new Uint8Array([3]));
  const read = (await store.forTenant('A').get('same'))!; read[0] = 8;
  assert.deepEqual(await store.forTenant('A').get('same'), new Uint8Array([1, 2]));
  await store.forTenant('A').remove('same'); assert.deepEqual(await store.forTenant('B').get('same'), new Uint8Array([3]));
});
test('failed metadata transaction removes staged bytes and leaves no record or event', async () => {
  const {create, repositories, store} = await setup(); const d = await create();
  const {conflict} = await import('../src/errors.js');
  const tokens = new LocalTokens('jacket-failure-secret-at-least-32-characters', () => now.getTime());
  let stagedId = '';
  const documents = {forTenant: (tenant: string) => {
    const scoped = store.forTenant(tenant);
    return {...scoped, put: async (id: string, bytes: Uint8Array) => { stagedId = id; await scoped.put(id, bytes); }};
  }};
  const failing = {forTenant: (tenant: string) => ({...repositories.forTenant(tenant), crmWrite: async () => { throw conflict(); }})};
  const handler = createHandler(failing, {decode: async () => { throw new Error('No network'); }}, () => now, documents);
  const before = repositories.eventsForTest('A');
  const r = await handler({method: 'POST', path: `/deals/${d.id}/documents`, body: JSON.stringify(upload), claims: tokens.verify(tokens.issue('userA', 'A'))});
  assert.equal(r.statusCode, 409); assert.ok(stagedId); assert.equal(await store.forTenant('A').get(stagedId), undefined);
  assert.deepEqual(await repositories.forTenant('A').crmList('document'), []); assert.deepEqual(repositories.eventsForTest('A'), before);
});
test('maximum-size attachment is accepted; missing production store fails without metadata writes', async () => {
  const {call, create, repositories} = await setup(); const d = await create();
  const content = Buffer.alloc(maxDocumentBytes, 255).toString('base64');
  const uploaded = await call('A', 'POST', `/deals/${d.id}/documents`, {...upload, content}); assert.equal(uploaded.status, 201);
  assert.equal((await call('A', 'GET', `/deals/${d.id}/documents/${uploaded.data.id}/content`)).data.content, content);
  const tokens = new LocalTokens('jacket-no-store-secret-at-least-32-characters', () => now.getTime());
  const handler = createHandler(repositories, {decode: async () => { throw new Error('No network'); }}, () => now);
  const before = repositories.eventsForTest('A');
  assert.equal((await handler({method: 'POST', path: `/deals/${d.id}/documents`, body: JSON.stringify(upload), claims: tokens.verify(tokens.issue('userA', 'A'))})).statusCode, 503);
  assert.deepEqual(repositories.eventsForTest('A'), before); assert.equal((await repositories.forTenant('A').crmList('document')).length, 1);
});

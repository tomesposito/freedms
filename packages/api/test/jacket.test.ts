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
  let time = now;
  const repositories = new MemoryRepositories(); const tokens = new LocalTokens('desking-test-secret-at-least-32-characters', () => time.getTime());
  for (const tenantId of ['A', 'B']) await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: now.toISOString()}, {id: `user${tenantId}`, name: tenantId}, {tenantId, userId: `user${tenantId}`, role, active: true}, {id: 'provision', tenantId, actorId: `user${tenantId}`, aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  const store = new MemoryDocumentStore();
  const handler = createHandler(repositories, {decode: async () => { throw new Error('No network'); }}, () => time, store);
  const call = async (tenant: string, method = 'GET', path = '/deals', body?: unknown, query?: ApiRequest['query']) => {
    const r = await handler({method, path, body: body === undefined ? undefined : JSON.stringify(body), query, claims: tokens.verify(tokens.issue(`user${tenant}`, tenant))});
    return {status: r.statusCode, ...JSON.parse(r.body)};
  };
  const v = (await call('A', 'POST', '/vehicles', {stockNumber: 'test', vin: '1HGCM82633A004352', year: 2003, make: 'Test', model: 'Test', trim: '', status: 'available', listPrice: 1000000, ...vehicle, dateStocked: '2026-10-19', location: '', notes: ''})).data;
  const lead = (await call('A', 'POST', '/leads', {customer: {name: 'Buyer', phone: '', email: '', address: '', notes: '', consent: {status: 'unknown', timestamp: null, source: ''}}, source: 'walk-in', vehicleId: v.id})).data.lead;
  const create = async (overrides = {}) => { const r = await call('A', 'POST', '/deals', {vehicleId: v.id, customerId: lead.customerId, leadId: lead.id, type: 'finance', ...overrides}); assert.equal(r.status, 201); return r.data as DealView; };
  return {call, create, v, lead, repositories, handler, store, setNow: (value: Date) => { time = value; }};
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

test('document search combines filename, type, buyer/deal and inclusive UTC date filters; tenants stay isolated', async () => {
  const {call, create, setNow} = await setup(); const deal = await create();
  const first = (await call('A', 'POST', `/deals/${deal.id}/documents`, upload)).data;
  setNow(new Date('2026-10-21T23:59:59Z'));
  const second = (await call('A', 'POST', `/deals/${deal.id}/documents`, {...upload, name: 'Policy.PDF', type: 'insurance'})).data;
  const search = async (query = {}) => (await call('A', 'GET', '/documents', undefined, query)).data;
  assert.deepEqual((await search()).map((d: {id: string}) => d.id), [second.id, first.id]);
  for (const query of [{name: 'LICENSE'}, {type: 'id'}, {buyer: deal.id}, {buyer: 'BUYER', name: 'bin', type: 'id', from: '2026-10-19', to: '2026-10-19'}]) {
    const rows = await search(query); assert.ok(rows.some((d: {id: string}) => d.id === first.id));
    assert.equal(rows[0].dealId, deal.id); assert.equal(rows[0].buyerName, 'Buyer');
  }
  assert.deepEqual((await search({from: '2026-10-21', to: '2026-10-21'})).map((d: {id: string}) => d.id), [second.id]);
  for (const query of [{name: 'absent'}, {buyer: 'absent'}, {type: 'title'}, {to: '2026-10-18'}, {from: '2026-10-22'}, {name: 'license', type: 'insurance'}]) assert.deepEqual(await search(query), []);
  for (const query of [{type: 'bad'}, {from: '2026-02-30'}, {to: 'no'}, {from: '2026-10-22', to: '2026-10-19'}, {tenantId: 'B'}, {name: 'x'.repeat(161)}]) assert.equal((await call('A', 'GET', '/documents', undefined, query)).status, 400);
  for (const query of [{}, {buyer: deal.id}, {name: first.name}]) assert.deepEqual((await call('B', 'GET', '/documents', undefined, query)).data, []);
});

test('retention is opt-in, tenant scoped, versioned and audited; listing never deletes', async () => {
  const {call, create, setNow, repositories, store} = await setup(); const deal = await create();
  const doc = (await call('A', 'POST', `/deals/${deal.id}/documents`, upload)).data;
  assert.deepEqual((await call('A', 'GET', '/documents/retention')).data, {version: 0, retentionDays: null});
  setNow(new Date('2026-11-19T12:00:00Z'));
  assert.deepEqual((await call('A', 'GET', '/documents/past-retention')).data, []);
  const setting = await call('A', 'PUT', '/documents/retention', {version: 0, retentionDays: 31}); assert.equal(setting.status, 200);
  assert.deepEqual((await call('A', 'GET', '/documents/past-retention')).data, []); // Strictly older, not equal.
  assert.equal((await call('A', 'PUT', '/documents/retention', {version: 1, retentionDays: 30})).status, 200);
  assert.equal((await call('A', 'PUT', '/documents/retention', {version: 1, retentionDays: 1})).status, 409);
  const before = repositories.eventsForTest('A');
  for (let i = 0; i < 2; i++) assert.deepEqual((await call('A', 'GET', '/documents/past-retention')).data.map((d: {id: string}) => d.id), [doc.id]);
  assert.deepEqual(repositories.eventsForTest('A'), before);
  assert.ok(await store.forTenant('A').get(doc.id)); assert.equal((await repositories.forTenant('A').crmGet('document', doc.id))!.status, undefined);
  assert.equal((await call('A', 'GET', `/deals/${deal.id}/documents/${doc.id}/content`)).status, 200);
  assert.deepEqual((await call('B', 'GET', '/documents/retention')).data, {version: 0, retentionDays: null});
  await call('B', 'PUT', '/documents/retention', {version: 0, retentionDays: 1});
  assert.deepEqual((await call('B', 'GET', '/documents/past-retention')).data, []);
  assert.equal((await call('A', 'GET', '/documents/past-retention', undefined, {tenantId: 'B'})).status, 400);
  assert.deepEqual(before.filter(e => e.type.startsWith('retention.')).map(e => e.type), ['retention.created', 'retention.updated']);
  assert.equal((await call('A', 'PUT', '/documents/retention', {version: 2, retentionDays: null})).status, 200);
  assert.deepEqual((await call('A', 'GET', '/documents/past-retention')).data, []);
  for (const retentionDays of [0, -1, 1.5, '30', 36501]) assert.equal((await call('A', 'PUT', '/documents/retention', {version: 3, retentionDays})).status, 400);
});

test('explicit admin disposal removes bytes, preserves jacket and search, and records a content-free audit', async () => {
  const {call, create, repositories, store, setNow} = await setup(); const deal = await create();
  await call('A', 'PUT', `/deals/${deal.id}`, {version: 1, status: 'approved'});
  const doc = (await call('A', 'POST', `/deals/${deal.id}/documents`, upload)).data;
  const path = `/documents/${doc.id}/dispose`, confirm = {version: 1, confirm: true};
  const before = repositories.eventsForTest('A');
  assert.equal((await call('B', 'POST', path, confirm)).status, 404);
  assert.equal((await call('A', 'POST', '/documents/missing/dispose', confirm)).status, 404);
  for (const body of [{version: 1}, {version: 1, confirm: false}, {...confirm, tenantId: 'B'}]) assert.equal((await call('A', 'POST', path, body)).status, 400);
  assert.equal((await call('A', 'POST', path, {...confirm, version: 2})).status, 409);
  assert.deepEqual(repositories.eventsForTest('A'), before); assert.ok(await store.forTenant('A').get(doc.id));
  setNow(new Date('2026-12-01T10:00:00Z'));
  const result = await call('A', 'POST', path, confirm); assert.equal(result.status, 200);
  assert.equal(result.data.status, 'disposed'); assert.equal(result.data.disposedBy, 'userA');
  assert.equal(await store.forTenant('A').get(doc.id), undefined);
  assert.equal((await call('A', 'GET', `/deals/${deal.id}/documents/${doc.id}/content`)).status, 410);
  assert.equal((await call('A', 'GET', `/deals/${deal.id}/documents`)).data[0].status, 'disposed');
  const jacket = (await call('A', 'GET', `/deals/${deal.id}/jacket`)).data as DealJacket;
  assert.deepEqual(jacket.checklist.find(c => c.key === 'id'), {key: 'id', label: 'Driver’s license / ID', present: true, status: 'disposed'});
  assert.equal((await call('A', 'GET', '/documents')).data[0].status, 'disposed');
  await call('A', 'PUT', '/documents/retention', {version: 0, retentionDays: 1});
  assert.deepEqual((await call('A', 'GET', '/documents/past-retention')).data, []);
  const audit = repositories.eventsForTest('A').find(e => e.type === 'document.disposed')!;
  assert.deepEqual(audit.disposal, {documentId: doc.id, name: doc.name, type: doc.type, dealId: deal.id, disposedBy: 'userA', disposedAt: '2026-12-01T10:00:00.000Z'});
  assert.equal(audit.actorId, 'userA'); assert.equal(audit.tenantId, 'A'); assert.equal(audit.occurredAt, result.data.disposedAt); assert.ok(!JSON.stringify(audit).includes(upload.content));
  assert.equal((await call('A', 'POST', path, {version: result.data.version, confirm: true})).status, 409);
  await call('A', 'POST', `/deals/${deal.id}/documents`, upload);
  assert.equal((await call('A', 'GET', `/deals/${deal.id}/jacket`)).data.checklist.find((c: {key: string}) => c.key === 'id').status, 'present');
});

test('staff can search but cannot read retention controls, change settings or dispose', async () => {
  const {call, create, repositories, store} = await setup('staff'); const deal = await create();
  const doc = (await call('A', 'POST', `/deals/${deal.id}/documents`, upload)).data;
  const before = repositories.eventsForTest('A');
  assert.equal((await call('A', 'GET', '/documents')).data.length, 1);
  for (const [method, path, body] of [['GET', '/documents/retention', undefined], ['GET', '/documents/past-retention', undefined], ['PUT', '/documents/retention', {version: 0, retentionDays: 1}], ['POST', `/documents/${doc.id}/dispose`, {version: 1, confirm: true}]] as const) {
    const r = await call('A', method, path, body); assert.equal(r.status, 403); assert.equal(r.error.code, 'FORBIDDEN');
  }
  assert.ok(await store.forTenant('A').get(doc.id)); assert.deepEqual(repositories.eventsForTest('A'), before);
});

test('storage failures leave a visible, audited pending disposal for explicit retry only', async () => {
  const {call, create, repositories, store} = await setup(); const deal = await create();
  const doc = (await call('A', 'POST', `/deals/${deal.id}/documents`, upload)).data;
  const tokens = new LocalTokens('disposal-failure-secret-at-least-32-characters', () => now.getTime());
  const handler = createHandler(repositories, {decode: async () => { throw new Error('No network'); }}, () => now, {forTenant: tenantId => ({...store.forTenant(tenantId), remove: async () => { throw new Error('storage unavailable'); }})});
  const response = await handler({method: 'POST', path: `/documents/${doc.id}/dispose`, body: JSON.stringify({version: 1, confirm: true}), claims: tokens.verify(tokens.issue('userA', 'A'))});
  assert.equal(response.statusCode, 503);
  const pending = (await call('A', 'GET', '/documents/past-retention')).data[0];
  assert.equal(pending.status, 'disposal-pending'); assert.ok(await store.forTenant('A').get(doc.id));
  assert.equal((await call('A', 'GET', `/deals/${deal.id}/documents/${doc.id}/content`)).status, 410);
  assert.equal(repositories.eventsForTest('A').at(-1)!.type, 'document.updated');
  assert.equal((await call('A', 'POST', `/documents/${doc.id}/dispose`, {version: pending.version, confirm: true})).status, 200);
  assert.equal(await store.forTenant('A').get(doc.id), undefined);
});

test('failed disposal transactions never delete unaudited content and can recover after bytes were removed', async () => {
  const {call, create, repositories, store} = await setup(); const deal = await create();
  const doc = (await call('A', 'POST', `/deals/${deal.id}/documents`, upload)).data;
  const tokens = new LocalTokens('disposal-transaction-secret-at-least-32-characters', () => now.getTime());
  const {conflict} = await import('../src/errors.js');
  let failFinal = false;
  const failing = {forTenant: (tenant: string) => {
    const repo = repositories.forTenant(tenant);
    return {...repo, crmWrite: async (...args: Parameters<typeof repo.crmWrite>) => {
      if (!failFinal || args[0][0].record.kind === 'document' && args[0][0].record.status === 'disposed') throw conflict();
      return repo.crmWrite(...args);
    }};
  }};
  const handler = createHandler(failing, {decode: async () => { throw new Error('No network'); }}, () => now, store);
  const request = {method: 'POST', path: `/documents/${doc.id}/dispose`, body: JSON.stringify({version: 1, confirm: true}), claims: tokens.verify(tokens.issue('userA', 'A'))};
  const before = repositories.eventsForTest('A');
  assert.equal((await handler(request)).statusCode, 409);
  assert.ok(await store.forTenant('A').get(doc.id)); assert.deepEqual(repositories.eventsForTest('A'), before);
  failFinal = true;
  assert.equal((await handler(request)).statusCode, 409);
  assert.equal(await store.forTenant('A').get(doc.id), undefined);
  const pending = (await call('A', 'GET', '/documents/past-retention')).data[0]; assert.equal(pending.status, 'disposal-pending');
  assert.equal((await call('A', 'POST', request.path, {version: pending.version, confirm: true})).status, 200);
  assert.equal(repositories.eventsForTest('A').filter(e => e.type === 'document.disposed').length, 1);
});

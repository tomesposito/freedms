import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type DealView } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler, type ApiRequest } from '../src/handler.js';
import { LocalTokens } from '../src/auth.js';
import { MemoryDocumentStore } from '../src/document-store.js';
const now = new Date('2026-10-23T12:00:00Z');
async function setup() {
  const repositories = new MemoryRepositories(), tokens = new LocalTokens('fi-test-secret-at-least-32-characters', () => now.getTime());
  for (const tenantId of ['A', 'B', 'S']) await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: now.toISOString()}, {id: `user${tenantId}`, name: tenantId}, {tenantId, userId: `user${tenantId}`, role: tenantId === 'S' ? 'staff' : 'admin', active: true}, {id: 'provision', tenantId, actorId: `user${tenantId}`, aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  const handler = createHandler(repositories, {decode: async () => { throw new Error('No network'); }}, () => now, new MemoryDocumentStore());
  const raw = (tenant: string, method = 'GET', path = '/fi-products', body?: unknown, query?: ApiRequest['query']) => handler({method, path, body: body === undefined ? undefined : JSON.stringify(body), query, claims: tokens.verify(tokens.issue(`user${tenant}`, tenant))});
  const call = async (...args: Parameters<typeof raw>) => { const r = await raw(...args); return {status: r.statusCode, ...JSON.parse(r.body)}; };
  const createDeal = async (tenant = 'A'): Promise<DealView> => {
    const v = (await call(tenant, 'POST', '/vehicles', {mileage: null, stockNumber: 'test', vin: '1HGCM82633A004352', year: 2003, make: 'Test', model: 'Test', trim: '', status: 'available', listPrice: 1000000, cost: 700000, reconCosts: [{description: 'Repair', amount: 50000}], dateStocked: '2026-10-19', location: '', notes: ''})).data;
    const lead = (await call(tenant, 'POST', '/leads', {customer: {name: 'Buyer', phone: '', email: '', address: '', notes: '', consent: {status: 'unknown', timestamp: null, source: ''}}, source: 'walk-in', vehicleId: v.id})).data.lead;
    return (await call(tenant, 'POST', '/deals', {vehicleId: v.id, customerId: lead.customerId, type: 'finance'})).data;
  };
  return {repositories, handler, call, raw, createDeal};
}
const base = '/compliance/privacy-requests';
const dueDate = '2026-11-23';
test('Privacy access exports exact customer, leads, deals and document metadata; deletion preserves sold financial records', async () => {
  const {call, createDeal, repositories} = await setup();
  let d = await createDeal(); await createDeal(); await createDeal('B');
  const repo = repositories.forTenant('A');
  const customer = (await call('A', 'GET', `/customers/${d.customerId}`)).data;
  await call('A', 'PUT', `/customers/${d.customerId}`, {...Object.fromEntries(['name', 'phone', 'email', 'address', 'notes', 'consent', 'version'].map(k => [k, customer[k]])), phone: '555-123-4567', email: 'buyer@example.test', address: '12 Main St', notes: 'Private notes', consent: {status: 'granted', timestamp: now.toISOString(), source: 'Buyer signature'}});
  for (const status of ['approved', 'sold']) d = (await call('A', 'PUT', `/deals/${d.id}`, {version: d.version, status})).data;
  assert.equal((await call('A', 'POST', `/deals/${d.id}/documents`, {name: 'ID.txt', type: 'id', content: Buffer.from('Local ID example').toString('base64')})).status, 201);
  const before = {deal: await repo.crmGet('deal', d.id), journal: await repo.crmList('journal-entry'), documents: await repo.crmList('document'), jacket: (await call('A', 'GET', `/deals/${d.id}/jacket`)).data};
  assert.ok(before.journal.length);
  const received = (await call('A', 'POST', base, {customerId: d.customerId, type: 'access', dueDate})).data;
  assert.equal(received.receivedBy, 'userA'); assert.equal(received.receivedAt, now.toISOString());
  const path = `${base}/${received.id}`;
  assert.equal((await call('A', 'PUT', path, {version: 1, status: 'in_progress'})).status, 200);
  const fulfilled = await call('A', 'PUT', path, {version: 2, status: 'fulfilled'}); assert.equal(fulfilled.status, 200);
  const output = fulfilled.data.export;
  assert.deepEqual(output.customer, await repo.crmGet('customer', d.customerId));
  assert.deepEqual(output.leads, (await repo.crmList('lead')).filter(l => l.customerId === d.customerId));
  assert.deepEqual(output.deals, [before.deal]); assert.deepEqual(output.documents, before.documents);
  assert.equal(output.generatedBy, 'userA'); assert.equal(output.requestId, received.id);
  assert.deepEqual(fulfilled.data.request.history.map((s: {action: string}) => s.action), ['received', 'in_progress', 'fulfilled']);
  assert.match(fulfilled.data.request.history[2].note, /1 leads, 1 deals, 1 document/);
  const deletion = (await call('A', 'POST', base, {customerId: d.customerId, type: 'deletion', dueDate})).data;
  const erased = await call('A', 'PUT', `${base}/${deletion.id}`, {version: 1, status: 'fulfilled'}); assert.equal(erased.status, 200);
  assert.equal(erased.data.export, undefined); assert.equal(erased.data.request.fulfilledBy, 'userA');
  const anonymized = (await call('A', 'GET', `/customers/${d.customerId}`)).data;
  assert.equal(anonymized.name, 'Anonymized customer');
  for (const field of ['email', 'phone', 'address', 'notes']) assert.equal(anonymized[field], '');
  assert.deepEqual(anonymized.consent, {status: 'unknown', timestamp: null, source: ''});
  assert.equal((await call('A', 'GET', '/leads')).data.find((l: {customerId: string}) => l.customerId === d.customerId).customer.name, 'Anonymized customer');
  assert.deepEqual(await repo.crmGet('deal', d.id), before.deal); assert.deepEqual(await repo.crmList('journal-entry'), before.journal); assert.deepEqual(await repo.crmList('document'), before.documents);
  const jacket = (await call('A', 'GET', `/deals/${d.id}/jacket`)).data;
  assert.deepEqual(jacket.numbers, before.jacket.numbers); assert.equal(jacket.deal.status, 'sold');
  for (const entry of before.journal) assert.equal(entry.lines.reduce((s, l) => s + l.debit, 0), entry.lines.reduce((s, l) => s + l.credit, 0));
  const audit = (await call('A', 'GET', '/compliance/audit')).data;
  for (const action of ['privacy-request.received', 'privacy-request.in_progress', 'privacy-request.fulfilled', 'customer.anonymized']) {
    const rows = audit.filter((e: {action: string}) => e.action === action); assert.ok(rows.length);
    assert.ok(rows.every((e: {actorId: string; occurredAt: string}) => e.actorId === 'userA' && e.occurredAt === now.toISOString()));
  }
});
test('Privacy validates input, authenticates actors, denies with reason, rejects terminal and stale transitions', async () => {
  const {call, createDeal, repositories, handler} = await setup(), d = await createDeal();
  assert.deepEqual((await call('A', 'GET', base)).data, []);
  const input = {customerId: d.customerId, type: 'access', dueDate};
  for (const patch of [{dueDate: '2026-02-30'}, {dueDate: ''}, {type: 'bad'}, {receivedBy: 'fake'}, {tenantId: 'B'}, {status: 'fulfilled'}]) assert.equal((await call('A', 'POST', base, {...input, ...patch})).status, 400);
  const r = (await call('A', 'POST', base, input)).data, path = `${base}/${r.id}`;
  const events = repositories.eventsForTest('A');
  for (const patch of [{status: 'received'}, {status: 'bad'}, {status: 'denied'}, {status: 'denied', denialReason: '  '}, {status: 'fulfilled', fulfilledBy: 'fake'}, {status: 'in_progress', denialReason: 'ignored'}]) assert.equal((await call('A', 'PUT', path, {version: 1, ...patch})).status, 400);
  assert.deepEqual(repositories.eventsForTest('A'), events);
  assert.equal((await call('A', 'PUT', path, {version: 9, status: 'fulfilled'})).status, 409);
  const denied = (await call('A', 'PUT', path, {version: 1, status: 'denied', denialReason: 'Identity could not be confirmed'})).data.request;
  assert.equal(denied.deniedBy, 'userA'); assert.equal(denied.deniedAt, now.toISOString()); assert.equal(denied.history[1].note, denied.denialReason);
  for (const status of ['received', 'in_progress', 'fulfilled', 'denied']) assert.equal((await call('A', 'PUT', path, {version: 2, status})).status, 400);
  const access = (await call('A', 'POST', base, input)).data;
  await call('A', 'PUT', `${base}/${access.id}`, {version: 1, status: 'fulfilled'});
  assert.equal((await call('A', 'PUT', `${base}/${access.id}`, {version: 2, status: 'in_progress'})).status, 400);
  assert.equal((await handler({method: 'GET', path: base})).statusCode, 401);
  assert.equal((await call('A', 'DELETE', path)).status, 405);
  const staffDeal = await createDeal('S');
  assert.equal((await call('S', 'POST', base, {...input, customerId: staffDeal.customerId})).status, 201);
});
test('Privacy and audit isolate tenants even under actor, target, type, search and tenant filter manipulation', async () => {
  const {call, createDeal, repositories} = await setup(), a = await createDeal(), b = await createDeal('B');
  const r = (await call('A', 'POST', base, {customerId: a.customerId, type: 'deletion', dueDate})).data;
  const other = (await call('B', 'POST', base, {customerId: b.customerId, type: 'access', dueDate})).data;
  assert.deepEqual((await call('B', 'GET', base)).data, [other]);
  assert.equal((await call('B', 'POST', base, {customerId: a.customerId, type: 'access', dueDate})).status, 404);
  for (const method of ['GET', 'PUT']) assert.equal((await call('B', method, `${base}/${r.id}`, {version: 1, status: 'fulfilled'})).status, 404);
  for (const query of [{actor: 'userA'}, {target: r.id}, {type: 'privacy-request'}, {search: r.id}, {search: 'userA'}, {type: 'tenant.created'}, {actor: 'userA', target: r.id, type: 'privacy-request', search: 'A'}]) {
    const rows = (await call('B', 'GET', '/compliance/audit', undefined, query)).data;
    assert.ok(rows.every((e: {tenantId: string}) => e.tenantId === 'B'));
    if (query.actor || query.target || query.search) assert.deepEqual(rows, []);
  }
  assert.equal((await call('B', 'GET', '/compliance/audit', undefined, {tenantId: 'A'})).status, 400);
  assert.equal((await call('S', 'GET', '/compliance/audit')).status, 403);
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await call('A', method, '/compliance/audit', {})).status, 405);
  const event = repositories.eventsForTest('A').find(e => e.aggregateId === r.id)!;
  await assert.rejects(repositories.forTenant('B').crmWrite([{record: r, expectedVersion: 0, event}]), /scope/);
  assert.equal(await repositories.forTenant('B').crmGet('privacy-request', r.id), undefined);
});
test('Concurrent deletion fulfilment commits only one transition and anonymization event', async () => {
  const {call, createDeal, repositories} = await setup(), d = await createDeal();
  const r = (await call('A', 'POST', base, {customerId: d.customerId, type: 'deletion', dueDate})).data;
  const results = await Promise.all([1, 2].map(() => call('A', 'PUT', `${base}/${r.id}`, {version: 1, status: 'fulfilled'})));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(repositories.eventsForTest('A').filter(e => e.action === 'customer.anonymized').length, 1);
});
test('Audit reads actual settings, membership, disposal and compliance mutations', async () => {
  const {call, createDeal} = await setup(), d = await createDeal();
  assert.equal((await call('A', 'PUT', '/settings', {version: 0, taxRateBps: 0, taxTradeDifference: false, docFee: 0})).status, 200);
  assert.equal((await call('A', 'POST', `/deals/${d.id}/compliance`, {documentInspected: {}})).status, 201);
  const doc = (await call('A', 'POST', `/deals/${d.id}/documents`, {name: 'Demo.txt', type: 'id', content: Buffer.from('demo').toString('base64')})).data;
  assert.equal((await call('A', 'POST', `/documents/${doc.id}/dispose`, {version: 1, confirm: true})).status, 200);
  assert.equal((await call('A', 'POST', '/admin/users', {name: 'Staff member', email: 'staff@example.test', role: 'staff'})).status, 201);
  for (const type of ['settings.created', 'compliance.created', 'document.disposed', 'user.added']) {
    const events = (await call('A', 'GET', '/compliance/audit', undefined, {type, actor: 'userA'})).data;
    assert.equal(events.length, 1, type); assert.equal(events[0].type, type); assert.equal(events[0].actorId, 'userA');
    assert.deepEqual((await call('B', 'GET', '/compliance/audit', undefined, {type})).data, []);
  }
});

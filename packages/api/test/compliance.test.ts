import { test } from 'node:test';
import assert from 'node:assert/strict';
import { complianceChecklist, type ComplianceCheck, type ComplianceRecord, type DealView, type Principal, type DealDocument } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler, type ApiRequest } from '../src/handler.js';
import { LocalTokens } from '../src/auth.js';
import { compliance } from '../src/compliance.js';
const now = new Date('2026-10-23T12:00:00Z');
const check = {method: 'Dealer consulted list', result: 'clear', checkedDate: '2026-10-22', initials: 'TE', notes: ''};
async function setup() {
  const repositories = new MemoryRepositories(), tokens = new LocalTokens('fi-test-secret-at-least-32-characters', () => now.getTime());
  for (const tenantId of ['A', 'B']) await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: now.toISOString()}, {id: `user${tenantId}`, name: tenantId}, {tenantId, userId: `user${tenantId}`, role: 'staff', active: true}, {id: 'provision', tenantId, actorId: `user${tenantId}`, aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  const handler = createHandler(repositories, {decode: async () => { throw new Error('No network'); }}, () => now);
  const raw = (tenant: string, method = 'GET', path = '/fi-products', body?: unknown, query?: ApiRequest['query']) => handler({method, path, body: body === undefined ? undefined : JSON.stringify(body), query, claims: tokens.verify(tokens.issue(`user${tenant}`, tenant))});
  const call = async (...args: Parameters<typeof raw>) => { const r = await raw(...args); return {status: r.statusCode, ...JSON.parse(r.body)}; };
  const createDeal = async (tenant = 'A'): Promise<DealView> => {
    const v = (await call(tenant, 'POST', '/vehicles', {mileage: null, stockNumber: 'test', vin: '1HGCM82633A004352', year: 2003, make: 'Test', model: 'Test', trim: '', status: 'available', listPrice: 1000000, cost: 700000, reconCosts: [{description: 'Repair', amount: 50000}], dateStocked: '2026-10-19', location: '', notes: ''})).data;
    const lead = (await call(tenant, 'POST', '/leads', {customer: {name: 'Buyer', phone: '', email: '', address: '', notes: '', consent: {status: 'unknown', timestamp: null, source: ''}}, source: 'walk-in', vehicleId: v.id})).data.lead;
    return (await call(tenant, 'POST', '/deals', {vehicleId: v.id, customerId: lead.customerId, type: 'finance'})).data;
  };
  return {repositories, handler, call, raw, createDeal};
}
test('Compliance attestations create, update, clear, validate and emit server-authored events', async () => {
  const {call, createDeal, repositories} = await setup(), d = await createDeal(), path = `/deals/${d.id}/compliance`;
  const empty = await call('A', 'GET', path); assert.equal(empty.status, 200); assert.equal(empty.data.record, null); assert.equal(empty.data.complete, false);
  assert.ok(empty.data.checklist.every((i: {present: boolean}) => !i.present));
  for (const body of [{unknown: true}, {documentInspected: {by: 'fake'}}, {documentInspected: {at: now.toISOString()}}, {documentInspected: 'yes'}, {documentInspected: {note: 'x'.repeat(2001)}}]) assert.equal((await call('A', 'POST', path, body)).status, 400);
  assert.equal((await call('A', 'PUT', path, {version: 1})).status, 404);
  let r = await call('A', 'POST', path, {documentInspected: {note: 'Inspected'}, addressDiscrepancy: {note: 'No discrepancy found'}});
  assert.equal(r.status, 201); assert.equal(r.data.id, d.id); assert.equal(r.data.customerId, d.customerId);
  assert.deepEqual(r.data.documentInspected, {by: 'userA', at: now.toISOString(), note: 'Inspected'});
  assert.equal((await call('A', 'POST', path, {})).status, 400);
  r = await call('A', 'PUT', path, {version: 1, privacyNoticeGiven: {}}); assert.equal(r.status, 200); assert.equal(r.data.documentInspected.note, 'Inspected');
  assert.equal((await call('A', 'PUT', path, {version: 1})).status, 409);
  for (const body of [{version: 2, privacyNoticeGiven: {by: 'fake'}}, {version: 2, extra: true}, {}]) assert.equal((await call('A', 'PUT', path, body)).status, 400);
  r = await call('A', 'PUT', path, {version: 2, documentInspected: null}); assert.equal(r.status, 200); assert.equal(r.data.documentInspected, null);
  assert.deepEqual((await call('A', 'GET', path)).data.record, r.data);
  for (const type of ['compliance.created', 'compliance.updated']) {
    const events = repositories.eventsForTest('A').filter(e => e.type === type); assert.ok(events.length);
    for (const event of events) { assert.equal(event.actorId, 'userA'); assert.equal(event.tenantId, 'A'); assert.equal(event.aggregateId, d.id); assert.equal(event.deliveryStatus, 'pending'); }
  }
});
test('Dealer checks validate dates, enums and fields; immutable log searches and orders real records', async () => {
  const {call, createDeal, repositories} = await setup(), d = await createDeal(), path = `/deals/${d.id}/compliance-checks`;
  for (const patch of [{result: 'bad'}, {checkedDate: '2027-01-01'}, {checkedDate: '2026-02-30'}, {checkedDate: 'bad'}, {method: ''}, {method: undefined}, {initials: ''}, {initials: undefined}, {method: 'x'.repeat(121)}, {initials: 'x'.repeat(11)}, {notes: 'x'.repeat(2001)}, {customerId: 'foreign'}, {performedBy: 'fake'}]) assert.equal((await call('A', 'POST', path, {...check, ...patch})).status, 400, JSON.stringify(patch));
  const first = (await call('A', 'POST', path, check)).data as ComplianceCheck;
  assert.equal(first.customerId, d.customerId); assert.equal(first.customerName, 'Buyer'); assert.equal(first.performedBy, 'userA'); assert.equal(first.performedAt, now.toISOString());
  const latest = (await call('A', 'POST', path, {...check, checkedDate: '2026-10-23', result: 'potential-match'})).data;
  for (const search of ['', 'BUYER', 'consulted', 'te']) { const r = await call('A', 'GET', '/compliance/checks', undefined, {search}); assert.deepEqual(r.data.map((c: ComplianceCheck) => c.id), [latest.id, first.id]); }
  assert.equal((await call('A', 'GET', '/compliance/checks', undefined, {search: 'potential-match'})).data.length, 1);
  assert.deepEqual((await call('A', 'GET', '/compliance/checks', undefined, {search: 'absent'})).data, []);
  assert.deepEqual((await call('A', 'GET', path)).data.map((c: ComplianceCheck) => c.id), [latest.id, first.id]);
  for (const method of ['PUT', 'DELETE']) assert.equal((await call('A', method, path, check)).status, 405);
  const event = repositories.eventsForTest('A').find(e => e.type === 'compliance-check.created')!;
  await assert.rejects(repositories.forTenant('A').crmWrite([{record: {...first, version: 2}, expectedVersion: 1, event}]), /immutable/);
  assert.equal(event.actorId, 'userA'); assert.equal(event.aggregateId, first.id); assert.equal(event.aggregateVersion, 1);
  const item = (await call('A', 'GET', `/deals/${d.id}/compliance`)).data.checklist.find((i: {key: string}) => i.key === 'ofac-check');
  assert.equal(item.present, true); assert.match(item.detail, /2026-10-23 · Potential match · TE/);
});
test('Checklist derives active ID documents, consent and attestations without claiming clearance', () => {
  const consent = {status: 'unknown', timestamp: null, source: ''} as const;
  const doc = {type: 'id', uploadedBy: 'staff', uploadedAt: now.toISOString(), name: 'ID'} as DealDocument;
  const a = {by: 'staff', at: now.toISOString(), note: 'Reviewed'};
  const record = {documentInspected: a, addressDiscrepancy: a, privacyNoticeGiven: a} as ComplianceRecord;
  assert.equal(complianceChecklist(null, [doc], consent, [])[0].source, 'document');
  assert.equal(complianceChecklist(null, [{...doc, status: 'disposed'}], consent, [])[0].present, false);
  assert.equal(complianceChecklist(null, [{...doc, status: 'disposal-pending'}], consent, [])[0].present, false);
  assert.equal(complianceChecklist(record, [], consent, [])[0].source, 'attestation');
  for (const status of ['unknown', 'revoked', 'granted'] as const) {
    const items = complianceChecklist(record, [], {status, timestamp: now.toISOString(), source: 'Signed form'}, [{...check, result: 'match', performedBy: 'staff', performedAt: now.toISOString()} as ComplianceCheck]);
    assert.equal(items.every(i => i.present), status === 'granted');
    if (status === 'granted') { assert.equal(items[4].at, now.toISOString()); assert.equal(items[4].detail, 'Signed form'); }
  }
});
test('Checklist accepts customer-wide checks, deal history stays scoped, and incomplete jackets remain available', async () => {
  const {call, createDeal} = await setup(), d = await createDeal();
  const other = await createDeal();
  // A separate deal for the same customer proves the documented deal-or-customer rule.
  const second = (await call('A', 'POST', '/deals', {vehicleId: other.vehicleId, customerId: d.customerId, type: 'cash'})).data;
  assert.ok(second.id);
  await call('A', 'POST', `/deals/${d.id}/compliance-checks`, check);
  assert.equal((await call('A', 'GET', `/deals/${second.id}/compliance`)).data.checks.length, 1);
  assert.deepEqual((await call('A', 'GET', `/deals/${second.id}/compliance-checks`)).data, []);
  for (const status of ['approved', 'sold']) {
    const current = (await call('A', 'GET', `/deals/${d.id}`)).data;
    assert.equal((await call('A', 'PUT', `/deals/${d.id}`, {version: current.version, status})).status, 200);
    const j = await call('A', 'GET', `/deals/${d.id}/jacket`), view = (await call('A', 'GET', `/deals/${d.id}/compliance`)).data;
    assert.equal(j.status, 200); assert.deepEqual(j.data.compliance.checklist, view.checklist); assert.equal(j.data.compliance.complete, false); assert.equal(j.data.compliance.checks.length, 1);
    assert.ok(j.data.compliance.checklist.some((i: {present: boolean}) => !i.present));
  }
});
test('Compliance endpoints and repositories isolate tenants and enforce authentication and write roles', async () => {
  const {call, createDeal, repositories, handler} = await setup(), d = await createDeal(), path = `/deals/${d.id}/compliance`, checks = `/deals/${d.id}/compliance-checks`;
  const record = (await call('A', 'POST', path, {documentInspected: {}})).data;
  const c = (await call('A', 'POST', checks, check)).data;
  for (const [method, route, body] of [['GET', path, undefined], ['POST', path, {}], ['PUT', path, {version: 1}], ['GET', checks, undefined], ['POST', checks, check], ['GET', `/deals/${d.id}/jacket`, undefined]] as const) assert.equal((await call('B', method, route, body)).status, 404);
  assert.deepEqual((await call('B', 'GET', '/compliance/checks')).data, []);
  for (const r of [record, c]) {
    assert.equal(await repositories.forTenant('B').crmGet(r.kind, r.id), undefined);
    const event = repositories.eventsForTest('A').find(e => e.type === `${r.kind}.created`)!;
    await assert.rejects(repositories.forTenant('B').crmWrite([{record: r, expectedVersion: 0, event}]), /scope/);
    await assert.rejects(repositories.forTenant('A').crmWrite([{record: {...r, tenantId: 'B'}, expectedVersion: 0, event}]), /scope/);
    await assert.rejects(repositories.forTenant('A').crmWrite([{record: r, expectedVersion: 0, event: {...event, tenantId: 'B'}}]), /scope/);
  }
  for (const route of [path, checks, '/compliance/checks']) assert.equal((await handler({method: 'GET', path: route})).statusCode, 401);
  for (const route of [path, checks]) await assert.rejects(compliance({method: 'POST', path: route, body: '{}'}, {tenantId: 'A', userId: 'userA', role: 'reader'} as unknown as Principal, repositories.forTenant('A'), now), {status: 403});
  assert.equal((await call('A', 'DELETE', path)).status, 405);
  assert.equal((await call('A', 'GET', path + '/extra')).status, 404);
  assert.equal((await call('A', 'GET', path, undefined, {extra: 'bad'})).status, 400);
});

test('Complete flag follows live customer consent and clearing attestations', async () => {
  const {call, createDeal} = await setup(), d = await createDeal(), path = `/deals/${d.id}/compliance`;
  await call('A', 'POST', path, {documentInspected: {}, addressDiscrepancy: {note: 'No discrepancy found'}, privacyNoticeGiven: {}});
  const {notes, ...withoutNotes} = check;
  assert.equal((await call('A', 'POST', `/deals/${d.id}/compliance-checks`, withoutNotes)).status, 201);
  for (const status of ['granted', 'revoked', 'unknown'] as const) {
    const customer = (await call('A', 'GET', `/customers/${d.customerId}`)).data;
    const {name, phone, email, address, notes, version} = customer;
    assert.equal((await call('A', 'PUT', `/customers/${d.customerId}`, {name, phone, email, address, notes, version, consent: {status, timestamp: status === 'unknown' ? null : now.toISOString(), source: status === 'unknown' ? '' : 'Signed form'}})).status, 200);
    const view = (await call('A', 'GET', path)).data;
    assert.equal(view.complete, status === 'granted'); assert.equal(view.checklist[4].present, status === 'granted');
  }
});

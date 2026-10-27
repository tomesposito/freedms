import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addOwnershipMonths, ownershipSignals, defaultSettings, defaultLeaseTerms, type CrmEntity, type Deal, type EquityMiningEntry, type Lead, type CustomerTimelineEntry } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { LocalTokens } from '../src/auth.js';
import { createHandler, type ApiRequest } from '../src/handler.js';
const now = new Date('2026-10-19T12:00:00Z');
async function setup() {
  const repositories = new MemoryRepositories(), tokens = new LocalTokens('equity-test-secret-at-least-32-characters', () => now.getTime());
  for (const tenantId of ['A', 'B']) await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: now.toISOString()}, {id: `user${tenantId}`, name: tenantId}, {tenantId, userId: `user${tenantId}`, role: 'staff', active: true}, {id: 'provision', tenantId, actorId: `user${tenantId}`, aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  const handler = createHandler(repositories, {decode: async () => { throw new Error('No network'); }}, () => now);
  const call = async (tenant = 'A', method = 'GET', path = '/equity-mining', body?: unknown, query?: ApiRequest['query']) => {
    const r = await handler({method, path, body: body === undefined ? undefined : JSON.stringify(body), query, claims: tokens.verify(tokens.issue(`user${tenant}`, tenant))});
    return {status: r.statusCode, ...JSON.parse(r.body)};
  };
  const save = async (record: CrmEntity, expectedVersion = 0) => repositories.forTenant(record.tenantId).crmWrite([{record, expectedVersion, event: {id: `${record.id}-${record.version}`, tenantId: record.tenantId, actorId: 'userA', aggregateId: record.id, aggregateVersion: record.version, type: `${record.kind}.${expectedVersion ? 'updated' : 'created'}` as 'lead.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'}}]);
  const makeLead = async (name = 'Jamie', customerId?: string) => (await call('A', 'POST', '/leads', {source: 'walk-in', ...(customerId ? {customerId} : {customer: {name, phone: '', email: '', address: '', notes: '', consent: {status: 'unknown', timestamp: null, source: ''}}})})).data.lead as Lead;
  const lead = await makeLead();
  const vehicle = (await call('A', 'POST', '/vehicles', {mileage: null, stockNumber: 'S1', vin: '1HGCM82633A004352', year: 2016, make: 'Honda', model: 'Civic', trim: '', status: 'available', listPrice: 1200000, cost: 500000, reconCosts: [], dateStocked: '2020-01-01', location: '', notes: ''})).data;
  const deal = async (id: string, overrides: Partial<Deal> = {}) => {
    const record: Deal = {id, tenantId: 'A', version: 1, createdAt: now.toISOString(), updatedAt: '2023-01-31T12:00:00.000Z', kind: 'deal', vehicleId: vehicle.id, customerId: lead.customerId, leadId: lead.id, type: 'finance', trade: null, pencils: [{type: 'finance' as const, id: 'p', name: 'Working', price: 1200000, down: 0, term: 60, aprBps: 0, lease: null, fiSelections: []}], workingPencilId: 'p', status: 'sold', history: [{status: 'sold', actorId: 'userA', timestamp: '2023-01-31T12:00:00.000Z'}], ...defaultSettings, ...overrides};
    await save(record); return record;
  };
  return {call, repositories, save, lead, makeLead, deal};
}
test('mining is explainable, deterministic, searchable, read-only and tenant scoped', async () => {
  const {call, repositories, deal, makeLead} = await setup();
  await deal('z'); await deal('a');
  const other = await makeLead('Aaron'); await deal('other', {customerId: other.customerId, leadId: other.id});
  for (const status of ['working', 'approved', 'dead'] as const) await deal(status, {status});
  await deal('recent-cash', {type: 'cash', history: [], updatedAt: '2026-10-01T12:00:00.000Z'});
  const before = repositories.eventsForTest('A').length;
  const rows: EquityMiningEntry[] = (await call()).data;
  assert.deepEqual(rows.map(r => r.dealId), ['other', 'a', 'z']);
  for (const r of rows) {
    assert.equal(r.monthsOwned, 44); assert.equal(r.vehicleAgeYears, 10); assert.equal(r.estimatedPayoffCents, 320000);
    assert.equal(r.remainingPayments, 16); assert.equal(r.saleNetEquityCents, r.tradeAllowance - r.tradePayoff); assert.equal(r.mileageBand, null);
    assert.deepEqual(r.reasons, [`Owned ${r.monthsOwned} whole months since ${r.saleDate}: ownership trade window starts at 35 months.`, `Vehicle is ${r.vehicleAgeYears} years old and owned ${r.monthsOwned} months (thresholds: 8 years and 24 months).`]);
  }
  assert.equal(repositories.eventsForTest('A').length, before);
  assert.equal((await call('A', 'GET', '/equity-mining', undefined, {search: 'jAM'})).data.length, 2);
  assert.equal((await call('A', 'GET', '/equity-mining', undefined, {tenantId: 'B'})).status, 400);
  assert.deepEqual((await call('B')).data, []);
});
test('finance interest amortizes in cents; ended terms clear rounding, lease retains purchase option', async () => {
  const {call, deal} = await setup();
  const base = await deal('base');
  await deal('interest', {pencils: [{...base.pencils[0], aprBps: 600}], history: [], updatedAt: '2026-09-19T12:00:00.000Z'});
  const interest = ownershipSignals({...base, history: [], updatedAt: '2026-09-19T12:00:00.000Z', pencils: [{...base.pencils[0], aprBps: 600}]}, undefined, now);
  assert.equal(interest.estimatedPayoffCents, 1182801); assert.equal(interest.monthsOwned, 1);
  // One month does not meet any flag rule, even though a loan exists.
  assert.equal((await call()).data.some((r: EquityMiningEntry) => r.dealId === 'interest'), false);
  await deal('ended', {pencils: [{...base.pencils[0], term: 36, aprBps: 600}]});
  await deal('lease', {type: 'lease', pencils: [{...base.pencils[0], type: 'lease', term: 36, lease: {...defaultLeaseTerms(1200000), residualAmount: 600000, residualPercentBps: 5000}}]});
  const rows: EquityMiningEntry[] = (await call()).data;
  assert.equal(rows.find(r => r.dealId === 'ended')!.estimatedPayoffCents, 0);
  const lease = rows.find(r => r.dealId === 'lease')!; assert.equal(lease.estimatedPayoffCents, 600000); assert.match(lease.payoffBasis, /purchase option/); assert.match(lease.reasons[1], /Lease term of 36/);
});
test('generation clamps UTC dates, writes events, skips missing leads and never recreates done/dismissed tasks', async () => {
  const {call, deal, lead, repositories} = await setup(); await deal('sale'); await deal('orphan', {customerId: 'no-leads', leadId: null});
  assert.equal(addOwnershipMonths('2024-01-31T09:00:00.000Z', 1), '2024-02-29T09:00:00.000Z');
  assert.equal(addOwnershipMonths('2023-01-31T09:00:00.000Z', 1), '2023-02-28T09:00:00.000Z');
  assert.deepEqual((await call('B', 'POST', '/ownership-cycle/generate', {})).data, {created: 0, skippedDeals: 0, leadsUpdated: 0});
  assert.equal((await repositories.forTenant('A').crmGet('lead', lead.id))!.version, 1);
  assert.deepEqual((await call('A', 'POST', '/ownership-cycle/generate', {})).data, {created: 2, skippedDeals: 1, leadsUpdated: 1});
  let l = (await call('A', 'GET', `/leads/${lead.id}`)).data as Lead;
  assert.deepEqual(l.followUps.map(t => [t.type, t.dueAt, t.cycleKey]), [['visit', '2023-12-31T12:00:00.000Z', 'ownership:sale:service-11'], ['call', '2025-12-31T12:00:00.000Z', 'ownership:sale:trade-35']]);
  await call('A', 'PUT', `/leads/${l.id}/follow-ups/${l.followUps[0].id}`, {version: 2, done: true});
  await call('A', 'PUT', `/leads/${l.id}/follow-ups/${l.followUps[1].id}`, {version: 3, dismissed: true});
  assert.deepEqual((await call('A', 'POST', '/ownership-cycle/generate', {})).data, {created: 0, skippedDeals: 1, leadsUpdated: 0});
  l = (await call('A', 'GET', `/leads/${lead.id}`)).data; assert.equal(l.followUps.length, 2);
  assert.equal(repositories.eventsForTest('A').at(-1)!.type, 'lead.updated');
  assert.ok(repositories.eventsForTest('A').every(e => !('summary' in e) && !('name' in e)));
  assert.equal((await call('A', 'POST', '/ownership-cycle/generate', {extra: true})).status, 400);
});
test('generation chooses most recent customer lead and respects task/activity/byte limits', async () => {
  for (const limit of ['tasks', 'activities', 'bytes']) {
    const {call, deal, makeLead, lead, save, repositories} = await setup();
    const second = await makeLead('unused', lead.customerId); second.createdAt = '2026-10-20T00:00:00Z';
    second.version++; await save(second, 1);
    await deal('fallback', {leadId: 'missing'});
    const full = (await repositories.forTenant('A').crmGet('lead', second.id))!;
    if (limit === 'tasks') full.followUps = Array.from({length: 200}, (_, i) => ({id: `t${i}`, type: 'call', done: false, dueAt: now.toISOString()}));
    if (limit === 'activities') full.activities = Array.from({length: 400}, (_, i) => ({id: `a${i}`, kind: 'stage', actorId: 'userA', timestamp: now.toISOString(), summary: 'History'}));
    if (limit === 'bytes') full.vehicleDescription = 'x'.repeat(250000);
    full.version++; await save(full, 2);
    assert.deepEqual((await call('A', 'POST', '/ownership-cycle/generate', {})).data, {created: 0, skippedDeals: 1, leadsUpdated: 0});
    assert.equal((await repositories.forTenant('A').crmGet('lead', lead.id))!.followUps.length, 0);
  }
});
test('snooze/dismiss log history, control overdue, validate actions and isolate tenants', async () => {
  const {call, lead} = await setup();
  const path = `/leads/${lead.id}/follow-ups`;
  const created = await call('A', 'POST', path, {version: 1, type: 'visit', dueAt: '2020-01-01T00:00:00Z'});
  const taskPath = `${path}/${created.data.followUps[0].id}`;
  for (const b of [{}, {done: true, dismissed: true}, {dueAt: now.toISOString(), done: false}, {dismissed: 'yes'}, {dueAt: 'bad'}]) assert.equal((await call('A', 'PUT', taskPath, {version: 2, ...b})).status, 400);
  const snoozed = await call('A', 'PUT', taskPath, {version: 2, dueAt: '2020-01-31T00:00:00Z'});
  assert.match(snoozed.data.activities.at(-1).summary, /Snoozed visit: .* → /);
  assert.equal(snoozed.data.followUps[0].dueAt, '2020-01-31T00:00:00.000Z');
  assert.equal((await call('A', 'PUT', taskPath, {version: 3, dismissed: true})).data.overdue, false);
  assert.equal((await call('A', 'GET', '/leads')).data[0].overdue, false);
  assert.equal((await call('A', 'PUT', taskPath, {version: 4, dismissed: false})).data.overdue, true);
  assert.equal((await call('B', 'PUT', taskPath, {version: 5, dismissed: true})).status, 404);
  assert.equal((await call('A', 'PUT', taskPath, {version: 4, done: true})).status, 409);
});
test('customer timeline combines multiple leads and deals, preserves communications and isolates customers/tenants', async () => {
  const {call, lead, makeLead, deal} = await setup();
  const second = await makeLead('unused', lead.customerId), other = await makeLead('Other');
  await call('A', 'POST', `/leads/${second.id}/communications`, {version: 1, type: 'visit', direction: 'inbound', summary: 'Service visit', timestamp: '2026-09-01T00:00:00Z'});
  await deal('sale'); await deal('second-sale', {leadId: second.id}); await deal('other-sale', {customerId: other.customerId, leadId: other.id});
  const customer = (await call('A', 'GET', `/customers/${lead.customerId}`)).data;
  const timeline = customer.timeline as CustomerTimelineEntry[];
  assert.equal(customer.communications.length, 1); assert.equal(timeline.length, 5);
  assert.ok(timeline.some(a => a.kind === 'communication' && a.leadId === second.id)); assert.ok(timeline.some(a => a.kind === 'stage' && a.leadId === lead.id));
  assert.equal(timeline.filter(a => a.kind === 'deal').length, 2);
  assert.ok(timeline.every(a => a.leadId !== other.id && a.dealId !== 'other-sale'));
  assert.deepEqual(timeline.map(a => a.timestamp), timeline.map(a => a.timestamp).sort().reverse());
  assert.equal((await call('B', 'GET', `/customers/${lead.customerId}`)).status, 404);
});

test('fallback generation coalesces deals on a lead and concurrent re-runs cannot duplicate tasks', async () => {
  const {call, deal, makeLead, lead, save, repositories} = await setup();
  const recent = await makeLead('unused', lead.customerId); recent.createdAt = '2026-10-20T00:00:00Z'; recent.version++; await save(recent, 1);
  await deal('one', {leadId: null}); await deal('two', {leadId: 'foreign-lead'});
  const results = await Promise.all([1, 2].map(() => call('A', 'POST', '/ownership-cycle/generate', {})));
  assert.ok(results.some(r => r.status === 200)); assert.ok(results.every(r => [200, 409].includes(r.status)));
  assert.equal((await call('A', 'POST', '/ownership-cycle/generate', {})).data.created, 0);
  assert.equal((await repositories.forTenant('A').crmGet('lead', recent.id))!.followUps.length, 4);
  assert.equal((await repositories.forTenant('A').crmGet('lead', lead.id))!.followUps.length, 0);
  assert.deepEqual((await call('B', 'GET', '/leads')).data, []);
});

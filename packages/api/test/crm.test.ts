import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultSettings, isOverdue, type CustomerInput, type Lead } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler, type ApiRequest } from '../src/handler.js';
import { LocalTokens } from '../src/auth.js';
import { parseAdf } from '../src/adf.js';
const now = new Date('2026-10-19T12:00:00Z');
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.adf.xml`, import.meta.url), 'utf8');
const customer: CustomerInput = {name: 'Jamie Rivera', phone: '5551234567', email: 'jamie@example.test', address: 'Test address', consent: {status: 'unknown', timestamp: null, source: ''}, notes: ''};
async function setup(role: 'admin' | 'staff' = 'admin', active = true) {
  const repositories = new MemoryRepositories(); const tokens = new LocalTokens('crm-test-secret-at-least-32-characters', () => now.getTime());
  for (const tenantId of ['A', 'B']) await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: now.toISOString()}, {id: `user${tenantId}`, name: `User ${tenantId}`}, {tenantId, userId: `user${tenantId}`, role, active}, {id: 'provision', tenantId, actorId: `user${tenantId}`, aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  const handler = createHandler(repositories, {decode: async () => { throw new Error('No network'); }}, () => now);
  const call = async (tenant: string, method = 'GET', path = '/leads', body?: unknown, query?: ApiRequest['query']) => {
    const result = await handler({method, path, body: body === undefined ? undefined : JSON.stringify(body), query, claims: tokens.verify(tokens.issue(`user${tenant}`, tenant))});
    return {status: result.statusCode, ...JSON.parse(result.body)};
  };
  const intake = async (token: string, xml: string, query?: ApiRequest['query']) => { const r = await handler({method: 'POST', path: '/intake/adf', intakeToken: token, body: xml, query}); return {status: r.statusCode, ...JSON.parse(r.body)}; };
  const makeLead = async (tenant = 'A', overrides = {}) => (await call(tenant, 'POST', '/leads', {customer, source: 'walk-in', ...overrides})).data.lead as Lead;
  return {repositories, handler, call, intake, makeLead};
}
test('CRM starts empty; manual create is atomic, duplicates warn within tenant, existing customers can be picked', async () => {
  const {call, repositories, makeLead} = await setup(); assert.deepEqual((await call('A')).data, []); assert.deepEqual((await call('A', 'GET', '/customers')).data, []);
  const lead = await makeLead();
  const duplicate = await call('A', 'POST', '/customers', {...customer, phone: '+1 (555) 123-4567', email: ''});
  assert.deepEqual(duplicate.data.duplicateCustomerIds, [lead.customerId]); assert.equal(duplicate.status, 201);
  assert.deepEqual((await call('B', 'POST', '/customers', customer)).data.duplicateCustomerIds, []);
  const picked = await call('A', 'POST', '/leads', {customerId: lead.customerId, source: 'phone'}); assert.equal(picked.status, 201);
  const events = repositories.eventsForTest('A'); assert.deepEqual(events.map(e => e.type), ['tenant.created', 'customer.created', 'lead.created', 'customer.created', 'lead.created']);
  assert.ok(events.every(e => e.actorId === 'userA' && !('email' in e) && !('summary' in e)));
});
test('pipeline stage history, assignment filters, customer search and optimistic conflicts', async () => {
  const {call, makeLead, repositories} = await setup(); const lead = await makeLead();
  let version = 1;
  for (const stage of ['contacted', 'appointment', 'in-store', 'working-deal', 'sold', 'lost']) {
    const result = await call('A', 'PUT', `/leads/${lead.id}`, {version, stage, assigneeId: 'userA', vehicleId: null});
    assert.equal(result.status, 200); assert.equal(result.data.activities.filter((a: {kind: string}) => a.kind === 'stage').length, version + 1); version++;
    assert.equal(result.data.activities.at(-1).actorId, 'userA'); assert.equal(result.data.activities.at(-1).timestamp, now.toISOString());
  }
  assert.equal((await call('A', 'GET', '/leads', undefined, {stage: 'lost', assignee: 'userA', search: 'JAMIE'})).data.length, 1);
  assert.equal((await call('A', 'GET', '/leads', undefined, {assignee: 'unassigned'})).data.length, 0);
  const count = repositories.eventsForTest('A').length;
  assert.equal((await call('A', 'PUT', `/leads/${lead.id}`, {version: 1, stage: 'new'})).status, 409);
  assert.equal(repositories.eventsForTest('A').length, count);
  const concurrent = await Promise.all([1, 2].map(() => call('A', 'PUT', `/leads/${lead.id}`, {version, stage: 'new', assigneeId: null, vehicleId: null})));
  assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409]);
});
test('follow-ups flag overdue until completed; communication appears on customer and lead', async () => {
  const {call, makeLead} = await setup(); const lead = await makeLead();
  const scheduled = await call('A', 'POST', `/leads/${lead.id}/follow-ups`, {version: 1, type: 'call', dueAt: '2026-10-18T10:00:00Z'});
  assert.equal(scheduled.status, 200); assert.equal(scheduled.data.overdue, true);
  assert.equal((await call('A')).data[0].overdue, true);
  const task = scheduled.data.followUps[0];
  assert.equal(isOverdue({...task, dueAt: now.toISOString()}, now), false);
  assert.equal(isOverdue({...task, dueAt: '2026-10-20T00:00:00Z'}, now), false);
  const done = await call('A', 'PUT', `/leads/${lead.id}/follow-ups/${task.id}`, {version: 2, done: true}); assert.equal(done.data.overdue, false);
  const comm = await call('A', 'POST', `/leads/${lead.id}/communications`, {version: 3, type: 'phone', direction: 'outbound', summary: 'Called', timestamp: now.toISOString()}); assert.equal(comm.status, 400);
  const logged = await call('A', 'POST', `/leads/${lead.id}/communications`, {version: 3, type: 'call', direction: 'outbound', summary: 'Discussed appointment', timestamp: now.toISOString()});
  assert.equal(logged.status, 200); assert.equal(logged.data.activities.at(-1).summary, 'Discussed appointment');
  const record = (await call('A', 'GET', `/customers/${lead.customerId}`)).data;
  assert.equal(record.communications.length, 1); assert.equal(record.communications[0].leadId, lead.id);
});
test('tenant B cannot read or mutate A customers, leads, follow-ups or communications', async () => {
  const {call, makeLead, repositories} = await setup(); const lead = await makeLead();
  const updated = await call('A', 'POST', `/leads/${lead.id}/follow-ups`, {version: 1, type: 'email', dueAt: now.toISOString()}); const taskId = updated.data.followUps[0].id;
  for (const [method, path, body] of [
    ['GET', `/leads/${lead.id}`, undefined], ['PUT', `/leads/${lead.id}`, {version: 2, stage: 'lost'}],
    ['GET', `/customers/${lead.customerId}`, undefined], ['PUT', `/customers/${lead.customerId}`, {...customer, version: 1}],
    ['POST', `/leads/${lead.id}/follow-ups`, {version: 2, type: 'call', dueAt: now.toISOString()}],
    ['PUT', `/leads/${lead.id}/follow-ups/${taskId}`, {version: 2, done: true}],
    ['POST', `/leads/${lead.id}/communications`, {version: 2, type: 'call'}]
  ] as const) assert.equal((await call('B', method, path, body)).status, 404, path);
  assert.deepEqual((await call('B')).data, []);
  assert.equal((await call('B', 'POST', '/leads', {customerId: lead.customerId, source: 'other'})).status, 404);
  assert.equal((await call('A', 'PUT', `/leads/${lead.id}`, {version: 2, stage: 'new', assigneeId: 'userB'})).status, 400);
  assert.equal((await call('B', 'GET', '/customers', undefined, {tenantId: 'A'})).status, 400);
  assert.equal(repositories.eventsForTest('B').length, 1);
});
test('invalid fields and foreign references write no customer, lead or outbox event', async () => {
  const {call, repositories} = await setup();
  for (const bad of [{source: 'fake'}, {tenantId: 'B'}, {vehicleId: 'foreign'}, {assigneeId: 'userB'}, {customer: {...customer, consent: {status: 'granted', timestamp: null, source: 'form'}}}, {customer: {...customer, email: 'invalid'}}]) {
    assert.equal((await call('A', 'POST', '/leads', {customer, source: 'other', ...bad})).status, 400);
  }
  assert.deepEqual((await call('A', 'GET', '/customers')).data, []); assert.equal(repositories.eventsForTest('A').length, 1);
});
test('ADF fixture parsing preserves contact, address, notes, vehicle and provider without inferring consent', () => {
  const parsed = parseAdf(fixture('website')); const c = parsed.input.customer;
  assert.equal(c.name, 'Jamie Rivera'); assert.equal(c.email, 'jamie@example.test'); assert.equal(c.phone, '(555) 123-4567');
  assert.equal(c.address, '12 Test Lane, Testville, CA, 90001, US'); assert.match(c.notes, /visit & trade/);
  assert.equal(c.consent.status, 'unknown'); assert.equal(parsed.vin, '1HGCM82633A004352'); assert.equal(parsed.stockNumber, 'H123');
  assert.equal(parsed.input.sourceDetail, 'Dealer Website / Contact form / Independent Motors');
  const second = parseAdf(fixture('referral')); assert.equal(second.input.customer.name, 'Sam & Alex Test'); assert.equal(second.input.customer.phone, '5550000002');
});
test('intake authenticates independently, resolves only token tenant, links inventory, and rotates credentials', async () => {
  const {call, intake, repositories} = await setup();
  const v = (await call('A', 'POST', '/vehicles', {mileage: null, stockNumber: 'H123', vin: '1HGCM82633A004352', year: 2003, make: 'Honda', model: 'Accord', trim: '', status: 'available', listPrice: 0, cost: 0, reconCosts: [], dateStocked: '2026-10-19', location: '', notes: ''})).data;
  const tokenA = (await call('A', 'POST', '/intake-token', {})).data.token; const tokenB = (await call('B', 'POST', '/intake-token', {})).data.token;
  const first = await intake(tokenA, fixture('website')); assert.equal(first.status, 201); assert.equal(first.data.lead.vehicleId, v.id); assert.equal(first.data.lead.tenantId, 'A');
  assert.ok(repositories.eventsForTest('A').slice(-2).every(e => e.actorId === 'intake'));
  const before = repositories.eventsForTest('A').length;
  assert.equal((await intake(tokenB, fixture('website'), {tenantId: 'A'})).status, 400);
  assert.equal((await intake(`A.${tokenB.split('.')[1]}`, fixture('website'))).status, 401);
  const second = await intake(tokenB, fixture('website')); assert.equal(second.data.lead.tenantId, 'B'); assert.equal(second.data.lead.vehicleId, null);
  assert.equal(repositories.eventsForTest('A').length, before);
  await call('A', 'POST', '/intake-token', {}); assert.equal((await intake(tokenA, fixture('website'))).status, 401);
  assert.equal((await call('A', 'GET', '/intake-token')).status, 404);
});
test('malformed XML, entity declarations, invalid ADF, and wrong tokens leave zero business writes', async () => {
  const {call, intake, repositories} = await setup(); const token = (await call('A', 'POST', '/intake-token', {})).data.token;
  const invalidXml = [fixture('malformed'), '<adf/>', '<adf><prospect/><prospect/></adf>', fixture('website').replace('</adf>', ''),
    '<!DOCTYPE adf [<!ENTITY x SYSTEM "file:///etc/passwd">]><adf>&x;</adf>', fixture('website').replace('Jamie', '&unknown;'),
    fixture('website').replace('part="first"', 'part=first'), fixture('website').replace('<adf>', '<adf version="2.0">'),
    fixture('website').replace('</adf>', '</adf><adf/>'), 'x'.repeat(65537)];
  for (const xml of invalidXml) assert.equal((await intake(token, xml)).status, 400, xml.slice(0, 80));
  assert.equal((await intake('bad-token', fixture('website'))).status, 401);
  assert.equal((await intake(token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a'), fixture('website'))).status, 401);
  assert.equal(repositories.eventsForTest('A').length, 2); assert.deepEqual((await call('A', 'GET', '/customers')).data, []); assert.deepEqual((await call('A')).data, []);
});
test('CRM transaction conflicts and scope violations cannot partially write memory rows', async () => {
  const {repositories, makeLead} = await setup(); const lead = await makeLead(); const repo = repositories.forTenant('A');
  const event = repositories.eventsForTest('A').at(-1)!;
  await assert.rejects(repo.crmWrite([{record: {...lead, tenantId: 'B'}, expectedVersion: 0, event}]), /scope/);
  await assert.rejects(repo.crmWrite([{record: lead, expectedVersion: 0, event: {...event, tenantId: 'B'}}]), /scope/);
  const c = (await repo.crmGet('customer', lead.customerId))!;
  await assert.rejects(repo.crmWrite([{record: {...c, id: 'new-customer'}, expectedVersion: 0, event: {...event, id: 'new-event', type: 'customer.created', aggregateId: 'new-customer'}}, {record: {...lead, version: 2}, expectedVersion: 1, event: {...event, type: 'lead.updated', aggregateVersion: 2}}]));
  assert.deepEqual(await repo.crmList('customer'), [c]); assert.deepEqual(await repo.crmList('lead'), [await repo.crmGet('lead', lead.id)]);
  assert.equal(await repo.crmGet('customer', 'new-customer'), undefined); assert.equal((await repo.crmGet('lead', lead.id))?.version, 1);
});

test('staff can work leads but cannot rotate intake tokens; inactive users and absent claims fail closed', async () => {
  const staff = await setup('staff'); const lead = await staff.makeLead();
  assert.equal((await staff.call('A', 'POST', '/intake-token', {})).status, 403);
  assert.equal((await staff.call('A', 'PUT', `/customers/${lead.customerId}`, {...customer, notes: 'Updated', version: 1})).status, 200);
  assert.equal((await staff.call('A', 'PUT', `/customers/${lead.customerId}`, {...customer, version: 1})).status, 409);
  const inactive = await setup('admin', false);
  for (const path of ['/leads', '/customers', '/users', '/intake-token']) {
    assert.equal((await inactive.call('A', path === '/intake-token' ? 'POST' : 'GET', path, {})).status, 403);
    assert.equal((await staff.handler({method: 'GET', path})).statusCode, 401);
  }
  assert.deepEqual((await staff.call('A', 'GET', '/users')).data.map((u: {id: string}) => u.id), ['userA']);
});

test('lead pages bound default reads and preserve full lists and tenant isolation', async () => {
  const {call, makeLead, repositories} = await setup();
  for (let i = 0; i < 103; i++) await makeLead();
  await makeLead('B');
  const first = await call('A');
  assert.equal(first.data.length, 100); assert.equal(first.total, 103); assert.equal(first.limit, 100); assert.equal(first.offset, 0);
  assert.ok(first.data.every((l: Lead) => l.tenantId === 'A'));
  for (const [offset, length] of [[100, 3], [103, 0]]) {
    const page = await call('A', 'GET', '/leads', undefined, {offset: String(offset)});
    assert.equal(page.total, 103); assert.equal(page.data.length, length);
  }
  const b = await call('B'); assert.equal(b.total, 1); assert.equal(b.data[0].tenantId, 'B');
  const repo = repositories.forTenant('A'); assert.equal((await repo.crmList('lead')).length, 103);
  const page = await repo.leadListPage({limit: 1, offset: 0});
  page.leads[0].activities[0].summary = 'changed'; page.customers[0].name = 'changed';
  assert.notEqual((await repo.crmGet('lead', page.leads[0].id))!.activities[0].summary, 'changed');
  assert.notEqual((await repo.crmGet('customer', page.customers[0].id))!.name, 'changed');
});

test('lead pages order ties, filter before slicing, preserve joined search and skip orphans', async () => {
  const {call, makeLead, repositories} = await setup();
  const template = await makeLead(); const repo = repositories.forTenant('A');
  const rows: Lead[] = [template];
  for (let i = 0; i < 31; i++) {
    const lead: Lead = {...template, id: `lead-${String(i).padStart(3, '0')}`, createdAt: `2026-10-${20 + i % 3}T00:00:00Z`,
      stage: i % 2 ? 'new' : 'contacted', assigneeId: i % 3 ? null : 'userA', vehicleDescription: i % 4 ? 'Blue sedan' : 'Truck'};
    rows.push(lead);
    await repo.crmWrite([{record: lead, expectedVersion: 0, event: {id: `event-${i}`, tenantId: 'A', actorId: 'userA', aggregateId: lead.id, aggregateVersion: 1, type: 'lead.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'}}]);
  }
  const orphan = {...template, id: 'orphan', customerId: 'missing'};
  await repo.crmWrite([{record: orphan, expectedVersion: 0, event: {id: 'orphan-event', tenantId: 'A', actorId: 'userA', aggregateId: orphan.id, aggregateVersion: 1, type: 'lead.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'}}]);
  rows.sort((a,b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  for (const filters of [{}, {stage: 'new'}, {assignee: 'unassigned'}, {assignee: 'userA'}, {search: 'BLUE'}, {stage: 'new', assignee: 'unassigned', search: 'BLUE'}, {search: 'jamie'}, {search: 'example.test'}, {search: '5551234567 walk-in'}] as Record<string, string>[]) {
    const expected = rows.filter(l => (!filters.stage || l.stage === filters.stage) && (!filters.assignee || l.assigneeId === (filters.assignee === 'unassigned' ? null : filters.assignee)) && [customer.name, customer.email, customer.phone, l.source, l.vehicleDescription].join(' ').toLowerCase().includes((filters.search ?? '').toLowerCase()));
    const ids: string[] = [];
    for (let offset = 0; offset <= expected.length; offset += 2) {
      const page = await call('A', 'GET', '/leads', undefined, {...filters, limit: '2', offset: String(offset)});
      assert.equal(page.total, expected.length); ids.push(...page.data.map((l: Lead) => l.id));
    }
    assert.deepEqual(ids, expected.map(l => l.id));
  }
  assert.equal((await call('A', 'GET', '/leads', undefined, {search: 'no-matching-lead'})).total, 0);
  assert.equal((await call('A', 'GET', '/leads')).total, rows.length);
  assert.equal((await call('A', 'GET', '/leads/orphan')).status, 404);
  assert.equal((await repo.crmList('lead')).length, 33);
});

test('lead pagination rejects malformed numbers and unknown query keys', async () => {
  const {call} = await setup();
  for (const query of [
    ...['0', '501', 'abc', '1.5', '', ' 1', '1 ', '1x', '1e2', '-1'].map(limit => ({limit})),
    ...['-1', 'abc', '1.5', '9007199254740992', '', ' ', '1e2'].map(offset => ({offset})), {unknown: '1'},
  ]) assert.equal((await call('A', 'GET', '/leads', undefined, query)).status, 400, JSON.stringify(query));
});

test('memory service board selects day and linked rows once, preserves insertion order and isolates tenants and clones', async () => {
  const {boardRows, boardDay, boardIds} = await import('./fixtures/service-board.js');
  const repositories = new MemoryRepositories(), repo = repositories.forTenant('A');
  for (const record of boardRows) await repo.crmWrite([{record, expectedVersion: 0, event: {
    id: `event-${record.id}`, tenantId: 'A', actorId: 'userA', aggregateId: record.id, aggregateVersion: 1,
    type: `${record.kind}.created` as import('@freedms/shared').OutboxEvent['type'], occurredAt: now.toISOString(), deliveryStatus: 'pending'
  }}]);
  const board = await repo.serviceBoard(boardDay);
  assert.deepEqual(Object.fromEntries(Object.entries(board).map(([kind, rows]) => [kind, rows.map((r: {id: string}) => r.id)])), boardIds);
  board.repairOrders[0].lineItems.push({id: 'changed', kind: 'parts', description: '', quantity: 1, unitPriceCents: 100, laborHoursHundredths: null, laborRateCents: null});
  board.appointments[0].customerName = 'changed'; board.signatures[0].signerName = 'changed'; board.technicians[0].skills.push('brakes');
  const reread = await repo.serviceBoard(boardDay);
  assert.equal(reread.repairOrders[0].lineItems.length, 0); assert.equal(reread.appointments[0].customerName, 'Customer');
  assert.equal(reread.signatures[0].signerName, 'Customer'); assert.deepEqual(reread.technicians[0].skills, []);
  assert.deepEqual(await repositories.forTenant('B').serviceBoard(boardDay), {appointments: [], repairOrders: [], signatures: [], technicians: []});
});

test('memory crmList preserves per-kind order, replacement and clone isolation across tenants', async () => {
  const {repositories, makeLead, call} = await setup();
  const repo = repositories.forTenant('A'), other = repositories.forTenant('B');
  assert.deepEqual(await repo.crmList('document'), []);
  const first = await makeLead();
  assert.equal((await call('A', 'PUT', '/settings', {...defaultSettings, version: 0})).status, 200);
  const second = await makeLead();
  const leads = await repo.crmList('lead'), customers = await repo.crmList('customer');
  assert.deepEqual(leads.map(r => r.id), [first.id, second.id]);
  assert.deepEqual(customers.map(r => r.id), [first.customerId, second.customerId]);
  assert.equal((await repo.crmList('settings')).length, 1);
  for (const kind of ['lead', 'customer', 'settings'] as const) assert.deepEqual(await other.crmList(kind), []);
  const otherLead = await makeLead('B');
  assert.deepEqual((await other.crmList('lead')).map(r => r.id), [otherLead.id]);

  const updated = {...leads[0], version: 2};
  await repo.crmWrite([{record: updated, expectedVersion: 1, event: {
    id: 'replace-first', tenantId: 'A', actorId: 'userA', aggregateId: first.id,
    aggregateVersion: 2, type: 'lead.updated', occurredAt: now.toISOString(), deliveryStatus: 'pending'
  }}]);
  const expected = structuredClone(updated);
  updated.activities[0].actorId = 'mutated-input';
  const listed = await repo.crmList('lead');
  assert.deepEqual(listed, [expected, leads[1]]);
  listed[0].activities[0].actorId = 'mutated-output';
  listed.reverse();
  assert.deepEqual(await repo.crmList('lead'), [expected, leads[1]]);
  assert.deepEqual(await repo.crmGet('lead', first.id), expected);
  assert.deepEqual(await repo.crmList('customer'), customers);
  assert.deepEqual(await other.crmList('lead'), [await other.crmGet('lead', otherLead.id)]);
});

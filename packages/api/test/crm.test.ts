import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isOverdue, type CustomerInput, type Lead } from '@freedms/shared';
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
  const v = (await call('A', 'POST', '/vehicles', {stockNumber: 'H123', vin: '1HGCM82633A004352', year: 2003, make: 'Honda', model: 'Accord', trim: '', status: 'available', listPrice: 0, cost: 0, reconCosts: [], dateStocked: '2026-10-19', location: '', notes: ''})).data;
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

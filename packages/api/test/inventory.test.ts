import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthClaims, OutboxEvent, VehicleInput, VehicleView } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler, type ApiRequest } from '../src/handler.js';
import { LocalTokens, validateClaims } from '../src/auth.js';
const now = new Date('2026-10-19T12:00:00Z');
// Synthetic test fixtures only; never imported by runtime code or seeded into local storage.
const input: VehicleInput = {mileage: null, stockNumber: 'test-stock', vin: '1HGCM82633A004352', year: 2003, make: 'Test make', model: 'Test model', trim: '', status: 'available', listPrice: 129999, cost: 100000, reconCosts: [{description: 'Test work', amount: 1999}, {description: 'Test labor', amount: 5000}], dateStocked: '2026-10-01', location: '', notes: ''};
async function setup(role: 'admin' | 'staff' = 'admin', active = true) {
  const repositories = new MemoryRepositories();
  const tokens = new LocalTokens('test-secret-must-be-at-least-32-characters', () => now.getTime());
  for (const tenantId of ['A', 'B']) await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: now.toISOString()}, {id: 'user', name: 'Test user'}, {tenantId, userId: 'user', role, active}, {id: 'provision', tenantId, actorId: 'user', aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  const claims = (tenant: string) => tokens.verify(tokens.issue('user', tenant));
  let decodeCalls = 0;
  const handler = createHandler(repositories, {decode: async vin => { decodeCalls++; return {vin, year: 2003, make: 'Test make', model: 'Test model', trim: '', warnings: []}; }}, () => now);
  const call = async (tenant: string, method = 'GET', path = '/vehicles', body?: unknown, query?: ApiRequest['query']) => {
    const result = await handler({method, path, body: body === undefined ? undefined : JSON.stringify(body), query, claims: claims(tenant)});
    return {status: result.statusCode, ...JSON.parse(result.body)};
  };
  return {repositories, handler, call, claims, decodeCalls: () => decodeCalls};
}
test('inventory begins empty, full CRUD computes aging and recon and writes attributable events', async () => {
  const {call, repositories} = await setup();
  assert.deepEqual((await call('A')).data, []);
  const created = await call('A', 'POST', '/vehicles', input); assert.equal(created.status, 201);
  const v = created.data as VehicleView; assert.equal(v.agingDays, 18); assert.equal(v.reconTotal, 6999); assert.equal(v.version, 1);
  assert.equal((await call('A', 'GET', `/vehicles/${v.id}`)).data.id, v.id);
  const updated = await call('A', 'PUT', `/vehicles/${v.id}`, {...input, status: 'in recon', version: 1});
  assert.equal(updated.status, 200); assert.equal(updated.data.version, 2);
  assert.equal((await call('A', 'DELETE', `/vehicles/${v.id}`, {version: 2})).status, 200);
  assert.equal((await call('A', 'GET', `/vehicles/${v.id}`)).status, 404);
  const events = repositories.eventsForTest('A');
  assert.deepEqual(events.map(e => e.type), ['tenant.created', 'vehicle.created', 'vehicle.updated', 'vehicle.deleted']);
  assert.ok(events.every(e => e.actorId === 'user' && e.tenantId === 'A' && e.deliveryStatus === 'pending'));
  assert.ok(events.every(e => !('vin' in e) && !('notes' in e)));
});
test('tenant A cannot list, read, update, or delete tenant B vehicles, even with spoofed tenant fields', async () => {
  const {call, repositories} = await setup();
  const v = (await call('B', 'POST', '/vehicles', input)).data;
  assert.deepEqual((await call('A')).data, []);
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const result = await call('A', method, `/vehicles/${v.id}`, method === 'PUT' ? {...input, version: 1} : {version: 1});
    assert.equal(result.status, 404, method);
  }
  assert.equal((await call('A', 'POST', '/vehicles', {...input, tenantId: 'B'})).status, 400);
  assert.equal((await call('A', 'GET', '/vehicles', undefined, {tenantId: 'B'})).status, 400);
  assert.equal((await call('B', 'GET', `/vehicles/${v.id}`)).data.version, 1);
  assert.equal(repositories.eventsForTest('B').length, 2);
  assert.equal(repositories.eventsForTest('A').length, 1);
});
test('repositories reject cross-tenant business and event rows directly', async () => {
  const {call, repositories} = await setup(); const v = (await call('B', 'POST', '/vehicles', input)).data;
  const event: OutboxEvent = {id: 'event', tenantId: 'B', actorId: 'user', aggregateId: v.id, aggregateVersion: 1, type: 'vehicle.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'};
  const repo = repositories.forTenant('A');
  await assert.rejects(repo.create(v, event), /scope/);
  await assert.rejects(repo.create({...v, tenantId: 'A'}, event), /scope/);
  await assert.rejects(repo.update(v, 1, {...event, type: 'vehicle.updated', aggregateVersion: 2}), /scope/);
  await assert.rejects(repo.delete(v.id, 1, {...event, type: 'vehicle.deleted', aggregateVersion: 2}), /scope/);
  assert.deepEqual(await repo.list({}), []);
});
test('staff may create and update but only admins may delete', async () => {
  const {call} = await setup('staff'); const v = (await call('A', 'POST', '/vehicles', input)).data;
  assert.equal((await call('A', 'PUT', `/vehicles/${v.id}`, {...input, version: 1})).status, 200);
  assert.equal((await call('A', 'DELETE', `/vehicles/${v.id}`, {version: 2})).status, 403);
});
test('missing, inactive, or unknown memberships fail closed', async () => {
  const {handler, claims, call} = await setup('admin', false);
  assert.equal((await call('A')).status, 403);
  assert.equal((await handler({method: 'GET', path: '/vehicles'})).statusCode, 401);
  assert.equal((await handler({method: 'POST', path: '/vehicles', claims: {...claims('A'), sub: 'outsider'}, body: JSON.stringify(input)})).statusCode, 403);
  assert.equal((await call('C')).status, 403);
});
test('signed local tokens reject tampering, expiry, bad audience, token use and malformed identifiers', () => {
  let clock = now.getTime(); const tokens = new LocalTokens('test-secret-must-be-at-least-32-characters', () => clock);
  const token = tokens.issue('user', 'A'); assert.equal(tokens.verify(token)['custom:tenant_id'], 'A');
  const parts = token.split('.'); parts[1] = Buffer.from(JSON.stringify({...tokens.verify(token), 'custom:tenant_id': 'B'})).toString('base64url');
  assert.throws(() => tokens.verify(parts.join('.')));
  assert.throws(() => tokens.verify(`${token}x`)); assert.throws(() => tokens.verify('bad'));
  const claims = tokens.verify(token);
  for (const overrides of [{aud: 'other'}, {iss: 'other'}, {token_use: 'access'}, {sub: 'user#escape'}, {exp: 'NaN'}]) assert.throws(() => validateClaims({...claims, ...overrides}, 'freedms-local', 'freedms-local-web', clock));
  clock += 3600000; assert.throws(() => tokens.verify(token));
});
test('optimistic concurrency leaves losing updates/deletes and their events uncommitted', async () => {
  const {call, repositories} = await setup(); const v = (await call('A', 'POST', '/vehicles', input)).data;
  const updates = await Promise.all([call('A', 'PUT', `/vehicles/${v.id}`, {...input, version: 1, notes: 'first'}), call('A', 'PUT', `/vehicles/${v.id}`, {...input, version: 1, notes: 'second'})]);
  assert.deepEqual(updates.map(r => r.status).sort(), [200, 409]);
  assert.equal((await call('A', 'DELETE', `/vehicles/${v.id}`, {version: 1})).status, 409);
  assert.equal(repositories.eventsForTest('A').length, 3);
  assert.equal((await call('A', 'GET', `/vehicles/${v.id}`)).data.version, 2);
});
test('event collision rolls back the business write in memory', async () => {
  const {call, repositories} = await setup(); const v = (await call('A', 'POST', '/vehicles', input)).data;
  const event = repositories.eventsForTest('A')[1];
  await assert.rejects(repositories.forTenant('A').update({...v, version: 2, notes: 'must not persist'}, 1, {...event, type: 'vehicle.updated', aggregateVersion: 2}));
  assert.equal((await call('A', 'GET', `/vehicles/${v.id}`)).data.version, 1);
  assert.equal(repositories.eventsForTest('A').length, 2);
});
test('list supports combined status and case-insensitive search; VIN decoding uses injected interface', async () => {
  const {call, decodeCalls} = await setup(); await call('A', 'POST', '/vehicles', input);
  assert.equal((await call('A', 'GET', '/vehicles', undefined, {search: 'TEST MAKE', status: 'available'})).data.length, 1);
  assert.equal((await call('A', 'GET', '/vehicles', undefined, {status: 'sold'})).data.length, 0);
  assert.equal((await call('A', 'GET', '/vehicles', undefined, {status: 'unknown'})).status, 400);
  assert.equal((await call('A', 'GET', `/vin/${input.vin}`)).data.vin, input.vin); assert.equal(decodeCalls(), 1);
  assert.equal((await call('A', 'GET', '/vin/INVALID')).status, 400); assert.equal(decodeCalls(), 1);
});
test('invalid writes create neither vehicles nor events', async () => {
  const {call, repositories, handler, claims} = await setup();
  for (const bad of [{cost: -1}, {cost: 1.25}, {year: 12}, {status: 'fake'}, {vin: 'I'.repeat(17)}, {dateStocked: '2026-02-30'}, {dateStocked: '2027-01-01'}, {reconCosts: [{description: '', amount: 1}]}, {stockNumber: ' '}, {id: 'client-id'}, {notes: 'x'.repeat(10001)}]) assert.equal((await call('A', 'POST', '/vehicles', {...input, ...bad})).status, 400, JSON.stringify(bad).slice(0, 50));
  assert.equal((await handler({method: 'POST', path: '/vehicles', body: '{bad', claims: claims('A')})).statusCode, 400);
  assert.deepEqual((await call('A')).data, []); assert.equal(repositories.eventsForTest('A').length, 1);
});

test('mileage persists through create, update, list and detail, including zero and clearing', async () => {
  const {call} = await setup();
  const created = await call('A', 'POST', '/vehicles', {...input, mileage: 62400});
  assert.equal(created.status, 201); assert.equal(created.data.mileage, 62400);
  const path = `/vehicles/${created.data.id}`;
  assert.equal((await call('A', 'GET', path)).data.mileage, 62400);
  assert.equal((await call('A')).data[0].mileage, 62400);
  for (const [index, mileage] of [62500, 0, 10000000, null].entries()) {
    const updated = await call('A', 'PUT', path, {...input, mileage, version: index + 1});
    assert.equal(updated.status, 200); assert.equal(updated.data.mileage, mileage);
    assert.equal((await call('A', 'GET', path)).data.mileage, mileage);
    assert.equal((await call('A')).data[0].mileage, mileage);
  }
});
test('omitted mileage defaults to null and old stored vehicles render as null', async () => {
  const {call, repositories} = await setup();
  const {mileage, ...olderInput} = input;
  const created = await call('A', 'POST', '/vehicles', olderInput);
  assert.equal(created.status, 201); assert.equal(created.data.mileage, null);
  const {mileage: storedMileage, ...olderRecord} = created.data;
  const legacy = {...olderRecord, id: 'legacy'};
  await repositories.forTenant('A').create(legacy, {id: 'legacy-event', tenantId: 'A', actorId: 'user', aggregateId: 'legacy', aggregateVersion: 1, type: 'vehicle.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  assert.equal((await call('A', 'GET', '/vehicles/legacy')).data.mileage, null);
  assert.ok((await call('A')).data.every((v: VehicleView) => v.mileage === null));
});
test('invalid mileage rejects creates and updates without writes or events', async () => {
  const {call, repositories} = await setup();
  const created = await call('A', 'POST', '/vehicles', {...input, mileage: 18500});
  for (const mileage of [-1, 1.5, 10000001, Number.MAX_SAFE_INTEGER + 1, '18500', '', true, {}, []]) {
    for (const method of ['POST', 'PUT']) {
      const result = await call('A', method, method === 'POST' ? '/vehicles' : `/vehicles/${created.data.id}`, {...input, mileage, ...(method === 'PUT' ? {version: 1} : {})});
      assert.equal(result.status, 400); assert.equal(result.error.code, 'VALIDATION');
    }
  }
  assert.equal((await call('A')).data.length, 1);
  assert.equal((await call('A', 'GET', `/vehicles/${created.data.id}`)).data.mileage, 18500);
  assert.equal(repositories.eventsForTest('A').length, 2);
});

test('inventory defaults to 100 rows without changing full repository reads or tenant totals', async () => {
  const {call, repositories} = await setup();
  for (let i = 0; i < 103; i++) assert.equal((await call('A', 'POST', '/vehicles', {...input, stockNumber: `stock-${i}`})).status, 201);
  await call('B', 'POST', '/vehicles', input);
  const page = await call('A');
  assert.equal(page.data.length, 100); assert.equal(page.total, 103); assert.equal(page.limit, 100); assert.equal(page.offset, 0);
  assert.ok(page.data.every((v: VehicleView) => v.tenantId === 'A'));
  assert.equal((await repositories.forTenant('A').list({})).length, 103);
  const last = await call('A', 'GET', '/vehicles', undefined, {offset: '100'});
  assert.equal(last.data.length, 3); assert.equal(last.total, 103);
  const empty = await call('A', 'GET', '/vehicles', undefined, {offset: '103'});
  assert.deepEqual(empty.data, []); assert.equal(empty.total, 103);
});
test('inventory pages are complete, ordered, filtered before paging and isolated', async () => {
  const {call, repositories} = await setup();
  const repo = repositories.forTenant('A');
  for (const [i, id] of ['z', 'b', 'a', 'd', 'c'].entries()) {
    const createdAt = i === 0 ? '2026-10-18T12:00:00Z' : now.toISOString();
    await repo.create({...input, id, tenantId: 'A', version: 1, createdAt, updatedAt: createdAt, stockNumber: i < 4 ? 'match' : 'other', status: i < 3 ? 'available' : 'sold'}, {id, tenantId: 'A', actorId: 'user', aggregateId: id, aggregateVersion: 1, type: 'vehicle.created', occurredAt: createdAt, deliveryStatus: 'pending'});
  }
  await call('B', 'POST', '/vehicles', {...input, stockNumber: 'match'});
  const ids: string[] = [];
  for (const offset of ['0', '2', '4']) {
    const page = await call('A', 'GET', '/vehicles', undefined, {limit: '2', offset});
    assert.equal(page.total, 5); assert.equal(page.limit, 2); assert.equal(page.offset, Number(offset));
    ids.push(...page.data.map((v: VehicleView) => v.id));
  }
  assert.deepEqual(ids, ['a', 'b', 'c', 'd', 'z']);
  for (const [offset, expected] of [['0', ['a', 'b']], ['2', ['z']]] as const) {
    const page = await call('A', 'GET', '/vehicles', undefined, {limit: '2', offset, status: 'available', search: 'MATCH'});
    assert.equal(page.total, 3); assert.deepEqual(page.data.map((v: VehicleView) => v.id), expected);
  }
  const page = await repo.listPage({limit: 1, offset: 0}); page.vehicles[0].notes = 'changed';
  assert.equal((await repo.get(page.vehicles[0].id))!.notes, '');
});
test('inventory rejects malformed or out-of-range pagination and unknown keys', async () => {
  const {call} = await setup();
  for (const query of [{limit: '0'}, {limit: '501'}, {limit: 'abc'}, {limit: '1.5'}, {offset: '-1'}, {offset: 'abc'}, {offset: '1.5'}, {limit: ''}, {limit: ' 1'}, {limit: '1x'}, {limit: '1e2'}, {offset: '9007199254740992'}, {unknown: '1'}]) {
    assert.equal((await call('A', 'GET', '/vehicles', undefined, query)).status, 400, JSON.stringify(query));
  }
});

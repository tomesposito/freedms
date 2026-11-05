import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler } from '../src/handler.js';
import type { AuthClaims } from '@freedms/shared';

test('command search: session auth, staff visibility, grouped caps, tenant isolation and empty queries', async () => {
  const repositories = new MemoryRepositories(), now = new Date('2026-11-04T12:00:00Z');
  const handler = createHandler(repositories, {decode: async () => { throw Error('Offline only'); }}, () => now);
  for (const id of ['A', 'B']) await repositories.forTenant(id).provision({id, name: id, createdAt: now.toISOString()}, {id: 'user', name: 'Staff'}, {tenantId: id, userId: 'user', role: 'staff', active: true}, {id: 'provision', tenantId: id, actorId: 'user', aggregateId: id, aggregateVersion: 1, type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  const call = async (tenant: string, path: string, body?: unknown, q?: string) => {
    const result = await handler({method: body ? 'POST' : 'GET', path, body: body ? JSON.stringify(body) : undefined, query: q === undefined ? undefined : {q}, claims: {sub: 'user', 'custom:tenant_id': tenant} as AuthClaims});
    assert.ok(result.statusCode < 400, result.body); return JSON.parse(result.body).data;
  };
  assert.equal((await handler({method: 'GET', path: '/search', query: {q: 'match'}})).statusCode, 401);
  for (let i = 0; i < 7; i++) {
    const vehicle = await call('A', '/vehicles', {stockNumber: `MATCH-${i}`, vin: `1HGCM82633A00435${i}`, year: 2020, make: 'Ford', model: 'Focus', trim: '', mileage: null, status: 'available', listPrice: 100000, cost: 50000, reconCosts: [], dateStocked: '2026-11-04', location: '', notes: ''});
    const {lead} = await call('A', '/leads', {customer: {name: `Match Person ${i}`, phone: `555123400${i}`, email: `person${i}@example.test`, address: '', notes: '', consent: {status: 'unknown', timestamp: null, source: ''}}, source: 'walk-in'});
    await call('A', '/deals', {vehicleId: vehicle.id, customerId: lead.customerId, leadId: lead.id, type: 'cash'});
  }
  const orphan = await call('A', '/customers', {name: 'Standalone', phone: '', email: 'alone@example.test', address: '', notes: '', consent: {status: 'unknown', timestamp: null, source: ''}});
  assert.equal((await call('A', '/search', undefined, 'Standalone')).people[0].href, `#/leads?customerId=${orphan.customer.id}`);
  const events = repositories.eventsForTest('A').length;
  const results = await call('A', '/search', undefined, 'mAtCh');
  assert.deepEqual(Object.keys(results), ['vehicles', 'people', 'deals']);
  for (const group of ['vehicles', 'people', 'deals']) {
    assert.equal(results[group].length, 5);
    for (const row of results[group]) { assert.deepEqual(Object.keys(row), ['id', 'title', 'meta', 'href']); assert.match(row.href, /^#\/(vehicles|leads|deals)\//); }
  }
  assert.equal((await call('A', '/search', undefined, 'person6@example.test')).people.length, 1);
  assert.equal((await call('A', '/search', undefined, '5551234006')).people.length, 1);
  assert.equal((await call('A', '/search', undefined, 'MATCH-6')).deals.length, 1);
  assert.equal((await call('A', '/search', undefined, 'Ford')).vehicles.length, 5);
  for (const [tenant, q] of [['B', 'match'], ['A', ''], ['A', '   '], ['A', 'absent']]) assert.deepEqual(await call(tenant, '/search', undefined, q), {vehicles: [], people: [], deals: []});
  assert.equal(repositories.eventsForTest('A').length, events, 'search never writes or charges');
  assert.equal((await handler({method: 'GET', path: '/search', query: {q: 'match'}, claims: {sub: 'outsider', 'custom:tenant_id': 'A'} as AuthClaims})).statusCode, 403);
});

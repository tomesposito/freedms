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

test('bounded command search never invokes full lists and empty queries perform no reads', async () => {
  const {searchRecords} = await import('../src/repository.js');
  const repo = new MemoryRepositories().forTenant('A');
  let reads = 0;
  const bounded = new Proxy(repo, {get(target, key, receiver) {
    if (key === 'crmList' || key === 'list') return () => { throw Error('unbounded search read'); };
    if (key === 'commandSearch' || key === 'listPage') return async (...args: unknown[]) => {
      reads++;
      return (Reflect.get(target, key, receiver) as (...args: unknown[]) => unknown)(...args);
    };
    return Reflect.get(target, key, receiver);
  }});
  assert.deepEqual(await searchRecords(bounded, '  '), {vehicles: [], people: [], deals: []});
  assert.equal(reads, 0);
  assert.deepEqual(await searchRecords(bounded, 'absent'), {vehicles: [], people: [], deals: []});
  assert.equal(reads, 2);
});

test('Dynamo bounded command search stops prefix paging at five and resolves joins with point Gets', async () => {
  const {DynamoRepositories} = await import('../src/dynamo.js');
  const {GetCommand, QueryCommand} = await import('@aws-sdk/lib-dynamodb');
  const queries: string[] = [], gets: string[] = [];
  const customers = Array.from({length: 6}, (_, i) => ({kind: 'customer', tenantId: 'A', id: `c${i}`, name: `Match ${i}`, phone: '', email: ''}));
  const deals = customers.map((c, i) => ({kind: 'deal', tenantId: 'A', id: `d${i}`, customerId: c.id, vehicleId: `v${i}`, status: 'working'}));
  const leads = customers.map((c, i) => ({kind: 'lead', tenantId: 'A', id: `l${i}`, customerId: c.id}));
  const vehicles = customers.map((_, i) => ({tenantId: 'A', id: `v${i}`, stockNumber: `stock${i}`}));
  const client = {send: async (command: InstanceType<typeof GetCommand> | InstanceType<typeof QueryCommand>) => {
    if (command instanceof GetCommand) {
      assert.equal(command.input.Key?.PK, 'TENANT#A');
      const key = String(command.input.Key?.SK); gets.push(key);
      const data = [...customers, ...deals, ...leads, ...vehicles].find(r => `${'kind' in r ? r.kind.toUpperCase() : 'VEHICLE'}#${r.id}` === key);
      return data ? {Item: {data}} : {};
    }
    assert.ok(command instanceof QueryCommand);
    assert.equal(command.input.ExpressionAttributeValues?.[':pk'], 'TENANT#A');
    const prefix = String(command.input.ExpressionAttributeValues?.[':prefix']);
    queries.push(prefix);
    const page = command.input.ExclusiveStartKey ? 1 : 0;
    const rows = prefix === 'CUSTOMER#' ? customers : prefix === 'LEAD#' ? leads : deals;
    // Three pages exist, but the third must never be fetched.
    assert.equal(page === 1 && command.input.ExclusiveStartKey?.SK === 'third', false);
    return {Items: rows.slice(page * 3, page * 3 + 3).map(data => ({data})), LastEvaluatedKey: {PK: 'TENANT#A', SK: page ? 'third' : 'second'}};
  }} as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
  const rows = await new DynamoRepositories('table', client).forTenant('A').commandSearch('match');
  assert.deepEqual(rows.people.map(p => p.customer.id), customers.slice(0, 5).map(c => c.id));
  assert.deepEqual(rows.people.map(p => p.lead?.id), leads.slice(0, 5).map(l => l.id));
  assert.deepEqual(rows.people.map(p => p.deal?.id), deals.slice(0, 5).map(d => d.id));
  assert.deepEqual(rows.deals.map(p => p.deal.id), deals.slice(0, 5).map(d => d.id));
  assert.equal(queries.filter(p => p === 'CUSTOMER#').length, 2);
  assert.equal(queries.filter(p => p === 'LEAD#').length, 2);
  assert.equal(queries.filter(p => p === 'DEAL#').length, 4, 'two bounded passes: person hrefs and matching deals');
  assert.equal(gets.length, 20);
  assert.ok(gets.every(key => !key.endsWith('5')));
});

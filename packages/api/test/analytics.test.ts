import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { AnalyticsRecord, BehavioralEvent, Funnel } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { DynamoRepositories } from '../src/dynamo.js';
import { MemoryDocumentStore } from '../src/document-store.js';
import { createHandler } from '../src/handler.js';
import { newInvite, inviteWrite } from '../src/invites.js';
import { LocalTokens } from '../src/auth.js';
import { analyticsFromEnv, projectFunnel, track, type AnalyticsVendor } from '../src/analytics.js';

const now = new Date('2026-10-21T12:00:00.000Z');
const valid: BehavioralEvent[] = [
  ...(['inventory', 'lead'] as const).flatMap(surface => (['text', 'photo'] as const).flatMap(input => (['saved', 'edited', 'discarded'] as const).map(outcome => ({event: 'quick_entry_used' as const, surface, input, outcome})))),
  ...(['aging', 'sales', 'pipeline', 'accounting'] as const).map(report => ({event: 'report_exported' as const, report})),
  {event: 'pencil_grid_viewed'}, {event: 'jacket_checklist_completed'}
];
async function setup(vendor: AnalyticsVendor = analyticsFromEnv({})) {
  const repositories = new MemoryRepositories();
  const tokens = new LocalTokens('analytics-test-secret-at-least-32-characters', () => now.getTime());
  for (const tenantId of ['A', 'B']) await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: now.toISOString()}, {id: `user${tenantId}`, name: tenantId}, {tenantId, userId: `user${tenantId}`, role: 'staff', active: true}, {id: 'provision', tenantId, actorId: `user${tenantId}`, aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  let clock = now;
  const handler = createHandler(repositories, {decode: async () => { throw new Error('No network'); }}, () => clock, new MemoryDocumentStore(), undefined, vendor);
  const call = (tenant: string, path: string, method = 'GET', body?: unknown, query?: Record<string, string>) => handler({method, path, body: body === undefined ? undefined : JSON.stringify(body), query, claims: tokens.verify(tokens.issue(`user${tenant}`, tenant))});
  const json = async (path: string, method = 'GET', body?: unknown) => { const r = await call('A', path, method, body); assert.ok(r.statusCode < 300, r.body); return JSON.parse(r.body).data; };
  return {repositories, handler, call, json, tick: (seconds: number) => { clock = new Date(now.getTime() + seconds * 1000); }};
}
test('strict behavioral firewall rejects unknown fields and values before own log, usage or vendor', async () => {
  const calls: unknown[] = []; const s = await setup(async (...args) => { calls.push(args); });
  for (const event of valid) {
    for (const field of ['name', 'vin', 'price', 'tenantId', 'actorId', 'properties']) {
      assert.equal((await s.call('A', '/analytics/events', 'POST', {...event, [field]: 'secret'})).statusCode, 400);
    }
  }
  for (const event of [{event: 'unknown'}, {event: 'quick_entry_used', surface: 'inventory', input: 'text'}, {event: 'report_exported', report: 'secret'}, {event: 'pencil_grid_viewed', properties: {name: 'Buyer'}}, null, []]) {
    assert.equal((await s.call('A', '/analytics/events', 'POST', event)).statusCode, 400);
  }
  assert.deepEqual(await s.repositories.forTenant('A').analytics(), []);
  assert.deepEqual(await s.repositories.forTenant('A').usageForTest(), []); assert.equal(calls.length, 0);
  for (const event of valid) assert.equal((await s.call('A', '/analytics/events', 'POST', event)).statusCode, 201);
  assert.equal(calls.length, valid.length);
  assert.deepEqual((await s.repositories.forTenant('A').analytics()).map(r => r.data), valid);
  assert.deepEqual((await s.repositories.forTenant('A').usageForTest()).map(r => r.signal), valid.filter(e => e.event === 'quick_entry_used'));
  assert.deepEqual(await s.repositories.forTenant('B').analytics(), []);
  assert.deepEqual(await s.repositories.forTenant('B').usageForTest(), []);
  assert.equal((await s.handler({path: '/analytics/events', method: 'POST', body: JSON.stringify(valid[0])})).statusCode, 401);
  assert.equal((await s.handler({path: '/analytics/funnel', method: 'GET'})).statusCode, 401);
  assert.equal((await s.call('A', '/analytics/funnel', 'GET', undefined, {tenantId: 'B'})).statusCode, 400);
  assert.equal((await s.call('A', '/analytics/events')).statusCode, 405);
  assert.equal((await s.call('A', '/analytics/funnel', 'POST', {})).statusCode, 405);
});
test('unconfigured vendor is a silent no-op; configured capture has only tenant identity and typed properties', async () => {
  const calls: {url: unknown; init: RequestInit}[] = [];
  const request = (async (url, init) => { calls.push({url, init: init!}); return new Response('{}'); }) as typeof fetch;
  for (const env of [{}, {ANALYTICS_ENABLED: '1'}, {ANALYTICS_VENDOR_KEY: 'key'}, {ANALYTICS_ENABLED: '0', ANALYTICS_VENDOR_KEY: 'key'}, {ANALYTICS_ENABLED: '1', ANALYTICS_VENDOR_KEY: '  '}]) {
    await analyticsFromEnv(env, request)('A', valid[0]);
  }
  assert.equal(calls.length, 0);
  const s = await setup(analyticsFromEnv({ANALYTICS_ENABLED: '1', ANALYTICS_VENDOR_KEY: 'key'}, request));
  for (const data of valid) await s.json('/analytics/events', 'POST', data);
  assert.equal(calls.length, valid.length);
  calls.forEach(({url, init}, i) => {
    const {event, ...properties} = valid[i];
    assert.equal(url, 'https://us.i.posthog.com/i/v0/e/'); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    assert.deepEqual(JSON.parse(String(init.body)), {api_key: 'key', distinct_id: 'A', event, properties});
  });
  for (const request of [(async () => { throw new Error('offline'); }) as typeof fetch, (async () => new Response('', {status: 500})) as typeof fetch]) {
    const failing = await setup(analyticsFromEnv({ANALYTICS_ENABLED: '1', ANALYTICS_VENDOR_KEY: 'key'}, request));
    await failing.json('/analytics/events', 'POST', valid[0]);
    assert.equal((await failing.repositories.forTenant('A').analytics()).length, 1);
  }
});
test('memory and Dynamo analytics writes reject foreign tenants; scoped reads paginate', async () => {
  const row: AnalyticsRecord = {id: 'one', tenantId: 'A', occurredAt: now.toISOString(), data: {event: 'pencil_grid_viewed'}};
  const memory = new MemoryRepositories(); const a = memory.forTenant('A');
  await a.appendAnalytics(row); await assert.rejects(a.appendAnalytics(row), /changed|conflict/i);
  await assert.rejects(a.appendAnalytics({...row, tenantId: 'B'}), /scope/);
  (await a.analytics())[0].tenantId = 'B'; assert.equal((await a.analytics())[0].tenantId, 'A');
  assert.deepEqual(await memory.forTenant('B').analytics(), []); assert.deepEqual(await memory.forTenant('B').events(), []);
  const commands: (QueryCommand | TransactWriteCommand)[] = []; const pages = new Map<string, number>();
  const client = {send: async (c: QueryCommand | TransactWriteCommand) => {
    commands.push(c);
    if (c instanceof QueryCommand) {
      assert.equal(c.input.ExpressionAttributeValues?.[':pk'], 'TENANT#A'); assert.equal(c.input.ConsistentRead, true);
      const prefix = c.input.ExpressionAttributeValues?.[':prefix']; const n = (pages.get(prefix) ?? 0) + 1; pages.set(prefix, n);
      if (n === 2) assert.ok(c.input.ExclusiveStartKey);
      return {Items: [{data: row}], ...(n === 1 ? {LastEvaluatedKey: {PK: 'TENANT#A', SK: prefix + 'one'}} : {})};
    } return {};
  }} as unknown as DynamoDBDocumentClient;
  const repo = new DynamoRepositories('test', client).forTenant('A');
  await repo.appendAnalytics(row); assert.equal((await repo.analytics()).length, 2); assert.equal((await repo.events()).length, 2);
  assert.deepEqual([...pages.keys()], ['ANALYTICS#', 'EVENT#']);
  const put = (commands[0] as TransactWriteCommand).input.TransactItems![0].Put!;
  assert.equal(put.Item?.PK, 'TENANT#A'); assert.equal(put.Item?.SK, 'ANALYTICS#one'); assert.equal(put.ConditionExpression, 'attribute_not_exists(PK)');
  const count = commands.length; await assert.rejects(repo.appendAnalytics({...row, tenantId: 'B'}), /scope/); assert.equal(commands.length, count);
  await assert.rejects(track(a, {tenantId: 'B', userId: 'u', role: 'staff'}, now, valid[0], async () => { assert.fail(); }), /scope/);
});
test('real workflow projects funnel with timestamps, matching sold events and shared jacket completeness', async () => {
  const s = await setup();
  let f = await s.json('/analytics/funnel') as Funnel;
  assert.equal(f.tenantProvisioned.count, 1); assert.equal(f.vehicleStocked.firstAt, null);
  s.tick(1);
  const v = await s.json('/vehicles', 'POST', {mileage: null, stockNumber: 'test', vin: '1HGCM82633A004352', year: 2003, make: 'Test', model: 'Test', trim: '', status: 'available', listPrice: 1000000, cost: 700000, reconCosts: [], dateStocked: '2026-10-21', location: '', notes: ''});
  s.tick(2);
  const lead = (await s.json('/leads', 'POST', {customer: {name: 'Private Buyer', phone: '', email: '', address: '', notes: '', consent: {status: 'unknown', timestamp: null, source: ''}}, source: 'walk-in', vehicleId: v.id})).lead;
  s.tick(3);
  let d = await s.json('/deals', 'POST', {vehicleId: v.id, customerId: lead.customerId, type: 'finance'});
  const upload = (type: string) => s.json(`/deals/${d.id}/documents`, 'POST', {name: 'private-file', type, content: 'YQ=='});
  s.tick(4); await upload('id'); await upload('insurance');
  assert.equal((await s.json('/analytics/funnel')).jacketComplete.reached, false);
  s.tick(5); d = await s.json(`/deals/${d.id}`, 'PUT', {version: d.version, status: 'approved'});
  assert.equal((await s.json('/analytics/funnel')).jacketComplete.firstAt, '2026-10-21T12:00:05.000Z');
  await s.json(`/deals/${d.id}/jacket`); await upload('id');
  assert.equal((await s.repositories.forTenant('A').analytics()).filter(r => r.data.event === 'jacket_checklist_completed').length, 1);
  s.tick(6); d = await s.json(`/deals/${d.id}`, 'PUT', {version: d.version, status: 'sold'});
  f = await s.json('/analytics/funnel');
  assert.deepEqual(Object.entries(f).filter(([key]) => key !== 'activation').map(([, stage]) => stage.count), [1, 1, 1, 1, 1, 1]);
  assert.equal(f.vehicleStocked.firstAt, '2026-10-21T12:00:01.000Z'); assert.equal(f.sold.firstAt, '2026-10-21T12:00:06.000Z');
  const repo = s.repositories.forTenant('A'), events = await repo.events(), deals = await repo.crmList('deal'), docs = await repo.crmList('document');
  assert.deepEqual(projectFunnel('A', [...events].reverse(), deals, [...docs].reverse()), f);
  assert.equal(projectFunnel('A', events.filter(e => e.type !== 'vehicle.updated'), deals, docs).sold.reached, false);
  assert.equal(projectFunnel('A', events.filter(e => !e.type.startsWith('document.')), deals, docs).jacketComplete.reached, false);
  assert.throws(() => projectFunnel('B', events, deals, docs), /scope/);
  const other = JSON.parse((await s.call('B', '/analytics/funnel')).body).data;
  assert.equal(other.vehicleStocked.count, 0); assert.equal(other.sold.count, 0);
  await s.json('/analytics/events', 'POST', {event: 'jacket_checklist_completed'});
  assert.deepEqual(await s.json('/analytics/funnel'), f);
  for (const name of ['inventory', 'sales', 'leads', 'accounting']) {
    if (name !== 'accounting') await s.json(`/reports/${name}`);
    assert.equal((await s.call('A', `/reports/${name}.csv`)).statusCode, 200);
  }
  assert.equal((await s.call('A', '/reports/sales.csv', 'GET', undefined, {from: 'bad'})).statusCode, 400);
  assert.deepEqual((await repo.analytics()).filter(r => r.data.event === 'report_exported').map(r => r.data), ['aging', 'sales', 'pipeline', 'accounting'].map(report => ({event: 'report_exported', report})));
});
test('jacket completion observes uploads, ignores repeats and preserves commands on observation failure', async () => {
  const {observeJacketCompletion} = await import('../src/jacket.js');
  let status = 'approved', types: string[] = ['id'], failRead = false, calls = 0;
  const repo = {
    leadListPage: async () => { throw new Error('Unexpected lead page read'); }, listPage: async () => { throw new Error('Unexpected vehicle page read'); },
    crmGet: async () => { if (failRead) throw new Error('read failure'); return {status}; },
    crmList: async () => types.map(type => ({dealId: 'd', type}))
  } as unknown as import('../src/repository.js').TenantRepository;
  const record = async () => { calls++; };
  const command = async () => { types.push('insurance'); return 'committed'; };
  assert.equal(await observeJacketCompletion(repo, 'd', record, command), 'committed'); assert.equal(calls, 1);
  await observeJacketCompletion(repo, 'd', record, command); assert.equal(calls, 1);
  types = ['id']; status = 'working'; await observeJacketCompletion(repo, 'd', record, command); assert.equal(calls, 1);
  status = 'approved'; types = ['id'];
  assert.equal(await observeJacketCompletion(repo, 'd', async () => { throw new Error('write failure'); }, command), 'committed');
  types = ['id']; failRead = true;
  assert.equal(await observeJacketCompletion(repo, 'd', record, command), 'committed'); assert.equal(calls, 1);
  failRead = false; types = ['id'];
  assert.equal(await observeJacketCompletion(repo, 'd', record, async () => { failRead = true; return 'committed'; }), 'committed');
  assert.equal(calls, 1);
});

for (const activity of ['lead', 'deal'] as const) {
  for (const scenario of ['inside', 'boundary', 'late-vehicle', 'late-activity', 'no-invite', 'before-cohort', 'activity-before-cohort'] as const) {
    test(`activation via ${activity}: ${scenario}`, async () => {
      const vendorCalls: unknown[] = [];
      const s = await setup(async (...args) => { vendorCalls.push(args); });
      const repo = s.repositories.forTenant('A');
      if (scenario !== 'no-invite') {
        const invite = newInvite('A', {name: 'Invited', email: 'invited@example.test', role: 'staff'}, now);
        await repo.crmWrite([inviteWrite(invite, 'userA')]);
        const accepted = await s.handler({method: 'POST', path: `/invite/${invite.token}/accept`, body: JSON.stringify({name: invite.name, email: invite.email})});
        assert.equal(JSON.parse(accepted.body).data.outcome, 'accepted');
      }
      assert.equal((await s.json('/analytics/funnel')).activation.activated, false);
      const week = 7 * 86400;
      const vehicleTime = scenario === 'late-vehicle' ? week + 1 : scenario === 'before-cohort' ? -1 : scenario === 'boundary' ? 0 : 1;
      const activityTime = scenario === 'late-activity' ? week + 1 : scenario === 'late-vehicle' ? week + 2 : scenario === 'activity-before-cohort' ? -1 : scenario === 'boundary' ? week : 2;
      s.tick(vehicleTime);
      const vehicle = await s.json('/vehicles', 'POST', {mileage: null, stockNumber: 'test', vin: '1HGCM82633A004352', year: 2003, make: 'Test', model: 'Test', trim: '', status: 'available', listPrice: 1000000, cost: 700000, reconCosts: [], dateStocked: '2026-10-21', location: '', notes: ''});
      assert.equal((await s.json('/analytics/funnel')).activation.activated, false);
      s.tick(activityTime);
      const customer = {name: 'Private Buyer', phone: '', email: '', address: '', notes: '', consent: {status: 'unknown', timestamp: null, source: ''}};
      if (activity === 'lead') await s.json('/leads', 'POST', {customer, source: 'walk-in', vehicleId: vehicle.id});
      else {
        const created = await s.json('/customers', 'POST', customer);
        await s.json('/deals', 'POST', {vehicleId: vehicle.id, customerId: created.customer.id, type: 'cash'});
      }
      const iso = (seconds: number) => new Date(now.getTime() + seconds * 1000).toISOString();
      assert.deepEqual((await s.json('/analytics/funnel')).activation, {
        cohortStart: scenario === 'no-invite' ? null : now.toISOString(), firstVehicleAt: iso(vehicleTime), firstLeadOrDealAt: iso(activityTime), activated: scenario === 'inside' || scenario === 'boundary'
      });
      const other = JSON.parse((await s.call('B', '/analytics/funnel')).body).data;
      assert.deepEqual(other.activation, {cohortStart: null, firstVehicleAt: null, firstLeadOrDealAt: null, activated: false});
      assert.deepEqual(vendorCalls, []);
    });
  }
}

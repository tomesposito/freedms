import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { defaultFeedOptions, type FeedConfig, type FeedRun, type OutboxEvent, type VehicleInput } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { DynamoRepositories } from '../src/dynamo.js';
import { createHandler, type ApiRequest } from '../src/handler.js';
import { LocalTokens } from '../src/auth.js';
import { FEED_BODY_LIMIT, feeds } from '../src/feed.js';
const start = new Date('2026-10-22T12:00:00Z');
const input: VehicleInput = {mileage: null, stockNumber: 'S2', vin: '1HGCM82633A004352', year: 2003, make: 'Honda', model: 'Accord', trim: 'EX', status: 'available', listPrice: 1234567, cost: 990000, reconCosts: [{description: 'Internal', amount: 100}], notes: 'Private note', dateStocked: '2026-10-01', location: 'Lot, "A"'};
async function setup() {
  const repositories = new MemoryRepositories(); let now = start;
  const tokens = new LocalTokens('test-secret-must-be-at-least-32-characters', () => start.getTime());
  for (const tenantId of ['A', 'B']) await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: start.toISOString()}, {id: 'user', name: 'Test'}, {tenantId, userId: 'user', role: 'staff', active: true}, {id: 'provision', tenantId, actorId: 'user', aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: start.toISOString(), deliveryStatus: 'pending'});
  const handler = createHandler(repositories, {decode: async () => { throw new Error('No network'); }}, () => now);
  const raw = (path: string, method = 'GET', body: unknown = {}, tenant = 'A', query?: ApiRequest['query']) => handler({method, path, query, claims: tokens.verify(tokens.issue('user', tenant)), body: JSON.stringify(body)});
  const call = async (path: string, method = 'GET', body: unknown = {}, tenant = 'A') => { const r = await raw(path, method, body, tenant); return {status: r.statusCode, ...JSON.parse(r.body)}; };
  const add = async (changes: Partial<VehicleInput> = {}, tenant = 'A') => (await call('/vehicles', 'POST', {...input, ...changes}, tenant)).data;
  return {repositories, handler, raw, call, add, advance: () => { now = new Date(now.getTime() + 1000); }};
}
test('feed defaults and exact public CSV/JSON fixture; every excluded vehicle is explained', async () => {
  const {call, raw, add} = await setup();
  const settings = (await call('/feeds/config')).data;
  assert.equal(settings.config, null); assert.deepEqual(settings.defaults, defaultFeedOptions);
  assert.deepEqual(defaultFeedOptions.includedStatuses, ['available']); assert.equal(defaultFeedOptions.requirePrice, true);
  assert.deepEqual(settings.local, {generation: 'on-demand', transmission: 'none', schedulerActive: false});
  assert.deepEqual((await call('/feeds/runs')).data, []);
  await add(); await add({stockNumber: 'S1', vin: '1HGCM82633A004353', listPrice: 100});
  await add({stockNumber: 'S3', listPrice: 0}); await add({stockNumber: 'S4', status: 'sold'}); await add({stockNumber: 'S5', status: 'in recon'}); await add({stockNumber: 'S6', status: 'reserved'});
  const generated = await call('/feeds/generate', 'POST'); assert.equal(generated.status, 201);
  const run: FeedRun = generated.data;
  assert.equal(run.includedCount, 2); assert.equal(run.excludedCount, 4);
  assert.deepEqual(run.included.map(v => v.stockNumber), ['S1', 'S2']);
  assert.deepEqual(run.excluded.map(v => [v.stockNumber, v.reason, v.message]), [['S3', 'missing_price', 'Missing price.'], ['S4', 'sold', 'Status not included: sold.'], ['S5', 'status_not_included', 'Status not included: in recon.'], ['S6', 'status_not_included', 'Status not included: reserved.']]);
  const csv = await raw(`/feeds/runs/${run.id}.csv`);
  assert.equal(csv.body, 'stockNumber,vin,year,make,model,trim,status,listPrice,dateStocked,location\r\nS1,1HGCM82633A004353,2003,Honda,Accord,EX,available,1.00,2026-10-01,"Lot, ""A"""\r\nS2,1HGCM82633A004352,2003,Honda,Accord,EX,available,12345.67,2026-10-01,"Lot, ""A"""\r\n');
  assert.match(csv.headers['content-disposition'], /attachment/);
  const json = await raw(`/feeds/runs/${run.id}.json`); assert.equal(json.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(json.body), [
    {stockNumber: 'S1', vin: '1HGCM82633A004353', year: 2003, make: 'Honda', model: 'Accord', trim: 'EX', status: 'available', listPriceCents: 100, dateStocked: '2026-10-01', location: 'Lot, "A"'},
    {stockNumber: 'S2', vin: input.vin, year: 2003, make: 'Honda', model: 'Accord', trim: 'EX', status: 'available', listPriceCents: 1234567, dateStocked: '2026-10-01', location: 'Lot, "A"'}]);
  assert.equal((await call('/feeds/config')).data.config, null);
});
test('config round-trip and opt-in statuses/unpriced behavior; metadata-only outbox', async () => {
  const {call, add, repositories} = await setup();
  const options = {formats: ['json'], includedStatuses: ['sold', 'reserved', 'in recon'], requirePrice: false, schedule: 'weekly'};
  const saved = await call('/feeds/config', 'PUT', options); assert.equal(saved.status, 200);
  assert.deepEqual((await call('/feeds/config')).data.config, saved.data.config);
  assert.equal((await call('/feeds/config', 'PUT', {...options, schedule: 'daily'})).data.config.version, 2);
  for (const status of ['sold', 'reserved', 'in recon'] as const) await add({stockNumber: status, status, listPrice: 0});
  const run = (await call('/feeds/generate', 'POST')).data;
  assert.equal(run.includedCount, 3); assert.equal(run.excludedCount, 0);
  assert.equal((await call(`/feeds/runs/${run.id}.csv`)).status, 404);
  assert.deepEqual((await repositories.forTenant('A').analytics()).map(r => r.data), [{event: 'feed_generated'}]);
  const events = (await repositories.forTenant('A').events()).filter(e => e.type.startsWith('feed.'));
  assert.deepEqual(events.map(e => [e.type, e.aggregateVersion]), [['feed.configured', 1], ['feed.configured', 2], ['feed.generated', 1]]);
  for (const event of events) { assert.equal(event.tenantId, 'A'); assert.equal(event.actorId, 'user'); assert.equal(event.deliveryStatus, 'pending'); assert.deepEqual(Object.keys(event).sort(), ['id', 'tenantId', 'actorId', 'aggregateId', 'aggregateVersion', 'type', 'occurredAt', 'deliveryStatus'].sort()); }
});
test('feed snapshots survive edits and deletions, history sorts newest first, tenants remain isolated', async () => {
  const {call, raw, add, repositories, advance} = await setup();
  const v = await add(); await add({stockNumber: 'B-only'}, 'B');
  await call('/feeds/config', 'PUT', {...defaultFeedOptions, schedule: 'daily'});
  const first: FeedRun = (await call('/feeds/generate', 'POST')).data;
  const before = await Promise.all(['csv', 'json'].map(f => raw(`/feeds/runs/${first.id}.${f}`)));
  assert.equal((await call(`/vehicles/${v.id}`, 'PUT', {...input, listPrice: 777, version: 1})).status, 200);
  advance(); const second = (await call('/feeds/generate', 'POST')).data;
  const repo = repositories.forTenant('A');
  await repo.delete(v.id, 2, {id: 'delete', tenantId: 'A', actorId: 'user', aggregateId: v.id, aggregateVersion: 3, type: 'vehicle.deleted', occurredAt: start.toISOString(), deliveryStatus: 'pending'});
  assert.deepEqual(await Promise.all(['csv', 'json'].map(f => raw(`/feeds/runs/${first.id}.${f}`))), before);
  assert.deepEqual((await call('/feeds/runs')).data.map((r: FeedRun) => r.id), [second.id, first.id]);
  assert.deepEqual(first.included.map(v => v.stockNumber), ['S2']);
  assert.equal((await call('/feeds/config', 'GET', {}, 'B')).data.config, null);
  assert.deepEqual((await call('/feeds/runs', 'GET', {}, 'B')).data, []);
  for (const f of ['csv', 'json']) assert.equal((await raw(`/feeds/runs/${first.id}.${f}`, 'GET', {}, 'B')).statusCode, 404);
  const event = (await repo.events()).find(e => e.type === 'feed.generated')!;
  await assert.rejects(repositories.forTenant('B').appendFeedRun(first, event), /scope/);
  await assert.rejects(repo.appendFeedRun(first, {...event, id: 'duplicate'}), /changed|conflict/i);
  const config = (await repo.feedConfig())!; const configured = (await repo.events()).find(e => e.type === 'feed.configured')!;
  await assert.rejects(repositories.forTenant('B').saveFeedConfig(config, 0, configured), /scope/);
  await assert.rejects(repo.saveFeedConfig(config, 0, {...configured, id: 'stale'}), /changed|conflict/i);
});
test('feed validation, authentication, write roles, methods and unknown routes', async () => {
  const {call, raw, handler, repositories} = await setup();
  for (const change of [{formats: ['xml']}, {formats: []}, {formats: ['csv', 'csv']}, {includedStatuses: ['bad']}, {includedStatuses: []}, {requirePrice: 'yes'}, {schedule: 'hourly'}, {schedule: ['daily']}, {tenantId: 'B'}, {unknown: 'x'.repeat(FEED_BODY_LIMIT)}]) assert.equal((await call('/feeds/config', 'PUT', {...defaultFeedOptions, ...change})).status, 400);
  for (const path of ['/feeds/config', '/feeds/generate', '/feeds/runs', '/feeds/runs/id.json']) {
    assert.equal((await handler({path, method: 'GET'})).statusCode, 401);
    assert.equal((await raw(path, 'DELETE')).statusCode, 405);
    assert.equal((await raw(path, path === '/feeds/generate' ? 'POST' : 'GET', {}, 'A', {tenantId: 'B'})).statusCode, 400);
  }
  assert.equal((await call('/feeds/unknown')).status, 404);
  assert.equal((await call('/feeds/generate', 'POST', {tenantId: 'B'})).status, 400);
  // Both supported roles can write; invalid roles are blocked by authorize and requireWrite.
  for (const role of ['admin', 'staff'] as const) assert.equal((await feeds({path: '/feeds/generate', method: 'POST', body: '{}'}, {tenantId: 'A', userId: 'user', role}, repositories.forTenant('A'), start)).statusCode, 201);
  await assert.rejects(feeds({path: '/feeds/generate', method: 'POST', body: '{}'}, {tenantId: 'A', userId: 'user', role: 'viewer' as 'staff'}, repositories.forTenant('A'), start), /permission/);
});
test('Dynamo feeds use scoped reads, conditional config versions and atomic append-only snapshots/events', async () => {
  const commands: (GetCommand | QueryCommand | TransactWriteCommand)[] = [];
  const client = {send: async (command: typeof commands[number]) => { commands.push(command); return {Items: []}; }} as unknown as DynamoDBDocumentClient;
  const repo = new DynamoRepositories('table', client).forTenant('A');
  const config: FeedConfig = {...defaultFeedOptions, id: 'feed-config', tenantId: 'A', version: 1, createdAt: start.toISOString(), updatedAt: start.toISOString()};
  const event: OutboxEvent = {id: 'event', tenantId: 'A', actorId: 'user', aggregateId: config.id, aggregateVersion: 1, type: 'feed.configured', occurredAt: start.toISOString(), deliveryStatus: 'pending'};
  await repo.saveFeedConfig(config, 0, event);
  await repo.saveFeedConfig({...config, version: 2}, 1, {...event, id: 'event2', aggregateVersion: 2});
  const run: FeedRun = {id: 'run', tenantId: 'A', actorId: 'user', createdAt: start.toISOString(), formats: ['json'], includedCount: 0, excludedCount: 0, included: [], excluded: [], rows: []};
  const generated = {...event, id: 'event3', aggregateId: run.id, type: 'feed.generated' as const};
  await repo.appendFeedRun(run, generated); await repo.feedConfig(); await repo.feedRuns(); await repo.feedRun('run');
  for (const i of [0, 2]) assert.ok((commands[i] as TransactWriteCommand).input.TransactItems!.every(item => item.Put?.Item?.PK === 'TENANT#A' && item.Put.ConditionExpression === 'attribute_not_exists(PK)'));
  assert.deepEqual((commands[2] as TransactWriteCommand).input.TransactItems!.map(i => i.Put?.Item?.SK), ['FEEDRUN#run', 'EVENT#event3']);
  assert.equal((commands[1] as TransactWriteCommand).input.TransactItems![0].Put?.ConditionExpression, '#d.#v = :v');
  assert.deepEqual((commands[1] as TransactWriteCommand).input.TransactItems![0].Put?.ExpressionAttributeValues, {':v': 1});
  assert.deepEqual((commands[3] as GetCommand).input.Key, {PK: 'TENANT#A', SK: 'FEEDCONFIG#feed-config'});
  assert.deepEqual((commands[4] as QueryCommand).input.ExpressionAttributeValues, {':pk': 'TENANT#A', ':prefix': 'FEEDRUN#'});
  assert.deepEqual((commands[5] as GetCommand).input.Key, {PK: 'TENANT#A', SK: 'FEEDRUN#run'});
  await assert.rejects(repo.appendFeedRun({...run, tenantId: 'B'}, generated), /scope/);
  await assert.rejects(repo.appendFeedRun(run, {...generated, tenantId: 'B'}), /scope/);
  await assert.rejects(repo.appendFeedRun(run, {...generated, aggregateId: 'wrong'}), /outbox/);
  await assert.rejects(repo.saveFeedConfig({...config, tenantId: 'B'}, 0, event), /scope/);
  await assert.rejects(repo.saveFeedConfig(config, 1, event), /version/);
  assert.equal(commands.length, 6);
});

test('empty feed generation is honest and oversized snapshots fail without a partial run', async () => {
  const {call, repositories, add} = await setup();
  const empty = (await call('/feeds/generate', 'POST')).data;
  assert.equal(empty.includedCount, 0); assert.equal(empty.excludedCount, 0);
  const repo = repositories.forTenant('A');
  const v = await add();
  // Large inventory fixture without repeated HTTP setup; still stored through scoped repository writes.
  for (let i = 0; i < 1100; i++) {
    const id = `large-${i}`;
    await repo.create({...v, id, stockNumber: id, location: 'x'.repeat(200)}, {id, tenantId: 'A', actorId: 'user', aggregateId: id, aggregateVersion: 1, type: 'vehicle.created', occurredAt: start.toISOString(), deliveryStatus: 'pending'});
  }
  assert.equal((await call('/feeds/generate', 'POST')).status, 400);
  assert.equal((await repo.feedRuns()).length, 1);
  assert.equal((await repo.events()).filter(e => e.type === 'feed.generated').length, 1);
});

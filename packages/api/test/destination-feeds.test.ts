import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { defaultFeedOptions, type FeedRun, type OutboxEvent, type VehicleInput } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { DynamoRepositories } from '../src/dynamo.js';
import { createHandler, type ApiRequest } from '../src/handler.js';
import { LocalTokens } from '../src/auth.js';
import { googleRow, googleCsv, googleColumns, syndicationRow, syndicationCsv, syndicationColumns, agreementGatedDestinations } from '../src/destination-feeds.js';
const start = new Date('2026-11-26T12:00:00Z');
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
const allOn = {...defaultFeedOptions, facebookEnabled: true, googleEnabled: true, syndicationEnabled: true};

test('destination mapping, public serving, isolation, reconciliation and read-only behavior (#205)', async () => {
  const {call, add, handler, repositories, advance} = await setup();
  const pub = (tenant: string, file: string, method = 'GET', query?: ApiRequest['query']) => handler({path: `/public/${tenant}/${file}`, method, query});
  for (const file of ['google.csv', 'syndication.csv']) {
    assert.equal((await pub('A', file)).statusCode, 404);
    assert.deepEqual(await pub('unknown', file), await pub('A', file));
  }
  // Config GET names the destinations and the agreement-gated set before anything is enabled.
  const initial = (await call('/feeds/config')).data;
  assert.deepEqual(initial.destinations.map((d: {id: string}) => d.id), ['facebook', 'google', 'syndication']);
  assert.deepEqual(initial.destinations[1], {id: 'google', name: 'Google Vehicle Ads', enabled: false, feedUrl: '/public/A/google.csv', lastGeneratedAt: null, vehicleCount: null});
  assert.deepEqual(initial.destinations[2], {id: 'syndication', name: 'Syndication CSV', enabled: false, feedUrl: '/public/A/syndication.csv', lastGeneratedAt: null, vehicleCount: null});
  assert.deepEqual(initial.agreementGated.map((g: {name: string}) => g.name), ['Cars.com', 'AutoTrader', 'CarGurus']);
  assert.deepEqual(agreementGatedDestinations.map(g => g.name), ['Cars.com', 'AutoTrader', 'CarGurus']);
  assert.equal((await call('/feeds/config', 'PUT', {...defaultFeedOptions, googleEnabled: 'true'})).status, 400);
  assert.equal((await call('/feeds/config', 'PUT', {...defaultFeedOptions, syndicationEnabled: 1})).status, 400);

  const v = await add({mileage: 10000, listingDescription: 'Assistant drafted copy.'});
  const s1Id = () => repositories.forTenant('A').list({}).then(list => list.find(x => x.stockNumber === 'S1')!.id);
  await add({stockNumber: 'S1', vin: '1HGCM82633A004353', trim: ''});
  await add({stockNumber: 'B-only', vin: '1HGCM82633A004354'}, 'B');
  // Enabled in config but never generated: nothing is published yet.
  await call('/feeds/config', 'PUT', allOn);
  for (const file of ['google.csv', 'syndication.csv']) assert.equal((await pub('A', file)).statusCode, 404);
  advance();
  const run = (await call('/feeds/generate', 'POST')).data;
  assert.deepEqual(run.googleRows, [
    {id: 'S1', title: '2003 Honda Accord', description: '2003 Honda Accord for sale at A. Stock S1.', link: `/public/A/site/vehicles/${await s1Id()}`, image_link: '', additional_image_link: '', price: '12345.67 USD', condition: 'Used', google_product_category: '916', vehicle_fulfillment: 'online', VIN: '1HGCM82633A004353', brand: 'Honda', model: 'Accord', trim: '', year: 2003, mileage: '', color: ''},
    {id: 'S2', title: '2003 Honda Accord EX', description: 'Assistant drafted copy.', link: `/public/A/site/vehicles/${v.id}`, image_link: '', additional_image_link: '', price: '12345.67 USD', condition: 'Used', google_product_category: '916', vehicle_fulfillment: 'online', VIN: input.vin, brand: 'Honda', model: 'Accord', trim: 'EX', year: 2003, mileage: '10000 Miles', color: ''},
  ]);
  assert.deepEqual(run.syndicationRows.map((r: {stock_number: string}) => r.stock_number), ['S1', 'S2']);
  assert.equal(run.syndicationRows[1].description, 'Assistant drafted copy.');
  assert.equal(run.syndicationRows[1].price, '12345.67');
  assert.equal(run.syndicationRows[1].mileage, 10000);

  const repo = repositories.forTenant('A');
  const events = await repo.events(), analytics = await repo.analytics();
  const google = await pub('A', 'google.csv');
  assert.equal(google.statusCode, 200); assert.equal(google.headers['content-type'], 'text/csv; charset=utf-8'); assert.equal(google.headers['content-disposition'], undefined);
  assert.equal(google.body, googleCsv(run.googleRows));
  assert.equal(google.body.split('\r\n')[0], 'id,title,description,link,image_link,additional_image_link,price,condition,google_product_category,vehicle_fulfillment,VIN,brand,model,trim,year,mileage,color');
  assert.deepEqual(googleColumns.length, 17);
  const syndication = await pub('A', 'syndication.csv');
  assert.equal(syndication.statusCode, 200); assert.equal(syndication.body, syndicationCsv(run.syndicationRows));
  assert.equal(syndication.body.split('\r\n')[0], 'stock_number,vin,year,make,model,trim,status,price,mileage,description,image_link,additional_image_link,dealer_name,location,link');
  assert.deepEqual(syndicationColumns.length, 15);
  for (const body of [google.body, syndication.body]) for (const secret of ['990000', 'Internal', 'Private note', 'B-only']) assert.ok(!body.includes(secret));
  assert.equal((await pub('B', 'google.csv')).statusCode, 404);
  assert.equal((await pub('A', 'google.csv', 'POST')).statusCode, 405);
  assert.deepEqual(await pub('A', 'google.csv', 'GET', {x: '1'}), await pub('unknown', 'google.csv'));
  assert.deepEqual(await repo.events(), events); assert.deepEqual(await repo.analytics(), analytics);

  // Status block: live counts while pointers are current.
  const status = (await call('/feeds/config')).data;
  assert.deepEqual(status.destinations.map((d: {id: string; vehicleCount: number | null; lastGeneratedAt: string | null}) => [d.id, d.vehicleCount, d.lastGeneratedAt]), [['facebook', 2, run.createdAt], ['google', 2, run.createdAt], ['syndication', 2, run.createdAt]]);

  // Sold and price changes reconcile at serve time, without regenerating.
  assert.equal((await call(`/vehicles/${v.id}`, 'PUT', {...input, mileage: 10000, status: 'sold', version: 1})).status, 200);
  const afterSale = await pub('A', 'google.csv');
  assert.ok(!afterSale.body.includes(input.vin)); assert.ok(afterSale.body.includes('1HGCM82633A004353'));
  assert.ok(!(await pub('A', 'syndication.csv')).body.includes(input.vin));
  const s1 = (await repo.list({})).find(x => x.stockNumber === 'S1')!;
  assert.equal((await call(`/vehicles/${s1.id}`, 'PUT', {...input, stockNumber: 'S1', vin: '1HGCM82633A004353', trim: '', listPrice: 999900, version: s1.version})).status, 200);
  assert.ok((await pub('A', 'google.csv')).body.includes('9999.00 USD'));
  assert.ok((await pub('A', 'syndication.csv')).body.includes('9999.00'));

  // Disabling one destination unpublishes only that destination.
  await call('/feeds/config', 'PUT', {...allOn, googleEnabled: false});
  assert.equal((await pub('A', 'google.csv')).statusCode, 404);
  assert.equal((await pub('A', 'syndication.csv')).statusCode, 200);
  // A settings change invalidates the remaining pointers until regeneration.
  await call('/feeds/config', 'PUT', {...allOn, googleEnabled: false, requirePrice: false});
  assert.equal((await pub('A', 'syndication.csv')).statusCode, 404);
  assert.equal((await call('/feeds/config')).data.destinations[2].vehicleCount, null);
  advance(); await call('/feeds/generate', 'POST');
  assert.equal((await pub('A', 'syndication.csv')).statusCode, 200);

  // Tenant B publishes only its own vehicles.
  await call('/feeds/config', 'PUT', allOn, 'B'); advance(); await call('/feeds/generate', 'POST', {}, 'B');
  const b = await pub('B', 'google.csv'); assert.ok(b.body.includes('B-only')); assert.ok(!b.body.includes('S1,'));
  assert.equal((await call('/feeds/config', 'GET', {}, 'B')).data.destinations[1].vehicleCount, 1);

  // Photo projection follows the same feed rule as Facebook.
  const photos = googleRow(v, 'A', '<dealer>', ['https://img/1', 'https://img/2']);
  assert.equal(photos.image_link, 'https://img/1'); assert.equal(photos.additional_image_link, 'https://img/2');
  const synPhotos = syndicationRow(v, 'A', '<dealer>', ['https://img/1', 'https://img/2']);
  assert.equal(synPhotos.image_link, 'https://img/1'); assert.equal(synPhotos.additional_image_link, 'https://img/2');
});

test('public destination feeds serve without ever calling feedRuns (#205)', async () => {
  const {call, add, repositories} = await setup();
  await call('/feeds/config', 'PUT', allOn);
  await add();
  await call('/feeds/generate', 'POST');
  const guarded = {forTenant: (tenantId: string) => { const repo = repositories.forTenant(tenantId); return new Proxy(repo, {get: (target, prop) => prop === 'feedRuns' ? async () => { throw new Error('feedRuns must not be called on the public path'); } : Reflect.get(target, prop)}); }};
  const handler2 = createHandler(guarded as never, {decode: async () => { throw new Error('No network'); }}, () => start);
  for (const file of ['google.csv', 'syndication.csv', 'facebook.csv']) {
    const served = await handler2({path: `/public/A/${file}`, method: 'GET'});
    assert.equal(served.statusCode, 200); assert.ok(served.body.includes(input.vin));
  }
});

test('empty destination feeds are header-only and the combined snapshot cap still applies (#205)', async () => {
  const {call, add, repositories} = await setup();
  await call('/feeds/config', 'PUT', allOn);
  const empty = (await call('/feeds/generate', 'POST')).data;
  assert.deepEqual(empty.googleRows, []); assert.deepEqual(empty.syndicationRows, []);
  const v = await add(); const repo = repositories.forTenant('A');
  for (let i = 0; i < 500; i++) {
    const id = `large-${i}`;
    await repo.create({...v, id, stockNumber: id, location: 'x'.repeat(200)}, {id, tenantId: 'A', actorId: 'user', aggregateId: id, aggregateVersion: 1, type: 'vehicle.created', occurredAt: start.toISOString(), deliveryStatus: 'pending'});
  }
  const before = await repo.events();
  assert.equal((await call('/feeds/generate', 'POST')).status, 400);
  assert.equal((await repo.feedRuns()).length, 1); assert.deepEqual(await repo.events(), before);
});

test('Dynamo append writes one bounded pointer per destination in the same transaction (#205)', async () => {
  const commands: (GetCommand | QueryCommand | TransactWriteCommand)[] = [];
  const client = {send: async (command: typeof commands[number]) => { commands.push(command); return {Items: []}; }} as unknown as DynamoDBDocumentClient;
  const repo = new DynamoRepositories('table', client).forTenant('A');
  const run: FeedRun = {id: 'run', tenantId: 'A', actorId: 'user', createdAt: start.toISOString(), formats: ['json'], includedCount: 0, excludedCount: 0, included: [], excluded: [], rows: [], facebookRows: [], googleRows: [], syndicationRows: [], feedFingerprint: 'fp1'};
  const event: OutboxEvent = {id: 'event', tenantId: 'A', actorId: 'user', aggregateId: run.id, aggregateVersion: 1, type: 'feed.generated', occurredAt: start.toISOString(), deliveryStatus: 'pending'};
  await repo.appendFeedRun(run, event);
  assert.deepEqual((commands[0] as TransactWriteCommand).input.TransactItems!.map(i => i.Put?.Item?.SK), ['FEEDRUN#run', 'EVENT#event', 'FEEDPUBLISH#current', 'FEEDPUBLISH#google', 'FEEDPUBLISH#syndication']);
  await repo.destinationFeedPointer('google');
  assert.deepEqual((commands[1] as GetCommand).input.Key, {PK: 'TENANT#A', SK: 'FEEDPUBLISH#google'});
  await repo.destinationFeedPointer('facebook');
  assert.deepEqual((commands[2] as GetCommand).input.Key, {PK: 'TENANT#A', SK: 'FEEDPUBLISH#current'});
  assert.equal(commands.length, 3);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultFeedOptions, type VehicleInput } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler, type ApiRequest } from '../src/handler.js';
import { LocalTokens } from '../src/auth.js';
import { facebookRow, facebookCsv, facebookColumns } from '../src/facebook-feed.js';
const start = new Date('2026-10-22T12:00:00Z');
const input: VehicleInput = {mileage: null, stockNumber: 'S2', vin: '1HGCM82633A004352', year: 2003, make: 'Honda', model: 'Accord', trim: 'EX', status: 'available', listPrice: 1234567, cost: 990000, reconCosts: [{description: 'Internal', amount: 100}], notes: 'Private note', dateStocked: '2026-10-01', location: 'Lot, "A"'};
async function setup(options?: {appBaseUrl?: string}) {
  const repositories = new MemoryRepositories(); let now = start;
  const tokens = new LocalTokens('test-secret-must-be-at-least-32-characters', () => start.getTime());
  for (const tenantId of ['A', 'B']) await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: start.toISOString()}, {id: 'user', name: 'Test'}, {tenantId, userId: 'user', role: 'staff', active: true}, {id: 'provision', tenantId, actorId: 'user', aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: start.toISOString(), deliveryStatus: 'pending'});
  const handler = createHandler(repositories, {decode: async () => { throw new Error('No network'); }}, () => now, undefined, undefined, undefined, undefined, options);
  const raw = (path: string, method = 'GET', body: unknown = {}, tenant = 'A', query?: ApiRequest['query']) => handler({method, path, query, claims: tokens.verify(tokens.issue('user', tenant)), body: JSON.stringify(body)});
  const call = async (path: string, method = 'GET', body: unknown = {}, tenant = 'A') => { const r = await raw(path, method, body, tenant); return {status: r.statusCode, ...JSON.parse(r.body)}; };
  const add = async (changes: Partial<VehicleInput> = {}, tenant = 'A') => (await call('/vehicles', 'POST', {...input, ...changes}, tenant)).data;
  return {repositories, handler, raw, call, add, advance: () => { now = new Date(now.getTime() + 1000); }};
}

test('Facebook mapping, public snapshot, sold exclusion, status, isolation and read-only serving', async () => {
  const {call, add, handler, repositories, advance} = await setup();
  const publicGet = (tenant = 'A', method = 'GET', query?: ApiRequest['query']) => handler({path: `/public/${tenant}/facebook.csv`, method, query});
  const missing = await publicGet();
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(await publicGet('unknown'), missing);
  assert.deepEqual((await call('/feeds/config', 'GET', {}, 'B')).data.facebook, {enabled: false, feedUrl: '/public/B/facebook.csv', lastGeneratedAt: null, vehicleCount: null});
  await call('/feeds/config', 'PUT', defaultFeedOptions);
  assert.deepEqual(await publicGet(), missing);
  assert.equal((await publicGet('A', 'POST')).statusCode, 405);
  assert.deepEqual(await publicGet('A', 'GET', {x: '1'}), missing);
  assert.equal((await call('/feeds/config', 'PUT', {...defaultFeedOptions, facebookEnabled: 'true'})).status, 400);
  const v = await add({mileage: 10000});
  await add({stockNumber: 'S1', vin: '1HGCM82633A004353', trim: ''});
  await add({stockNumber: 'B-only', vin: '1HGCM82633A004354'}, 'B');
  const generic = (await call('/feeds/generate', 'POST')).data;
  assert.ok(!('facebookRows' in generic));
  const options = {...defaultFeedOptions, facebookEnabled: true, includedStatuses: ['available', 'sold', 'reserved', 'in recon']};
  await call('/feeds/config', 'PUT', options);
  advance();
  const run = (await call('/feeds/generate', 'POST')).data;
  assert.deepEqual(run.facebookRows, [
    {vehicle_id: 'S1', vin: '1HGCM82633A004353', title: '2003 Honda Accord', description: '2003 Honda Accord for sale at A. Stock S1.', availability: 'in stock', condition: 'used', price: '12345.67 USD', link: '/public/A/inventory.html', image_link: '', additional_image_link: '', make: 'Honda', model: 'Accord', year: 2003, trim: '', mileage_value: '', mileage_unit: '', dealer_name: 'A', location: input.location},
    {vehicle_id: 'S2', vin: input.vin, title: '2003 Honda Accord EX', description: '2003 Honda Accord EX for sale at A. Stock S2.', availability: 'in stock', condition: 'used', price: '12345.67 USD', link: '/public/A/inventory.html', image_link: '', additional_image_link: '', make: 'Honda', model: 'Accord', year: 2003, trim: 'EX', mileage_value: 10000, mileage_unit: 'MI', dealer_name: 'A', location: input.location}
  ]);
  const photos = facebookRow(v, 'A', '<dealer>', ['https://img/1', 'https://img/2', 'https://img/3']);
  assert.equal(photos.image_link, 'https://img/1'); assert.equal(photos.additional_image_link, 'https://img/2,https://img/3');
  for (const [status, expected] of [['reserved', 'preorder'], ['in recon', 'out of stock']] as const) assert.equal(facebookRow({...v, status}, 'A', 'A', []).availability, expected);
  const repo = repositories.forTenant('A');
  const events = await repo.events(), analytics = await repo.analytics();
  const served = await publicGet();
  assert.equal(served.statusCode, 200); assert.equal(served.headers['content-type'], 'text/csv; charset=utf-8'); assert.equal(served.headers['content-disposition'], undefined);
  assert.equal(served.body, facebookCsv(run.facebookRows));
  assert.equal(served.body.split('\r\n')[0], 'vehicle_id,vin,title,description,availability,condition,price,link,image_link,additional_image_link,make,model,year,trim,mileage_value,mileage_unit,dealer_name,location');
  assert.deepEqual(facebookColumns.length, 18);
  for (const secret of ['990000', 'Internal', 'Private note', 'B-only']) assert.ok(!served.body.includes(secret));
  assert.deepEqual(await publicGet('B'), missing);
  assert.deepEqual(await repo.events(), events); assert.deepEqual(await repo.analytics(), analytics);
  assert.deepEqual((await call('/feeds/config')).data.facebook, {enabled: true, feedUrl: '/public/A/facebook.csv', lastGeneratedAt: run.createdAt, vehicleCount: 2});
  await call('/feeds/config', 'PUT', {...options, facebookEnabled: false});
  assert.deepEqual(await publicGet(), missing);
  advance(); const disabled = (await call('/feeds/generate', 'POST')).data; assert.ok(!('facebookRows' in disabled));
  assert.equal((await call('/feeds/config')).data.facebook.lastGeneratedAt, run.createdAt);
  await call('/feeds/config', 'PUT', options); assert.equal((await publicGet()).body, served.body);
  assert.equal((await call(`/vehicles/${v.id}`, 'PUT', {...input, status: 'sold', version: 1})).status, 200);
  // #171: the withdrawal is reconciled at serve time, without regenerating.
  const reconciled = await publicGet();
  assert.equal(reconciled.statusCode, 200); assert.ok(!reconciled.body.includes(input.vin)); assert.ok(reconciled.body.includes('1HGCM82633A004353'));
  // A price change is reconciled at serve time too.
  const s1 = (await repositories.forTenant('A').list({})).find(x => x.stockNumber === 'S1')!;
  assert.equal((await call(`/vehicles/${s1.id}`, 'PUT', {...input, stockNumber: 'S1', vin: '1HGCM82633A004353', trim: '', listPrice: 999900, version: s1.version})).status, 200);
  assert.ok((await publicGet()).body.includes('9999.00 USD'));
  advance(); const sold = (await call('/feeds/generate', 'POST')).data;
  assert.equal(sold.facebookRows.length, 1); assert.ok(!(await publicGet()).body.includes(input.vin));
  await call('/feeds/config', 'PUT', options, 'B'); advance(); await call('/feeds/generate', 'POST', {}, 'B');
  const b = await publicGet('B'); assert.ok(b.body.includes('B-only')); assert.ok(!b.body.includes('S1,'));
  assert.equal((await call('/feeds/config', 'GET', {}, 'B')).data.facebook.vehicleCount, 1);
  // Deletion is reflected in the next snapshot too.
  const remaining = (await repo.list({})).find(v => v.stockNumber === 'S1')!;
  await repo.delete(remaining.id, remaining.version, {id: 'remove', tenantId: 'A', actorId: 'user', aggregateId: remaining.id, aggregateVersion: remaining.version + 1, type: 'vehicle.deleted', occurredAt: start.toISOString(), deliveryStatus: 'pending'});
  // The deletion is reconciled at serve time too, before any regeneration.
  assert.equal((await publicGet()).body, facebookCsv([]));
  advance(); await call('/feeds/generate', 'POST');
  assert.equal((await publicGet()).body, facebookCsv([]));
});
test('changing publication settings invalidates the published feed until regeneration (#171)', async () => {
  const {call, add, handler} = await setup();
  const publicGet = (tenant = 'A') => handler({path: `/public/${tenant}/facebook.csv`, method: 'GET'});
  const options = {...defaultFeedOptions, facebookEnabled: true};
  await call('/feeds/config', 'PUT', options);
  // Enabled but never generated: nothing is published yet.
  assert.equal((await publicGet()).statusCode, 404);
  await add();
  await call('/feeds/generate', 'POST');
  assert.equal((await publicGet()).statusCode, 200);
  // A settings change moves the publication on: the old pointer no longer serves.
  await call('/feeds/config', 'PUT', {...options, requirePrice: false});
  assert.equal((await publicGet()).statusCode, 404);
  assert.equal((await call('/feeds/config')).data.facebook.vehicleCount, null);
  assert.ok((await call('/feeds/config')).data.facebook.lastGeneratedAt);
  // Regenerating under the new settings republishes.
  await call('/feeds/generate', 'POST');
  const republished = await publicGet();
  assert.equal(republished.statusCode, 200); assert.ok(republished.body.includes(input.vin));
  assert.equal((await call('/feeds/config')).data.facebook.vehicleCount, 1);
});
test('public facebook.csv serves without ever calling feedRuns (#171)', async () => {
  const {call, add, repositories} = await setup();
  await call('/feeds/config', 'PUT', {...defaultFeedOptions, facebookEnabled: true});
  await add();
  await call('/feeds/generate', 'POST');
  const guarded = {forTenant: (tenantId: string) => { const repo = repositories.forTenant(tenantId); return new Proxy(repo, {get: (target, prop) => prop === 'feedRuns' ? async () => { throw new Error('feedRuns must not be called on the public path'); } : Reflect.get(target, prop)}); }};
  const handler2 = createHandler(guarded as never, {decode: async () => { throw new Error('No network'); }}, () => start);
  const served = await handler2({path: '/public/A/facebook.csv', method: 'GET'});
  assert.equal(served.statusCode, 200); assert.ok(served.body.includes(input.vin));
});
test('empty Facebook feed is header-only and combined snapshots respect the size cap', async () => {
  const {call, add, repositories} = await setup();
  await call('/feeds/config', 'PUT', {...defaultFeedOptions, facebookEnabled: true});
  assert.deepEqual((await call('/feeds/generate', 'POST')).data.facebookRows, []);
  const v = await add(); const repo = repositories.forTenant('A');
  for (let i = 0; i < 500; i++) {
    const id = `large-${i}`;
    await repo.create({...v, id, stockNumber: id, location: 'x'.repeat(200)}, {id, tenantId: 'A', actorId: 'user', aggregateId: id, aggregateVersion: 1, type: 'vehicle.created', occurredAt: start.toISOString(), deliveryStatus: 'pending'});
  }
  const before = await repo.events();
  assert.equal((await call('/feeds/generate', 'POST')).status, 400);
  assert.equal((await repo.feedRuns()).length, 1); assert.deepEqual(await repo.events(), before);
});

test('configured public origin makes feed URLs and row links complete HTTPS addresses (#210)', async () => {
  const origin = 'https://app.example.test';
  const {call, add, handler} = await setup({appBaseUrl: origin});
  const v = await add({mileage: 10000});
  // Row builder prefixes the link with the configured origin; without one it stays relative.
  assert.equal(facebookRow(v, 'A', 'A', [], origin).link, `${origin}/public/A/inventory.html`);
  assert.equal(facebookRow(v, 'A', 'A', []).link, '/public/A/inventory.html');
  // The status response shows complete URLs for every destination.
  const before = (await call('/feeds/config')).data;
  assert.equal(before.facebook.feedUrl, `${origin}/public/A/facebook.csv`);
  assert.deepEqual(before.destinations.map((d: {feedUrl: string}) => d.feedUrl), [`${origin}/public/A/facebook.csv`, `${origin}/public/A/google.csv`, `${origin}/public/A/carsforsale.csv`]);
  // Generated rows and the live-served CSV carry the same absolute link.
  await call('/feeds/config', 'PUT', {...defaultFeedOptions, facebookEnabled: true});
  const run = (await call('/feeds/generate', 'POST')).data;
  assert.equal(run.facebookRows[0].link, `${origin}/public/A/inventory.html`);
  const served = await handler({path: '/public/A/facebook.csv', method: 'GET'});
  assert.equal(served.statusCode, 200);
  assert.equal(served.body, facebookCsv(run.facebookRows));
  assert.ok(served.body.includes(`${origin}/public/A/inventory.html`));
});

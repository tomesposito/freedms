import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VehicleInput } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler, type ApiRequest } from '../src/handler.js';
import { LocalTokens } from '../src/auth.js';
import { gatewayHandler } from '../src/gateway.js';
import { localAuth } from '../src/local-auth.js';
const start = new Date('2026-10-22T12:00:00Z');
const input: VehicleInput = {mileage: null, stockNumber: 'S2', vin: '1HGCM82633A004352', year: 2003, make: 'Honda', model: 'Accord', trim: 'EX', status: 'available', listPrice: 1234567, cost: 990000, reconCosts: [{description: 'Internal', amount: 100}], notes: 'Private note', dateStocked: '2026-10-01', location: 'Lot, "A"'};
async function setup() {
  const repositories = new MemoryRepositories(); let now = start;
  const tokens = new LocalTokens('test-secret-must-be-at-least-32-characters', () => start.getTime());
  for (const tenantId of ['A', 'B']) await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId === 'A' ? `Dealer <script> & " ' </script>` : 'B', createdAt: start.toISOString()}, {id: 'user', name: 'Test'}, {tenantId, userId: 'user', role: 'staff', active: true}, {id: 'provision', tenantId, actorId: 'user', aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: start.toISOString(), deliveryStatus: 'pending'});
  const handler = createHandler(repositories, {decode: async () => { throw new Error('No network'); }}, () => now);
  const raw = (path: string, method = 'GET', body: unknown = {}, tenant = 'A', query?: ApiRequest['query']) => handler({method, path, query, claims: tokens.verify(tokens.issue('user', tenant)), body: JSON.stringify(body)});
  const call = async (path: string, method = 'GET', body: unknown = {}, tenant = 'A') => { const r = await raw(path, method, body, tenant); return {status: r.statusCode, ...JSON.parse(r.body)}; };
  const add = async (changes: Partial<VehicleInput> = {}, tenant = 'A') => (await call('/vehicles', 'POST', {...input, ...changes}, tenant)).data;
  return {repositories, handler, raw, call, add, advance: () => { now = new Date(now.getTime() + 1000); }};
}
const paths = ['inventory.json', 'inventory.html', 'llms.txt'].map(f => `/public/A/${f}`);
test('public inventory schema, live status filtering, isolation and read-only reads', async () => {
  const {handler, add, call, repositories} = await setup();
  const second = await add({mileage: 123456});
  await add({stockNumber: 'S1', vin: '1HGCM82633A004353'});
  for (const status of ['sold', 'in recon', 'reserved'] as const) await add({stockNumber: status, status});
  await add({stockNumber: 'B-SECRET-STOCK', vin: '1HGCM82633A004399'}, 'B');
  const repo = repositories.forTenant('A');
  const before = {events: await repo.events(), analytics: await repo.analytics()};
  const results = await Promise.all(paths.map(path => handler({path, method: 'GET'})));
  for (const r of results) {
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    for (const secret of ['B-SECRET-STOCK', '1HGCM82633A004399', '990000', 'Internal', 'Private note', 'reconCosts', 'dateStocked', 'location', 'tenantId']) assert.ok(!r.body.includes(secret), secret);
  }
  assert.deepEqual({events: await repo.events(), analytics: await repo.analytics()}, before);
  const doc = JSON.parse(results[0].body);
  assert.equal(doc['@context'], 'https://schema.org'); assert.equal(doc['@type'], 'ItemList');
  assert.equal(doc.numberOfItems, 2);
  assert.deepEqual(doc.itemListElement.map((v: any) => [v.position, v.item.itemOffered.sku]), [[1, 'S1'], [2, 'S2']]);
  const offer = doc.itemListElement[1].item;
  assert.deepEqual(offer, {
    '@type': 'Offer', availability: 'https://schema.org/InStock', itemCondition: 'https://schema.org/UsedCondition', price: 12345.67, priceCurrency: 'USD',
    seller: {'@type': 'AutoDealer', name: `Dealer <script> & " ' </script>`},
    itemOffered: {'@type': 'Car', name: '2003 Honda Accord EX', vehicleIdentificationNumber: input.vin, modelDate: 2003, brand: {'@type': 'Brand', name: 'Honda'}, model: 'Accord', vehicleModelDate: 2003, mileageFromOdometer: {'@type': 'QuantitativeValue', value: 123456, unitCode: 'SMI'}, sku: 'S2'},
  });
  assert.ok(!('mileageFromOdometer' in doc.itemListElement[0].item.itemOffered));
  assert.ok(!results[0].body.includes('image'));
  assert.equal((await call(`/vehicles/${second.id}`, 'PUT', {...input, status: 'sold', version: 1})).status, 200);
  const fresh = JSON.parse((await handler({path: paths[0], method: 'GET'})).body);
  assert.equal(fresh.numberOfItems, 1); assert.ok(!JSON.stringify(fresh).includes(input.vin));
});
test('HTML safely renders the same JSON-LD, vehicle values, and agent index', async () => {
  const {handler, add} = await setup();
  await add({trim: '</script><script>bad</script>', mileage: 123});
  const json = await handler({path: paths[0], method: 'GET'});
  const html = await handler({path: paths[1], method: 'GET'});
  assert.match(html.headers['content-type'], /text\/html/);
  const block = /<script type="application\/ld\+json">(.*?)<\/script>/.exec(html.body)!;
  assert.deepEqual(JSON.parse(block[1]), JSON.parse(json.body));
  assert.ok(!block[1].includes('<')); assert.equal((html.body.match(/<script/g) ?? []).length, 1);
  for (const value of ['Dealer &lt;script&gt; &amp; &quot; &#39; &lt;/script&gt;', '&lt;/script&gt;&lt;script&gt;bad&lt;/script&gt;', '$12345.67', '123 miles', input.vin, 'S2']) assert.ok(html.body.includes(value), value);
  const txt = await handler({path: paths[2], method: 'GET'});
  assert.match(txt.headers['content-type'], /text\/plain/);
  assert.ok(txt.body.includes(`Dealer <script> & " ' </script>`));
  for (const path of paths.slice(0, 2)) assert.ok(txt.body.includes(path));
});
test('identical public 404s, GET only, gateway and local auth bypass', async () => {
  const {handler} = await setup();
  const missing = await handler({path: '/public/unknown/inventory.json', method: 'GET'});
  assert.equal(missing.statusCode, 404);
  for (const path of ['/public/bad!/inventory.json', '/public/A/unknown', '/public/A/inventory.json/', `/public/${'a'.repeat(129)}/inventory.json`]) assert.deepEqual(await handler({path, method: 'GET'}), missing);
  for (const path of paths) {
    assert.deepEqual(await handler({path, method: 'GET', query: {anything: ''}}), missing);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) assert.equal((await handler({path, method})).statusCode, 405);
    assert.deepEqual(localAuth(path, false, '', {verify: () => {throw new Error('must not verify');}}), {});
    const gateway = gatewayHandler(handler, 'issuer', 'audience');
    assert.equal((await gateway({rawPath: path, requestContext: {http: {method: 'GET', sourceIp: 'gateway'}}})).statusCode, 200);
    assert.equal((await gateway({rawPath: path, requestContext: {http: {method: 'POST'}}})).statusCode, 405);
  }
});
test('fixed window rate limiting separates sources and tenants and resets using injected time', async () => {
  const {handler, advance} = await setup();
  for (let i = 0; i < 120; i++) assert.equal((await handler({path: paths[i % 3], method: 'GET', sourceIp: 'one'})).statusCode, 200);
  assert.equal((await handler({path: paths[0], method: 'GET', sourceIp: 'one'})).statusCode, 429);
  assert.equal((await handler({path: paths[0], method: 'GET', sourceIp: 'two'})).statusCode, 200);
  assert.equal((await handler({path: '/public/B/inventory.json', method: 'GET', sourceIp: 'one'})).statusCode, 200);
  for (let i = 0; i < 60; i++) advance();
  assert.equal((await handler({path: paths[0], method: 'GET', sourceIp: 'one'})).statusCode, 200);
  for (let i = 0; i < 120; i++) assert.equal((await handler({path: paths[0], method: 'GET'})).statusCode, 200);
  assert.equal((await handler({path: paths[1], method: 'GET'})).statusCode, 429);
});
test('empty inventory is honest JSON and HTML', async () => {
  const {handler} = await setup();
  const doc = JSON.parse((await handler({path: paths[0], method: 'GET'})).body);
  assert.equal(doc.numberOfItems, 0); assert.deepEqual(doc.itemListElement, []);
  assert.match((await handler({path: paths[1], method: 'GET'})).body, /No vehicles are currently available\./);
});

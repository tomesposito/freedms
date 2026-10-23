import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlyPayment, pencilMath, type DealView, type FiProduct, type Principal } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler, type ApiRequest } from '../src/handler.js';
import { LocalTokens } from '../src/auth.js';
import { renderPacket } from '../../web/src/jacket.js';
import { fiProducts } from '../src/fi.js';
const now = new Date('2026-10-23T12:00:00Z');
const product = {name: 'Service contract', category: 'service-contract', cost: 90000, retailPrice: 150000, termNotes: '36 months', active: true};
async function setup() {
  const repositories = new MemoryRepositories(), tokens = new LocalTokens('fi-test-secret-at-least-32-characters', () => now.getTime());
  for (const tenantId of ['A', 'B']) await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: now.toISOString()}, {id: `user${tenantId}`, name: tenantId}, {tenantId, userId: `user${tenantId}`, role: 'staff', active: true}, {id: 'provision', tenantId, actorId: `user${tenantId}`, aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  const handler = createHandler(repositories, {decode: async () => { throw new Error('No network'); }}, () => now);
  const raw = (tenant: string, method = 'GET', path = '/fi-products', body?: unknown, query?: ApiRequest['query']) => handler({method, path, body: body === undefined ? undefined : JSON.stringify(body), query, claims: tokens.verify(tokens.issue(`user${tenant}`, tenant))});
  const call = async (...args: Parameters<typeof raw>) => { const r = await raw(...args); return {status: r.statusCode, ...JSON.parse(r.body)}; };
  const createDeal = async (tenant = 'A'): Promise<DealView> => {
    const v = (await call(tenant, 'POST', '/vehicles', {stockNumber: 'test', vin: '1HGCM82633A004352', year: 2003, make: 'Test', model: 'Test', trim: '', status: 'available', listPrice: 1000000, cost: 700000, reconCosts: [{description: 'Repair', amount: 50000}], dateStocked: '2026-10-19', location: '', notes: ''})).data;
    const lead = (await call(tenant, 'POST', '/leads', {customer: {name: 'Buyer', phone: '', email: '', address: '', notes: '', consent: {status: 'unknown', timestamp: null, source: ''}}, source: 'walk-in', vehicleId: v.id})).data.lead;
    return (await call(tenant, 'POST', '/deals', {vehicleId: v.id, customerId: lead.customerId, type: 'finance'})).data;
  };
  return {repositories, handler, call, raw, createDeal};
}
test('F&I catalog round trip, default active, concurrency, validation and route/auth boundaries', async () => {
  const {call, handler, repositories} = await setup();
  assert.deepEqual((await call('A')).data, []);
  const {active, ...input} = product;
  const created = await call('A', 'POST', '/fi-products', input); assert.equal(created.status, 201); let p = created.data;
  assert.equal(p.active, true);
  const put = {...product, version: 1, active: false};
  p = (await call('A', 'PUT', `/fi-products/${p.id}`, put)).data; assert.equal(p.active, false); assert.equal(p.version, 2);
  assert.equal((await call('A', 'PUT', `/fi-products/${p.id}`, put)).status, 409);
  assert.equal((await call('A', 'PUT', `/fi-products/${p.id}`, {...put, version: 2, active: true})).status, 200);
  const second = (await call('A', 'POST', '/fi-products', {...product, name: 'AAA'})).data;
  assert.deepEqual((await call('A')).data.map((p: FiProduct) => p.id), [second.id, p.id]);
  for (const fields of [{category: 'bad'}, {cost: -1}, {retailPrice: 1.5}, {active: 'yes'}, {tenantId: 'B'}, {name: ''}, {name: 'x'.repeat(121)}, {termNotes: 'x'.repeat(501)}, {cost: null}, {category: null}, {retailPrice: undefined}, {termNotes: undefined}, {name: undefined}]) assert.equal((await call('A', 'POST', '/fi-products', {...product, ...fields})).status, 400);
  assert.equal((await call('A', 'PUT', `/fi-products/${p.id}`, {...input, version: 3})).status, 400);
  assert.equal((await call('A', 'PUT', '/fi-products/missing', {...product, version: 1})).status, 404);
  for (const [method, path] of [['DELETE', '/fi-products'], ['PUT', '/fi-products'], ['POST', `/fi-products/${p.id}`], ['GET', `/fi-products/${p.id}`]]) assert.equal((await call('A', method, path)).status, 405);
  assert.equal((await call('A', 'GET', '/fi-products/unknown/path')).status, 404);
  assert.equal((await call('A', 'GET', '/fi-products', undefined, {extra: 'x'})).status, 400);
  assert.equal((await handler({method: 'GET', path: '/fi-products'})).statusCode, 401);
  await assert.rejects(fiProducts({method: 'POST', path: '/fi-products', body: JSON.stringify(product)}, {tenantId: 'A', userId: 'userA', role: 'reader'} as unknown as Principal, repositories.forTenant('A'), now), {status: 403});
});
test('F&I tenant barriers and generic CRM memory scope reject foreign records and events', async () => {
  const {call, repositories, createDeal} = await setup();
  const p = (await call('A', 'POST', '/fi-products', product)).data as FiProduct;
  assert.deepEqual((await call('B')).data, []);
  assert.equal(await repositories.forTenant('B').crmGet('fi-product', p.id), undefined);
  assert.equal((await call('B', 'GET', `/fi-products/${p.id}`)).status, 405); // No individual GET route, for any tenant.
  assert.equal((await call('B', 'PUT', `/fi-products/${p.id}`, {...product, version: 1})).status, 404);
  const d = await createDeal('B');
  assert.equal((await call('B', 'PUT', `/deals/${d.id}`, {version: 1, pencils: [{...d.pencils[0], fiSelections: [{productId: p.id, status: 'accepted'}]}]})).status, 400);
  const event = repositories.eventsForTest('A').find(e => e.type === 'fi-product.created')!;
  await assert.rejects(repositories.forTenant('B').crmWrite([{record: p, expectedVersion: 0, event}]), /scope/);
  await assert.rejects(repositories.forTenant('A').crmWrite([{record: {...p, tenantId: 'B'}, expectedVersion: 0, event}]), /scope/);
  await assert.rejects(repositories.forTenant('A').crmWrite([{record: p, expectedVersion: 0, event: {...event, tenantId: 'B'}}]), /scope/);
});
test('F&I exact math, authoritative immutable snapshots, declines, jacket, sold lock and separate reports', async () => {
  const {call, raw, createDeal, repositories} = await setup();
  // Seed the workspace tax through its generic repository (staff cannot change settings).
  const repo = repositories.forTenant('A'), date = now.toISOString();
  await repo.crmWrite([{record: {id: 'workspace', kind: 'settings', tenantId: 'A', version: 1, createdAt: date, updatedAt: date, taxRateBps: 625, taxTradeDifference: true, docFee: 10000}, expectedVersion: 0, event: {id: 'settings', tenantId: 'A', actorId: 'userA', aggregateId: 'workspace', aggregateVersion: 1, type: 'settings.created', occurredAt: date, deliveryStatus: 'pending'}}]);
  const a = (await call('A', 'POST', '/fi-products', product)).data;
  const b = (await call('A', 'POST', '/fi-products', {...product, name: 'Declined GAP', category: 'gap', retailPrice: 300000})).data;
  let d = await createDeal(); const base = {...d.pencils[0], aprBps: 600};
  const trade = {year: '2010', make: 'Test', model: 'Trade', vin: '', allowance: 200000, payoff: 250000, actualCashValue: 150000};
  const selections = [{productId: a.id, status: 'accepted'}, {productId: b.id, status: 'declined'}];
  for (const fiSelections of [[{...selections[0], retailPrice: 1}], [selections[0], selections[0]], [{productId: 'missing', status: 'accepted'}], [{productId: a.id, status: 'bad'}], null, Array(51).fill(selections[0])]) assert.equal((await call('A', 'PUT', `/deals/${d.id}`, {version: 1, pencils: [{...base, fiSelections}]})).status, 400);
  d = (await call('A', 'PUT', `/deals/${d.id}`, {version: 1, trade, pencils: [{...base, fiSelections: selections}], status: 'approved'})).data;
  const p = d.pencils[0], m = pencilMath(p, trade, d, d.vehicle, 'finance'), before = pencilMath(base, trade, d, d.vehicle, 'finance');
  assert.equal(m.fiRetailTotal, 150000); assert.equal(m.fiCostTotal, 90000); assert.equal(m.fiGross, 60000);
  assert.equal(m.taxableBase, 800000); assert.equal(m.salesTax, 50000); assert.equal(m.balance, 1260000); assert.equal(m.amountFinanced, 1260000);
  assert.equal(m.amountFinanced - before.amountFinanced, 150000); assert.equal(m.frontGross, 200000); assert.equal(m.frontGross, before.frontGross);
  assert.equal(m.payment, monthlyPayment(1260000, 600, 36)); assert.equal(m.totalCost, m.balance + m.netEquity + p.down + m.financeCharge);
  assert.equal(pencilMath(p, trade, d, d.vehicle, 'cash').cashDue - pencilMath(base, trade, d, d.vehicle, 'cash').cashDue, 150000);
  assert.deepEqual(pencilMath({...base, fiSelections: [p.fiSelections[1]]}, trade, d, d.vehicle, 'finance'), before);
  assert.equal((await call('A', 'GET', `/deals/${d.id}`)).data.pencils[0].fiSelections[1].status, 'declined');
  await call('A', 'PUT', `/fi-products/${a.id}`, {...product, retailPrice: 999999, active: false, version: 1});
  d = (await call('A', 'PUT', `/deals/${d.id}`, {version: d.version, pencils: [{...base, fiSelections: selections}]})).data;
  assert.equal(d.pencils[0].fiSelections[0].retailPrice, 150000);
  const jacket = (await call('A', 'GET', `/deals/${d.id}/jacket`)).data;
  assert.deepEqual(jacket.numbers, m); assert.deepEqual(jacket.fiProducts, [{name: product.name, category: product.category, retailPrice: 150000, termNotes: product.termNotes}]);
  const printed = renderPacket(jacket); assert.match(printed, /Service contract/); assert.match(printed, /36 months/); assert.match(printed, /\$1,500\.00/); assert.doesNotMatch(printed, /Declined GAP/);
  d = (await call('A', 'PUT', `/deals/${d.id}`, {version: d.version, status: 'sold'})).data;
  assert.equal((await call('A', 'PUT', `/deals/${d.id}`, {version: d.version, pencils: [base]})).status, 400);
  assert.deepEqual((await call('A', 'GET', `/deals/${d.id}`)).data.pencils, d.pencils);
  const report = (await call('A', 'GET', '/reports/sales')).data;
  assert.equal(report.rows[0].fiGross, 60000); assert.equal(report.rows[0].fiRetail, 150000); assert.equal(report.rows[0].frontGross, 200000); assert.equal(report.totals.totalFiGross, 60000); assert.equal(report.totals.totalFrontGross, 200000);
  for (const name of ['sales', 'accounting']) { const csv = (await raw('A', 'GET', `/reports/${name}.csv`)).body; assert.match(csv.split('\r\n')[0], /,fiGross$/); assert.match(csv.split('\r\n')[1], /,600\.00$/); }
  const events = repositories.eventsForTest('A').filter(e => ['fi-product.created', 'fi-product.updated', 'deal.updated'].includes(e.type));
  for (const type of ['fi-product.created', 'fi-product.updated', 'deal.updated']) assert.ok(events.some(e => e.type === type));
  for (const event of events) { assert.equal(event.tenantId, 'A'); assert.equal(event.actorId, 'userA'); assert.deepEqual(Object.keys(event).sort(), ['id', 'tenantId', 'actorId', 'aggregateId', 'aggregateVersion', 'type', 'occurredAt', 'deliveryStatus'].sort()); }
});
test('F&I missing menu clears full replacement, inactive references work, math validates selection amounts and count', async () => {
  const {call, createDeal} = await setup();
  const p = (await call('A', 'POST', '/fi-products', {...product, active: false})).data;
  let d = await createDeal();
  d = (await call('A', 'PUT', `/deals/${d.id}`, {version: 1, pencils: [{...d.pencils[0], fiSelections: [{productId: p.id, status: 'accepted'}]}]})).data;
  const pencil = d.pencils[0], selection = pencil.fiSelections[0];
  for (const fiSelections of [[{...selection, cost: -1}], [{...selection, retailPrice: 0.1}], [selection, selection], Array.from({length: 51}, (_, i) => ({...selection, productId: String(i)}))]) assert.throws(() => pencilMath({...pencil, fiSelections}, null, d, d.vehicle, d.type));
  await call('A', 'PUT', `/fi-products/${p.id}`, {...product, version: 1, retailPrice: 777777, active: false});
  const copied = {...pencil, sourcePencilId: pencil.id, id: 'copy', fiSelections: [{productId: p.id, status: 'declined'}]};
  d = (await call('A', 'PUT', `/deals/${d.id}`, {version: d.version, pencils: [{...pencil, fiSelections: [{productId: p.id, status: 'accepted'}]}, copied], workingPencilId: 'copy'})).data;
  assert.equal(d.pencils[0].fiSelections[0].status, 'accepted'); assert.equal(d.pencils[1].fiSelections[0].status, 'declined');
  assert.equal(d.pencils[1].fiSelections[0].retailPrice, pencil.fiSelections[0].retailPrice);
  const {fiSelections, ...empty} = pencil;
  d = (await call('A', 'PUT', `/deals/${d.id}`, {version: d.version, pencils: [empty], workingPencilId: empty.id})).data;
  assert.deepEqual(d.pencils[0].fiSelections, []);
});

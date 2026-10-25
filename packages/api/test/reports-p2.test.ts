import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inventoryTurn, pencilMath, reportDatasets, type DealView, type FiReport, type TurnReport, type CustomReport, type SavedReport } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler, type ApiRequest } from '../src/handler.js';
import { LocalTokens } from '../src/auth.js';
import { fiCsv, turnCsv } from '../src/reports-p2.js';
function parseCsv(csv: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') { if (quoted && csv[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && c === ',') { row.push(cell); cell = ''; }
    else if (!quoted && c === '\r' && csv[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += c;
  }
  assert.equal(quoted, false); assert.equal(cell, ''); assert.deepEqual(row, []); return rows;
}
async function setup() {
  let clock = new Date('2026-10-20T12:00:00Z');
  const repositories = new MemoryRepositories(), tokens = new LocalTokens('reports-test-secret-at-least-32-characters', () => clock.getTime());
  for (const tenantId of ['A', 'B']) await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: clock.toISOString()}, {id: `user${tenantId}`, name: tenantId}, {tenantId, userId: `user${tenantId}`, role: 'admin', active: true}, {id: 'provision', tenantId, actorId: `user${tenantId}`, aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: clock.toISOString(), deliveryStatus: 'pending'});
  const handler = createHandler(repositories, {decode: async () => { throw new Error('No network'); }}, () => clock);
  const request = (path: string, query?: ApiRequest['query'], tenant = 'A', method = 'GET', body?: unknown) => handler({path, query, method, body: body === undefined ? undefined : JSON.stringify(body), claims: tokens.verify(tokens.issue(`user${tenant}`, tenant))});
  const json = async <T = any>(path: string, method = 'GET', body?: unknown, query?: ApiRequest['query'], tenant = 'A'): Promise<T> => {
    const r = await request(path, query, tenant, method, body); assert.ok(r.statusCode < 300, r.body); return JSON.parse(r.body).data;
  };
  const {customer} = await json('/customers', 'POST', {name: 'Buyer, "Pat"', phone: '', email: '', address: '', notes: '', consent: {status: 'unknown', timestamp: null, source: ''}});
  const vehicle = async (stockNumber: string, days = 0, cost = 700000, recon = 50000) => json('/vehicles', 'POST', {stockNumber, vin: '1HGCM82633A004352', year: 2019, make: 'Honda, "Special"', model: 'Accord', trim: 'EX', status: 'available', listPrice: 1000000, cost, reconCosts: [{description: 'Repair', amount: recon}], dateStocked: new Date(clock.getTime() - days * 86400000).toISOString().slice(0, 10), location: '', notes: ''});
  const sell = async (date: string, index: number, fiSelections: {productId: string; status: string}[] = [], days = 0) => {
    clock = new Date(`${date}T23:59:59Z`);
    const v = await vehicle(`S${index}`, days);
    let d: DealView = await json('/deals', 'POST', {vehicleId: v.id, customerId: customer.id, type: 'finance'});
    d = await json(`/deals/${d.id}`, 'PUT', {version: d.version, status: 'approved', docFee: 12345,
      pencils: [...d.pencils, {...d.pencils[0], id: `chosen${index}`, price: 800001 + index, name: 'Working', fiSelections}], workingPencilId: `chosen${index}`,
      trade: {year: '2010', make: 'Trade', model: 'Car', vin: '', allowance: 200000, actualCashValue: 100000, payoff: 230000}});
    return json<DealView>(`/deals/${d.id}`, 'PUT', {version: d.version, status: 'sold'});
  };
  const reset = () => { clock = new Date('2026-10-20T12:00:00Z'); };
  return {request, json, vehicle, sell, reset, repositories, handler, customer};
}

const range = {from: '2026-10-01', to: '2026-10-10'};
async function fixture() {
  const s = await setup();
  const product = await s.json('/fi-products', 'POST', {name: 'Plan, "Plus"\nCoverage', category: 'gap', cost: 10000, retailPrice: 30001, termNotes: '', active: true});
  const other = await s.json('/fi-products', 'POST', {name: 'Warranty', category: 'service-contract', cost: 50000, retailPrice: 90000, termNotes: '', active: true});
  const deals = [await s.sell('2026-10-01', 1, [{productId: product.id, status: 'accepted'}, {productId: other.id, status: 'declined'}], 10),
    await s.sell('2026-10-04', 2, [{productId: product.id, status: 'accepted'}, {productId: other.id, status: 'accepted'}], 21),
    await s.sell('2026-10-10', 3, [], 30)];
  s.reset(); await s.vehicle('UNSOLD', 10); await s.vehicle('UNSOLD2', 20);
  await s.json('/leads', 'POST', {customerId: s.customer.id, source: 'phone', vehicleDescription: 'Private vehicle'});
  return {...s, deals, product, other};
}
test('turn reconciles UTC days and exact annualized estimate, inclusive and open periods', async () => {
  const s = await fixture();
  const data = await s.json<TurnReport>('/reports/turn', 'GET', undefined, range);
  // 3 sold, 2 unsold: 3 * 365 / (10 * 5) = 21.9; (10 + 21 + 30) / 3 = 20.3.
  assert.deepEqual(data, {...range, soldInPeriod: 3, averageDaysToSale: 20.3, periodDays: 10, turnRate: 21.9});
  assert.equal((await s.request('/reports/turn.csv', range)).body, turnCsv(data));
  for (const q of [{}, {from: '2026-10-01'}, {to: '2026-10-10'}]) {
    const d = await s.json<TurnReport>('/reports/turn', 'GET', undefined, q); assert.equal(d.periodDays, 10); assert.equal(d.turnRate, 21.9);
  }
  const one = await s.json<TurnReport>('/reports/turn', 'GET', undefined, {from: '2026-10-04', to: '2026-10-04'});
  assert.equal(one.soldInPeriod, 1); assert.equal(one.turnRate, 121.67); assert.equal(one.averageDaysToSale, 21);
  const empty = await s.json<TurnReport>('/reports/turn', 'GET', undefined, {from: '2026-11-01'});
  assert.equal(empty.periodDays, 0); assert.equal(empty.turnRate, 0); assert.equal(empty.averageDaysToSale, 0);
  assert.deepEqual(inventoryTurn([{soldDate: '2026-10-01', dateStocked: '2026-10-02'}], 2, {from: null, to: null}), {from: null, to: null, soldInPeriod: 0, periodDays: 0, turnRate: 0, averageDaysToSale: 0});
  assert.equal(inventoryTurn([{soldDate: '2026-10-01', dateStocked: '2026-09-30'}, {soldDate: '2026-10-01', dateStocked: '2026-09-29'}, {soldDate: '2026-10-01', dateStocked: '2026-09-29'}], 0, {from: null, to: null}).averageDaysToSale, 1.7);
});
test('F&I totals, penetration, distinct deals and product rows reconcile accepted working selections', async () => {
  const s = await fixture(), data = await s.json<FiReport>('/reports/fi', 'GET', undefined, range);
  assert.deepEqual({...data, perProduct: []}, {...range, dealsSold: 3, dealsWithFi: 2, penetrationBps: 6667, totalFiGross: 80002, totalFiRetail: 150002, totalFiCost: 70000, fiGrossPerDeal: 26667, perProduct: []});
  assert.deepEqual(data.perProduct, [{productId: s.product.id, name: s.product.name, category: 'gap', deals: 2, units: 2, retail: 60002, cost: 20000, gross: 40002}, {productId: s.other.id, name: 'Warranty', category: 'service-contract', deals: 1, units: 1, retail: 90000, cost: 50000, gross: 40000}]);
  const math = s.deals.map(d => pencilMath(d.pencils.find(p => p.id === d.workingPencilId)!, d.trade, d, d.vehicle, d.type));
  assert.equal(data.totalFiGross, math.reduce((sum, n) => sum + n.fiGross, 0)); assert.equal(data.totalFiRetail, math.reduce((sum, n) => sum + n.fiRetailTotal, 0)); assert.equal(data.totalFiCost, math.reduce((sum, n) => sum + n.fiCostTotal, 0));
  assert.equal((await s.request('/reports/fi.csv', range)).body, fiCsv(data));
  const filtered = await s.json<FiReport>('/reports/fi', 'GET', undefined, {from: '2026-10-10'}); assert.equal(filtered.dealsSold, 1); assert.equal(filtered.totalFiGross, 0); assert.equal(filtered.penetrationBps, 0);
});
test('every custom dataset and grouping shares exact JSON/CSV cells, including quoted multiline values', async () => {
  const s = await fixture();
  const ro = await s.json('/service/repair-orders', 'POST', {customerId:s.customer.id, payType:'customer-pay', lineItems:[{id:'labor',kind:'labor',description:'Diagnostic',laborHoursHundredths:150,flaggedHoursHundredths:125,laborRateCents:12000,quantity:null,unitPriceCents:null}]});
  await s.json(`/service/repair-orders/${ro.id}`, 'PUT', {version:ro.version,status:'completed'});
  for (const [dataset, spec] of Object.entries(reportDatasets)) for (const groupBy of [undefined, ...spec.groupings]) {
    const q = {dataset, columns: [...spec.columns.map(c => c.key), 'count'].join(','), ...(groupBy ? {groupBy} : {})};
    const data = await s.json<CustomReport>('/reports/custom', 'GET', undefined, q);
    assert.ok(data.rows.length); assert.deepEqual(parseCsv((await s.request('/reports/custom.csv', q)).body), [data.columns.map(c => c.label), ...data.rows]);
    if (groupBy) {
      const i = data.columns.findIndex(c => c.key === groupBy); assert.deepEqual(data.rows.map(r => r[i]), data.rows.map(r => r[i]).sort((a, b) => a.localeCompare(b)));
      for (const c of spec.columns.filter(c => c.type === 'text' && c.key !== groupBy)) assert.ok(data.rows.every(r => r[data.columns.findIndex(col => col.key === c.key)] === ''));
    }
    const empty = await s.json<CustomReport>('/reports/custom', 'GET', undefined, {...q, from: '2027-01-01'}); assert.deepEqual(empty.rows, []);
  }
  const grouped = await s.json<CustomReport>('/reports/custom', 'GET', undefined, {dataset: 'fi', columns: 'product,retail,cost,gross,count', groupBy: 'product'});
  assert.deepEqual(grouped.rows, [[s.product.name, '600.02', '200.00', '400.02', '2'], ['Warranty', '900.00', '500.00', '400.00', '1']]);
  const inventory = await s.json<CustomReport>('/reports/custom', 'GET', undefined, {dataset: 'inventory', columns: 'stockNumber', from: '2026-10-10', to: '2026-10-10'}); assert.deepEqual(inventory.rows, [['UNSOLD']]);
});
test('saved definitions have versioned outbox writes, deterministic lists and tenant barriers', async () => {
  const s = await setup(), input = {name: 'Z report', dataset: 'sales', columns: ['buyer', 'price'], ...range, groupBy: 'buyer'};
  const a = await s.json<SavedReport>('/reports/saved', 'POST', input);
  assert.equal(a.version, 1); assert.equal(a.kind, 'saved-report');
  assert.deepEqual(await s.json('/reports/saved/' + a.id), a);
  assert.deepEqual(await s.json('/reports/saved', 'GET', undefined, undefined, 'B'), []);
  assert.equal((await s.request('/reports/saved/' + a.id, undefined, 'B')).statusCode, 404);
  assert.equal((await s.request('/reports/saved/' + a.id, undefined, 'B', 'PUT', {...input, version: 1})).statusCode, 404);
  const b = await s.json<SavedReport>('/reports/saved', 'POST', {...input, name: 'B private'}, undefined, 'B');
  const first = await s.json<SavedReport>('/reports/saved', 'POST', {...input, name: 'A report'});
  assert.deepEqual((await s.json<SavedReport[]>('/reports/saved')).map(r => r.id), [first.id, a.id]);
  assert.deepEqual((await s.json<SavedReport[]>('/reports/saved', 'GET', undefined, undefined, 'B')).map(r => r.id), [b.id]);
  const updated = await s.json<SavedReport>('/reports/saved/' + a.id, 'PUT', {...input, name: 'Updated', version: 1}); assert.equal(updated.version, 2); assert.equal(updated.createdAt, a.createdAt);
  assert.equal((await s.request('/reports/saved/' + a.id, undefined, 'A', 'PUT', {...input, version: 1})).statusCode, 409);
  const events = s.repositories.eventsForTest('A').filter(e => e.aggregateId === a.id); assert.deepEqual(events.map(e => e.type), ['saved-report.created', 'saved-report.updated']); assert.deepEqual(events.map(e => e.aggregateVersion), [1, 2]); assert.ok(events.every(e => e.actorId === 'userA' && e.tenantId === 'A'));
});
test('new JSON and CSV endpoints enforce auth, methods, query allowlists and isolation', async () => {
  const s = await fixture();
  for (const name of ['turn', 'fi', 'custom']) for (const suffix of ['', '.csv']) for (const dataset of name === 'custom' ? Object.keys(reportDatasets) : ['']) {
    const path = `/reports/${name}${suffix}`, q = dataset ? {dataset, columns: reportDatasets[dataset as keyof typeof reportDatasets].columns.map(c => c.key).join(',')} : {};
    assert.equal((await s.handler({method: 'GET', path, query: q})).statusCode, 401);
    assert.equal((await s.request(path, q, 'A', 'POST')).statusCode, 405);
    assert.equal((await s.request(path, {...q, tenantId: 'B'})).statusCode, 400);
    const b = await s.request(path, q, 'B'); assert.equal(b.statusCode, 200); assert.doesNotMatch(b.body, /Pat|Special|UNSOLD|Coverage|Warranty/);
    if (!suffix) { const data = JSON.parse(b.body).data; if (name === 'turn') assert.equal(data.soldInPeriod, 0); else if (name === 'fi') { assert.equal(data.dealsSold, 0); assert.deepEqual(data.perProduct, []); } else assert.deepEqual(data.rows, []); }
    for (const bad of [{from: ''}, {to: '2026-02-30'}, {from: '2026-11-01', to: '2026-10-01'}]) assert.equal((await s.request(path, {...q, ...bad})).statusCode, 400);
  }
  const input = {name: 'Report', dataset: 'sales', columns: ['buyer']};
  const a = await s.json<SavedReport>('/reports/saved', 'POST', input);
  for (const path of ['/reports/saved', '/reports/saved/' + a.id]) {
    assert.equal((await s.handler({method: 'GET', path})).statusCode, 401);
    assert.equal((await s.request(path, undefined, 'A', 'DELETE')).statusCode, 405);
    assert.equal((await s.request(path, {tenantId: 'B'})).statusCode, 400);
  }
  for (const bad of [{dataset: 'no'}, {dataset: '__proto__'}, {columns: ['no']}, {columns: []}, {columns: ['buyer', 'buyer']}, {groupBy: 'price'}, {groupBy: ''}, {from: null}, {to: '2026-02-30'}, {from: '2026-11-01', to: '2026-10-01'}]) {
    for (const [path, method, version] of [['/reports/saved', 'POST', undefined], ['/reports/saved/' + a.id, 'PUT', 1]] as const) assert.equal((await s.request(path, undefined, 'A', method, {...input, ...bad, version})).statusCode, 400);
    const q = {...input, ...bad} as Record<string, unknown>; delete q.name;
    const query = Object.fromEntries(Object.entries(q).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)]));
    for (const suffix of ['', '.csv']) assert.equal((await s.request('/reports/custom' + suffix, query)).statusCode, 400);
  }
  for (const bad of [{name: ''}, {name: 'x'.repeat(121)}, {tenantId: 'B'}]) assert.equal((await s.request('/reports/saved', undefined, 'A', 'POST', {...input, ...bad})).statusCode, 400);
});

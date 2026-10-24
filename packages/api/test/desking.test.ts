import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlyPayment, pencilMath, paymentGrid, defaultSettings, type DealView, type Pencil, type Trade } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler, type ApiRequest } from '../src/handler.js';
import { LocalTokens } from '../src/auth.js';
const p: Pencil = {id: 'p', name: 'Test', fiSelections: [], lease: null, price: 1000000, down: 0, term: 36, aprBps: 600};
const vehicle = {cost: 700000, reconCosts: [{description: 'Repair', amount: 50000}]};
const trade: Trade = {year: '2010', make: 'Test', model: 'Trade', vin: '', allowance: 200000, payoff: 250000, actualCashValue: 150000};
test('exact amortization: known cases, zero APR, half-cent edges, small rates and invalid inputs', () => {
  assert.equal(monthlyPayment(1000000, 600, 36), 30422);
  assert.equal(monthlyPayment(2000000, 500, 60), 37742);
  assert.equal(monthlyPayment(1000000, 0, 36), 27778);
  assert.equal(monthlyPayment(1, 0, 2), 1);
  assert.equal(monthlyPayment(1, 0, 3), 0);
  assert.equal(monthlyPayment(0, 600, 36), 0);
  assert.equal(monthlyPayment(1000000, 1, 120), 8338);
  for (const args of [[-1, 600, 36], [1.5, 600, 36], [1, -1, 36], [1, 600, 0], [1, 600, 121]]) assert.throws(() => monthlyPayment(...args as [number, number, number]));
});
test('tax base, half-up tax rounding, negative equity, fees, overallowance and total cost reconcile', () => {
  const tax = {...defaultSettings, taxRateBps: 625, docFee: 10000};
  const full = pencilMath(p, trade, tax, vehicle, 'finance');
  assert.equal(full.taxableBase, 1000000); assert.equal(full.salesTax, 62500);
  assert.equal(full.netEquity, -50000); assert.equal(full.amountFinanced, 1122500);
  assert.equal(full.frontGross, 200000); assert.equal(full.tradeOverallowance, 50000);
  assert.equal(full.totalPayments, full.payment * 36); assert.equal(full.totalCost, p.price + tax.docFee + full.salesTax + full.financeCharge);
  const difference = pencilMath(p, trade, {...tax, taxTradeDifference: true}, vehicle, 'cash');
  assert.equal(difference.taxableBase, 800000); assert.equal(difference.salesTax, 50000); assert.equal(difference.cashDue, 1110000); assert.equal(difference.amountFinanced, 0);
  assert.equal(pencilMath({...p, price: 1}, null, {...tax, taxRateBps: 5000}, vehicle, 'cash').salesTax, 1);
  assert.equal(pencilMath({...p, price: 100}, trade, {...tax, taxTradeDifference: true}, vehicle, 'cash').taxableBase, 0);
  assert.equal(pencilMath({...p, down: 2000000}, null, defaultSettings, vehicle, 'finance').creditDue, 1000000);
});
test('payment grid is derived for three distinct terms and three down options', () => {
  for (const term of [1, 36, 120]) {
    const grid = paymentGrid({...p, term}, trade, defaultSettings, vehicle);
    assert.equal(new Set(grid.map(r => r.term)).size, 3);
    for (const row of grid) { assert.equal(row.options.length, 3); assert.ok(row.options[0].payment >= row.options[2].payment); }
  }
});
const now = new Date('2026-10-19T12:00:00Z');
async function setup(role: 'admin' | 'staff' = 'admin') {
  const repositories = new MemoryRepositories(); const tokens = new LocalTokens('desking-test-secret-at-least-32-characters', () => now.getTime());
  for (const tenantId of ['A', 'B']) await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: now.toISOString()}, {id: `user${tenantId}`, name: tenantId}, {tenantId, userId: `user${tenantId}`, role, active: true}, {id: 'provision', tenantId, actorId: `user${tenantId}`, aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  const handler = createHandler(repositories, {decode: async () => { throw new Error('No network'); }}, () => now);
  const call = async (tenant: string, method = 'GET', path = '/deals', body?: unknown, query?: ApiRequest['query']) => {
    const r = await handler({method, path, body: body === undefined ? undefined : JSON.stringify(body), query, claims: tokens.verify(tokens.issue(`user${tenant}`, tenant))});
    return {status: r.statusCode, ...JSON.parse(r.body)};
  };
  const v = (await call('A', 'POST', '/vehicles', {stockNumber: 'test', vin: '1HGCM82633A004352', year: 2003, make: 'Test', model: 'Test', trim: '', status: 'available', listPrice: 1000000, ...vehicle, dateStocked: '2026-10-19', location: '', notes: ''})).data;
  const lead = (await call('A', 'POST', '/leads', {customer: {name: 'Buyer', phone: '', email: '', address: '', notes: '', consent: {status: 'unknown', timestamp: null, source: ''}}, source: 'walk-in', vehicleId: v.id})).data.lead;
  const create = async (overrides = {}) => { const r = await call('A', 'POST', '/deals', {vehicleId: v.id, customerId: lead.customerId, leadId: lead.id, type: 'finance', ...overrides}); assert.equal(r.status, 201); return r.data as DealView; };
  return {call, create, v, lead, repositories, handler};
}
test('empty deals, settings defaults/snapshot, named pencils and optimistic edits', async () => {
  const {call, create} = await setup(); assert.deepEqual((await call('A')).data, []);
  assert.deepEqual((await call('A', 'GET', '/settings')).data, {...defaultSettings, shareExpiryDays: 7, version: 0});
  assert.equal((await call('A', 'PUT', '/settings', {...defaultSettings, taxRateBps: 625, docFee: 25000, version: 0})).status, 200);
  let d = await create(); assert.equal(d.pencils[0].price, 1000000); assert.equal(d.docFee, 25000);
  await call('A', 'PUT', '/settings', {...defaultSettings, version: 1});
  assert.equal((await call('A', 'GET', `/deals/${d.id}`)).data.docFee, 25000);
  const pencils = [...d.pencils, {...p, id: 'alternate', name: 'More down', down: 100000}];
  const updated = await call('A', 'PUT', `/deals/${d.id}`, {version: 1, pencils, workingPencilId: 'alternate', trade});
  assert.equal(updated.status, 200); d = updated.data; assert.equal(d.pencils.length, 2); assert.equal(d.workingPencilId, 'alternate');
  assert.equal((await call('A', 'PUT', `/deals/${d.id}`, {version: 1, docFee: 0})).status, 409);
  assert.equal((await call('A', 'PUT', `/deals/${d.id}`, {version: 2, workingPencilId: 'missing'})).status, 400);
});
test('approved to sold commits vehicle, lead, deal, ledger and attributable events; closed deals are immutable', async () => {
  const {call, create, v, lead, repositories} = await setup(); const d = await create();
  assert.equal((await call('A', 'PUT', `/deals/${d.id}`, {version: 1, status: 'sold'})).status, 400);
  assert.equal((await call('A', 'PUT', `/deals/${d.id}`, {version: 1, status: 'approved'})).status, 200);
  const count = repositories.eventsForTest('A').length;
  const sold = await call('A', 'PUT', `/deals/${d.id}`, {version: 2, status: 'sold'}); assert.equal(sold.status, 200);
  assert.deepEqual(sold.data.history.map((h: {status: string}) => h.status), ['working', 'approved', 'sold']);
  assert.equal((await call('A', 'GET', `/vehicles/${v.id}`)).data.status, 'sold');
  const l = (await call('A', 'GET', `/leads/${lead.id}`)).data; assert.equal(l.stage, 'sold'); assert.match(l.activities.at(-1).summary, /→ sold/);
  const events = repositories.eventsForTest('A').slice(count); assert.equal(events.length, 24); assert.equal(events.filter(e => e.type === 'gl-account.created').length, 20); assert.deepEqual(events.filter(e => e.type !== 'gl-account.created').map(e => e.type).sort(), ['deal.updated', 'journal-entry.created', 'lead.updated', 'vehicle.updated']); assert.ok(events.every(e => e.actorId === 'userA'));
  assert.equal((await call('A', 'PUT', `/deals/${d.id}`, {version: 3, status: 'dead'})).status, 400);
  assert.equal((await call('A', 'DELETE', `/vehicles/${v.id}`, {version: 2})).status, 409);
});
test('dead deal has no external effects; sale without a lead and competing sales', async () => {
  const {call, create, v, lead, repositories} = await setup(); const d = await create();
  const count = repositories.eventsForTest('A').length;
  assert.equal((await call('A', 'PUT', `/deals/${d.id}`, {version: 1, status: 'dead'})).status, 200);
  assert.equal((await call('A', 'GET', `/vehicles/${v.id}`)).data.version, 1); assert.equal((await call('A', 'GET', `/leads/${lead.id}`)).data.version, 1);
  assert.equal(repositories.eventsForTest('A').length, count + 1);
  const a = await create({leadId: null}), b = await create({leadId: null});
  for (const d of [a, b]) await call('A', 'PUT', `/deals/${d.id}`, {version: 1, status: 'approved'});
  const results = await Promise.all([a, b].map(d => call('A', 'PUT', `/deals/${d.id}`, {version: 2, status: 'sold'})));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal((await call('A', 'GET', `/leads/${lead.id}`)).data.version, 1);
});
test('deals/settings enforce tenant isolation, admin settings, input allowlists and authentication', async () => {
  const {call, create, v, lead, handler} = await setup(); const d = await create();
  assert.equal((await call('B', 'GET', `/deals/${d.id}`)).status, 404);
  assert.equal((await call('B', 'PUT', `/deals/${d.id}`, {version: 1, status: 'dead'})).status, 404);
  assert.deepEqual((await call('B')).data, []);
  assert.equal((await call('B', 'POST', '/deals', {vehicleId: v.id, customerId: lead.customerId, type: 'cash'})).status, 400);
  await call('A', 'PUT', '/settings', {...defaultSettings, docFee: 50000, version: 0});
  assert.equal((await call('B', 'GET', '/settings')).data.docFee, 0);
  for (const extra of [{tenantId: 'B'}, {taxRateBps: 625}, {status: 'sold'}]) assert.equal((await call('A', 'POST', '/deals', {vehicleId: v.id, customerId: lead.customerId, type: 'cash', ...extra})).status, 400);
  assert.equal((await call('A', 'GET', '/deals', undefined, {tenantId: 'B'})).status, 400);
  assert.equal((await handler({method: 'GET', path: '/deals'})).statusCode, 401);
  const staff = await setup('staff'); assert.equal((await staff.call('A', 'PUT', '/settings', {...defaultSettings, shareExpiryDays: 7, version: 0})).status, 403); await staff.create();
});
test('mixed transaction conflict rolls back all rows and events', async () => {
  const {repositories, create, v} = await setup(); const d = await create(); const repo = repositories.forTenant('A'); const before = repositories.eventsForTest('A');
  const event = {id: 'failure', tenantId: 'A', actorId: 'userA', aggregateId: d.id, aggregateVersion: 2, type: 'deal.updated' as const, occurredAt: now.toISOString(), deliveryStatus: 'pending' as const};
  await assert.rejects(repo.crmWrite([{record: {...d, version: 2}, expectedVersion: 1, event}], [{record: {...v, version: 3, status: 'sold'}, expectedVersion: 2, event: {...event, id: 'vehicle-failure', aggregateId: v.id, aggregateVersion: 3, type: 'vehicle.updated'}}]), {code: 'CONFLICT'});
  assert.equal((await repo.crmGet('deal', d.id))?.version, 1); assert.equal((await repo.get(v.id))?.status, 'available'); assert.deepEqual(repositories.eventsForTest('A'), before);
});

test('invalid references and pencil/settings values leave deal and outbox unchanged', async () => {
  const {call, create, repositories, v, lead} = await setup(); const d = await create();
  const other = (await call('B', 'POST', '/leads', {customer: {name: 'Other', phone: '', email: '', address: '', notes: '', consent: {status: 'unknown', timestamp: null, source: ''}}, source: 'phone'})).data.lead;
  const count = repositories.eventsForTest('A').length;
  for (const fields of [{vehicleId: 'missing'}, {customerId: other.customerId}, {leadId: other.id}, {type: 'unknown'}]) {
    assert.equal((await call('A', 'POST', '/deals', {vehicleId: v.id, customerId: lead.customerId, type: 'finance', ...fields})).status, 400);
  }
  for (const fields of [{docFee: -1}, {docFee: 1.1}, {pencils: []}, {pencils: [p, p]}, {pencils: [{...p, term: 0}]}, {pencils: [{...p, aprBps: 10001}]}, {trade: {...trade, allowance: -1}}, {vehicleId: 'missing'}, {taxRateBps: 0}]) {
    assert.equal((await call('A', 'PUT', `/deals/${d.id}`, {version: 1, ...fields})).status, 400);
  }
  for (const fields of [{taxRateBps: 1.5}, {taxRateBps: -1}, {taxTradeDifference: 'yes'}, {docFee: -1}, {tenantId: 'B'}]) assert.equal((await call('A', 'PUT', '/settings', {...defaultSettings, version: 0, ...fields})).status, 400);
  assert.equal(repositories.eventsForTest('A').length, count);
  assert.equal((await call('A', 'GET', `/deals/${d.id}`)).data.version, 1);
});

test('stale lead in mixed sold transaction rolls back the vehicle and deal too', async () => {
  const {repositories, create, v, lead} = await setup(); const d = await create(); const repo = repositories.forTenant('A'); const before = repositories.eventsForTest('A');
  const event = {id: 'ed', tenantId: 'A', actorId: 'userA', aggregateId: d.id, aggregateVersion: 2, type: 'deal.updated' as const, occurredAt: now.toISOString(), deliveryStatus: 'pending' as const};
  await assert.rejects(repo.crmWrite([
    {record: {...d, version: 2, status: 'sold'}, expectedVersion: 1, event},
    {record: {...lead, version: 3, stage: 'sold'}, expectedVersion: 2, event: {...event, id: 'el', aggregateId: lead.id, aggregateVersion: 3, type: 'lead.updated'}}
  ], [{record: {...v, version: 2, status: 'sold'}, expectedVersion: 1, event: {...event, id: 'ev', aggregateId: v.id, type: 'vehicle.updated'}}]), {code: 'CONFLICT'});
  assert.equal((await repo.get(v.id))?.version, 1); assert.equal((await repo.crmGet('deal', d.id))?.version, 1); assert.deepEqual(repositories.eventsForTest('A'), before);
});

const leasePencil: Pencil = {...p, price: 3800000, down: 200000, aprBps: 300, term: 36,
  lease: {msrp: 4000000, residualPercentBps: 5500, residualAmount: 2200000, moneyFactorMicro: 1250, acquisitionFee: 65000, securityDeposit: 50000, milesPerYear: 12000}};
const leaseTax = {...defaultSettings, docFee: 20000, taxRateBps: 625};
test('lease hand calculation reconciles every step to the cent with payment-based tax', () => {
  const m = pencilMath(leasePencil, null, leaseTax, vehicle, 'lease'), l = m.lease!;
  for (const [key, value] of Object.entries({grossCapCost: 3885000, adjustedCapCost: 3685000, depreciationFee: 41250, rentCharge: 7356, basePayment: 48606, monthlyTax: 3038, monthlyPayment: 51644, totalPayments: 1859184, totalTax: 109368, driveOff: 301644, purchaseOption: 2200000})) assert.equal(l[key as keyof typeof l], value, key);
  assert.equal(l.depreciationFee + l.rentCharge, l.basePayment);
  assert.equal(m.balance, 3794368); assert.equal(m.totalCost, 2059184); assert.equal(m.amountFinanced, 0);
  assert.equal(m.salesTax, 109368); assert.equal(m.taxableBase, 48606); assert.equal(m.financeCharge, 7356 * 36);
  assert.deepEqual(pencilMath(leasePencil, null, {...leaseTax, taxTradeDifference: true}, vehicle, 'lease'), m);
});
test('lease conversions, rounding, zero money factor, residual floor and invalid inputs', async () => {
  const {leaseMath, moneyFactorToAprBps, residualFromPercent, residualPercentFromAmount} = await import('@freedms/shared');
  assert.equal(moneyFactorToAprBps(1250), 300); assert.equal(moneyFactorToAprBps(0), 0);
  assert.equal(residualFromPercent(4000000, 5500), 2200000); assert.equal(residualFromPercent(1, 5000), 1);
  assert.equal(residualPercentFromAmount(4000000, 2200000), 5500); assert.equal(residualPercentFromAmount(0, 0), 0);
  assert.throws(() => residualPercentFromAmount(0, 1));
  const zero = leaseMath({...leasePencil, lease: {...leasePencil.lease!, moneyFactorMicro: 0}}, null, leaseTax, vehicle);
  assert.equal(zero.rentCharge, 0); assert.equal(zero.basePayment, zero.depreciationFee);
  for (const price of [2200000, 2100000]) assert.equal(leaseMath({...leasePencil, price, down: 85000}, null, leaseTax, vehicle).depreciationFee, 0);
  for (const fields of [{down: 4000000}, {term: 0}, {lease: {...leasePencil.lease!, moneyFactorMicro: 10001}}, {lease: null}]) assert.throws(() => leaseMath({...leasePencil, ...fields}, null, leaseTax, vehicle));
  const withTrade = leaseMath(leasePencil, trade, leaseTax, vehicle);
  assert.equal(withTrade.adjustedCapCost, 3735000);
});
test('lease API drivers, validation, isolation, sale, journal and reports', async () => {
  const {call, create, repositories, v, lead} = await setup();
  await call('A', 'PUT', '/settings', {...leaseTax, version: 0});
  let d = await create({type: 'lease'});
  assert.deepEqual(d.pencils[0].lease, {msrp: v.listPrice, residualPercentBps: 0, residualAmount: 0, moneyFactorMicro: 0, acquisitionFee: 0, securityDeposit: 0, milesPerYear: 12000});
  assert.equal((await call('B', 'GET', `/deals/${d.id}`)).status, 404);
  assert.equal((await call('B', 'PUT', `/deals/${d.id}`, {version: 1, status: 'dead'})).status, 404);
  const input = {...leasePencil, id: d.workingPencilId, aprBps: 9999, lease: {...leasePencil.lease!, residualAmount: null}};
  let r = await call('A', 'PUT', `/deals/${d.id}`, {version: d.version, pencils: [input]}); assert.equal(r.status, 200); d = r.data;
  assert.deepEqual(d.pencils[0].lease, leasePencil.lease); assert.equal(d.pencils[0].aprBps, 300);
  r = await call('A', 'PUT', `/deals/${d.id}`, {version: d.version, pencils: [{...input, lease: {...leasePencil.lease!, residualPercentBps: null}}]}); assert.equal(r.status, 200); d = r.data;
  assert.deepEqual(d.pencils[0].lease, leasePencil.lease);
  const count = repositories.eventsForTest('A').length;
  for (const lease of [leasePencil.lease, {...input.lease, moneyFactorMicro: 10001}, {...input.lease, residualPercentBps: 10001}, {...input.lease, milesPerYear: 100001}, {...input.lease, acquisitionFee: -1}, {...input.lease, extra: 0}, {...input.lease, residualPercentBps: null}, {...input.lease, msrp: 0, residualPercentBps: null, residualAmount: 1}]) {
    assert.equal((await call('A', 'PUT', `/deals/${d.id}`, {version: d.version, pencils: [{...input, lease}]})).status, 400);
  }
  for (const fields of [{down: 4000000}, {term: 0}]) assert.equal((await call('A', 'PUT', `/deals/${d.id}`, {version: d.version, pencils: [{...input, ...fields}]})).status, 400);
  assert.equal(repositories.eventsForTest('A').length, count);
  r = await call('A', 'PUT', `/deals/${d.id}`, {version: d.version, status: 'approved'}); assert.equal(r.status, 200); d = r.data;
  const jacket = (await call('A', 'GET', `/deals/${d.id}/jacket`)).data;
  assert.deepEqual(jacket.numbers, pencilMath(d.pencils[0], d.trade, d, d.vehicle, 'lease'));
  const {renderPacket} = await import('../../web/src/jacket.js');
  const html = renderPacket(jacket);
  for (const label of ['Lease terms', 'End-of-lease purchase option', 'payment-based', '$516.44', '$22,000.00', 'Rent charge', 'Security deposit (refundable)']) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /front gross|dealer cost|Vehicle cost|Amount financed|Finance charge|price minus trade/i);
  r = await call('A', 'PUT', `/deals/${d.id}`, {version: d.version, status: 'sold'}); assert.equal(r.status, 200); d = r.data;
  assert.equal((await call('A', 'GET', `/vehicles/${v.id}`)).data.status, 'sold');
  assert.equal((await call('A', 'GET', `/leads/${lead.id}`)).data.stage, 'sold');
  const repo = repositories.forTenant('A'), entries = await repo.crmList('journal-entry');
  assert.equal(entries.length, 1); const entry = entries[0];
  assert.match(entry.memo, /Lease inception posting/);
  assert.equal(entry.lines.reduce((n, l) => n + l.debit - l.credit, 0), 0);
  assert.equal(entry.lines.find(l => l.accountCode === '4200')?.credit, 85000);
  assert.match(entry.lines.find(l => l.accountCode === '4200')!.explanation, /document fee and acquisition fee/);
  assert.equal((await call('A', 'PUT', `/deals/${d.id}`, {version: d.version, docFee: 0})).status, 400);
  const {salesReport} = await import('../src/reports.js');
  assert.equal((await salesReport(repo, {from: null, to: null})).rows[0].tax, 109368);
});
test('effective type is resolved before pencil validation and nonlease pencils clear lease terms', async () => {
  const {call, create} = await setup(); let d = await create();
  const input = {...leasePencil, id: d.workingPencilId, lease: {...leasePencil.lease!, residualAmount: null}};
  let r = await call('A', 'PUT', `/deals/${d.id}`, {version: d.version, type: 'lease', pencils: [input]});
  assert.equal(r.status, 200); d = r.data; assert.equal(d.pencils[0].lease!.residualAmount, 2200000);
  r = await call('A', 'PUT', `/deals/${d.id}`, {version: d.version, type: 'finance'});
  assert.equal(r.status, 200); assert.equal(r.data.pencils[0].lease, null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commissionFor, pencilMath, type DealView, type GlAccount, type JournalEntry, type Principal } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler, type ApiRequest } from '../src/handler.js';
import { LocalTokens } from '../src/auth.js';
import { accounting, assertBalanced } from '../src/accounting.js';
const now = new Date('2026-10-23T12:00:00Z');
const product = {name: 'Service contract', category: 'service-contract', cost: 90000, retailPrice: 150000, termNotes: '36 months', active: true};
async function setup() {
  const repositories = new MemoryRepositories(), tokens = new LocalTokens('fi-test-secret-at-least-32-characters', () => now.getTime());
  for (const tenantId of ['A', 'B']) await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: now.toISOString()}, {id: `user${tenantId}`, name: tenantId}, {tenantId, userId: `user${tenantId}`, role: 'admin', active: true}, {id: 'provision', tenantId, actorId: `user${tenantId}`, aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  let clock = now;
  const setDate = (date: string) => { clock = new Date(date); };
  const handler = createHandler(repositories, {decode: async () => { throw new Error('No network'); }}, () => clock);
  const raw = (tenant: string, method = 'GET', path = '/accounting/accounts', body?: unknown, query?: ApiRequest['query']) => handler({method, path, body: body === undefined ? undefined : JSON.stringify(body), query, claims: tokens.verify(tokens.issue(`user${tenant}`, tenant))});
  const call = async (...args: Parameters<typeof raw>) => { const r = await raw(...args); return {status: r.statusCode, ...JSON.parse(r.body)}; };
  const createDeal = async (tenant = 'A'): Promise<DealView> => {
    const v = (await call(tenant, 'POST', '/vehicles', {stockNumber: 'test', vin: '1HGCM82633A004352', year: 2003, make: 'Test', model: 'Test', trim: '', status: 'available', listPrice: 1000000, cost: 700000, reconCosts: [{description: 'Repair', amount: 50000}], dateStocked: '2026-10-19', location: '', notes: ''})).data;
    const lead = (await call(tenant, 'POST', '/leads', {customer: {name: 'Buyer', phone: '', email: '', address: '', notes: '', consent: {status: 'unknown', timestamp: null, source: ''}}, source: 'walk-in', vehicleId: v.id})).data.lead;
    return (await call(tenant, 'POST', '/deals', {vehicleId: v.id, customerId: lead.customerId, type: 'finance'})).data;
  };
  return {repositories, handler, call, raw, createDeal, setDate};
}
const sum = (entry: JournalEntry, side: 'debit' | 'credit') => entry.lines.reduce((s, l) => s + l[side], 0);
async function sell(call: Awaited<ReturnType<typeof setup>>['call'], d: DealView, fields = {}) {
  const approved = await call('A', 'PUT', `/deals/${d.id}`, {version: d.version, status: 'approved', ...fields}); assert.equal(approved.status, 200);
  const sold = await call('A', 'PUT', `/deals/${d.id}`, {version: approved.data.version, status: 'sold'}); assert.equal(sold.status, 200, JSON.stringify(sold)); return sold.data as DealView;
}
test('Accounting default chart, CRUD, duplicate conflicts, validation, tenant isolation and authorization', async () => {
  const {call, handler, repositories} = await setup();
  assert.deepEqual(await repositories.forTenant('A').crmList('gl-account'), []);
  const defaults = (await call('A')).data as GlAccount[];
  assert.equal(defaults.length, 12); assert.deepEqual(defaults.map(a => a.code), defaults.map(a => a.code).sort());
  assert.equal((await call('A')).data.length, 12);
  const input = {code: '9000', name: 'Custom <account>', type: 'expense'};
  const created = await call('A', 'POST', '/accounting/accounts', input); assert.equal(created.status, 201); const a = created.data as GlAccount;
  assert.equal(a.active, true); assert.equal(a.system, false);
  assert.equal((await call('A', 'POST', '/accounting/accounts', input)).status, 409);
  const changed = await call('A', 'PUT', `/accounting/accounts/${a.id}`, {version: 1, name: 'Renamed', active: false}); assert.equal(changed.status, 200); assert.equal(changed.data.active, false);
  assert.equal((await call('A', 'PUT', `/accounting/accounts/${a.id}`, {version: 1, name: 'stale', active: true})).status, 409);
  for (const extra of [{code: '9001'}, {type: 'income'}]) assert.equal((await call('A', 'PUT', `/accounting/accounts/${a.id}`, {version: 2, name: 'Bad', active: true, ...extra})).status, 400);
  for (const fields of [{code: 'abc'}, {code: '12'}, {code: '12345678901'}, {name: ''}, {name: 'x'.repeat(121)}, {type: 'bad'}, {active: 'yes'}, {tenantId: 'B'}]) assert.equal((await call('A', 'POST', '/accounting/accounts', {...input, code: '9001', ...fields})).status, 400);
  assert.equal((await call('B')).data.length, 12);
  assert.equal(await repositories.forTenant('B').crmGet('gl-account', a.id), undefined);
  assert.equal((await call('B', 'PUT', `/accounting/accounts/${a.id}`, {version: 1, name: 'Bad', active: true})).status, 404);
  assert.equal((await call('A', 'PUT', '/accounting/accounts/missing', {version: 1, name: 'Bad', active: true})).status, 404);
  assert.equal((await handler({method: 'GET', path: '/accounting/accounts'})).statusCode, 401);
  await assert.rejects(accounting({method: 'POST', path: '/accounting/accounts', body: JSON.stringify(input)}, {tenantId: 'A', userId: 'userA', role: 'reader'} as unknown as Principal, repositories.forTenant('A'), now), {status: 403});
  for (const [method, path] of [['DELETE', '/accounting/accounts'], ['PUT', '/accounting/accounts'], ['GET', `/accounting/accounts/${a.id}`], ['POST', '/accounting/journal'], ['POST', '/accounting/balances']]) assert.equal((await call('A', method, path)).status, 405);
  assert.equal((await call('A', 'GET', '/accounting/unknown')).status, 404);
  for (const path of ['/accounting/journal', '/accounting/trial-balance', '/accounting/commissions']) {
    for (const query of [{from: '2026-02-30'}, {from: '2026-10-24', to: '2026-10-23'}, {extra: 'bad'}]) assert.equal((await call('A', 'GET', path, undefined, query)).status, 400);
  }
  const event = repositories.eventsForTest('A').find(e => e.aggregateId === a.id)!;
  for (const [tenant, record, outbox] of [['B', a, event], ['A', {...a, tenantId: 'B'}, event], ['A', a, {...event, tenantId: 'B'}]] as const) await assert.rejects(repositories.forTenant(tenant).crmWrite([{record, expectedVersion: 0, event: outbox}]), /scope/);
});
test('Accounting exact posting, trial balance sales tie-out, commissions, snapshots, reversal and outbox', async () => {
  const {call, repositories, createDeal, setDate} = await setup();
  assert.equal((await call('A', 'PUT', '/settings', {version: 0, taxRateBps: 625, taxTradeDifference: true, docFee: 10000, commissionRateBps: 2500})).status, 200);
  for (const commissionRateBps of [-1, 10001, 1.5, null]) assert.equal((await call('A', 'PUT', '/settings', {version: 1, taxRateBps: 625, taxTradeDifference: true, docFee: 10000, commissionRateBps})).status, 400);
  const accepted = (await call('A', 'POST', '/fi-products', product)).data;
  const declined = (await call('A', 'POST', '/fi-products', {...product, name: 'Declined'})).data;
  let d = await createDeal();
  assert.deepEqual((await call('A', 'GET', `/accounting/deals/${d.id}`)).data.entries, []);
  const trade = {year: '2010', make: 'Test', model: 'Trade', vin: '', allowance: 200000, payoff: 250000, actualCashValue: 150000};
  d = (await call('A', 'PUT', `/deals/${d.id}`, {version: 1, status: 'approved', trade, pencils: [{...d.pencils[0], fiSelections: [{productId: accepted.id, status: 'accepted'}, {productId: declined.id, status: 'declined'}]}]})).data;
  assert.deepEqual((await call('A', 'GET', '/accounting/journal')).data, []);
  d = (await call('A', 'PUT', `/deals/${d.id}`, {version: d.version, status: 'sold'})).data;
  const entry = (await call('A', 'GET', '/accounting/journal')).data[0] as JournalEntry;
  const m = pencilMath(d.pencils[0], trade, d, d.vehicle, d.type);
  // D + B + (VC + A - ACV) + FC + ACV - (P + T + F + FR + VC + PO + FC) = 0,
  // since B = P + F + T + FR - A + PO - D.
  assert.equal(sum(entry, 'debit'), sum(entry, 'credit')); assert.equal(sum(entry, 'debit'), 2300000);
  assert.deepEqual(entry.lines.map(l => [l.accountCode, l.debit, l.credit]), [
    ['1100', m.balance, 0], ['5000', 800000, 0], ['5100', 90000, 0], ['1200', 150000, 0], ['4000', 0, 1000000], ['2000', 0, 50000], ['4200', 0, 10000], ['4100', 0, 150000], ['1200', 0, 750000], ['2100', 0, 250000], ['2200', 0, 90000],
  ]);
  assert.ok(entry.lines.every(l => l.explanation.length > 0)); assert.equal(entry.date, now.toISOString());
  assert.equal((await call('A', 'PUT', `/deals/${d.id}`, {version: d.version, status: 'sold'})).status, 400);
  assert.equal((await call('A', 'GET', '/accounting/journal')).data.length, 1);
  const pack = (await call('A', 'GET', `/accounting/deals/${d.id}`)).data; assert.deepEqual(pack.numbers, m); assert.equal(pack.commission, 50000); assert.deepEqual(pack.entries[0].lines, entry.lines);
  assert.equal((await call('B', 'GET', `/accounting/deals/${d.id}`)).status, 404);
  assert.deepEqual((await call('B', 'GET', '/accounting/journal')).data, []);
  assert.equal(await repositories.forTenant('B').crmGet('journal-entry', entry.id), undefined);
  const entryEvent = repositories.eventsForTest('A').find(e => e.aggregateId === entry.id)!;
  await assert.rejects(repositories.forTenant('B').crmWrite([{record: entry, event: entryEvent, expectedVersion: 0}]), /scope/);
  await assert.rejects(repositories.forTenant('A').crmWrite([{record: {...entry, version: 2}, event: {...entryEvent, aggregateVersion: 2}, expectedVersion: 1}]), /immutable/);
  const balances = (await call('A', 'GET', '/accounting/balances')).data;
  assert.equal(balances.length, 12); assert.equal(balances.find((b: GlAccount) => b.code === '1000').balance, 0);
  for (const row of balances) { assert.equal(row.debit, entry.lines.filter(l => l.accountId === row.accountId).reduce((s, l) => s + l.debit, 0)); assert.equal(row.credit, entry.lines.filter(l => l.accountId === row.accountId).reduce((s, l) => s + l.credit, 0)); }
  assert.deepEqual((await call('A', 'GET', '/accounting/journal', undefined, {accountId: 'foreign'})).data, []);
  assert.equal((await call('A', 'GET', '/accounting/journal', undefined, {accountId: 'account-1200', dealId: d.id})).data.length, 1);
  setDate('2026-10-24T00:00:00Z'); await sell(call, await createDeal());
  const query = {from: '2026-10-23', to: '2026-10-23'};
  const trial = (await call('A', 'GET', '/accounting/trial-balance', undefined, query)).data;
  const sales = (await call('A', 'GET', '/reports/sales', undefined, query)).data;
  assert.equal(sales.rows.length, 1); assert.equal(trial.totals.debit, trial.totals.credit); assert.equal(trial.totals.balanced, true);
  for (const [code, field] of [['4000', 'price'], ['4100', 'fiRetail'], ['2000', 'tax'], ['4200', 'fees']]) assert.equal(trial.rows.find((r: GlAccount) => r.code === code).credit, sales.rows.reduce((s: number, r: Record<string, number>) => s + r[field], 0));
  assert.equal(trial.rows.find((r: GlAccount) => r.code === '5000').debit, sales.rows.reduce((s: number, r: {price: number; frontGross: number}) => s + r.price - r.frontGross, 0));
  const commissions = (await call('A', 'GET', '/accounting/commissions', undefined, query)).data;
  assert.equal(commissions.rateBps, 2500); assert.equal(commissions.rows.length, 1); assert.equal(commissions.rows[0].commission, 50000); assert.deepEqual(commissions.totals, {frontGross: 200000, commission: 50000});
  const account = (await call('A')).data.find((a: GlAccount) => a.code === '4000');
  await call('A', 'PUT', `/accounting/accounts/${account.id}`, {version: account.version, name: 'Renamed sales', active: false});
  assert.equal((await call('A', 'GET', '/accounting/journal', undefined, {dealId: d.id})).data[0].lines.find((l: {accountCode: string}) => l.accountCode === '4000').accountName, 'Vehicle sales');
  for (const method of ['PUT', 'PATCH', 'DELETE']) assert.equal((await call('A', method, `/accounting/journal/${entry.id}`, {})).status, 405);
  assert.equal((await call('B', 'POST', `/accounting/journal/${entry.id}/reverse`, {})).status, 404);
  assert.equal((await call('A', 'POST', `/accounting/journal/${entry.id}/reverse`, {memo: 'no'})).status, 400);
  const reversed = await call('A', 'POST', `/accounting/journal/${entry.id}/reverse`, {}); assert.equal(reversed.status, 201);
  assert.deepEqual(reversed.data.lines, entry.lines.map(l => ({...l, debit: l.credit, credit: l.debit, explanation: `Reversal: ${l.explanation}`})));
  assert.equal((await call('A', 'POST', `/accounting/journal/${entry.id}/reverse`, {})).status, 409);
  assert.equal((await call('A', 'POST', `/accounting/journal/${reversed.data.id}/reverse`, {})).status, 409);
  assert.deepEqual(await repositories.forTenant('A').crmGet('journal-entry', entry.id), Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'reversed')));
  const net = (await call('A', 'GET', `/accounting/deals/${d.id}`)).data.entries as JournalEntry[];
  assert.equal(net.length, 2);
  for (const a of balances) assert.equal(net.flatMap(e => e.lines).filter(l => l.accountId === a.accountId).reduce((s, l) => s + l.debit - l.credit, 0), 0);
  const events = repositories.eventsForTest('A').filter(e => ['gl-account.created', 'gl-account.updated', 'journal-entry.created'].includes(e.type));
  for (const type of ['gl-account.created', 'gl-account.updated', 'journal-entry.created']) assert.ok(events.some(e => e.type === type));
  for (const event of events) { assert.equal(event.tenantId, 'A'); assert.equal(event.actorId, 'userA'); assert.deepEqual(Object.keys(event).sort(), ['id', 'tenantId', 'actorId', 'aggregateId', 'aggregateVersion', 'type', 'occurredAt', 'deliveryStatus'].sort()); }
});
test('Accounting cash, overpayment, dead deals, commission rounding and legacy settings', async () => {
  const {call, createDeal, repositories} = await setup();
  assert.equal((await call('A', 'GET', '/settings')).data.commissionRateBps, 0);
  let dead = await createDeal(); dead = (await call('A', 'PUT', `/deals/${dead.id}`, {version: 1, status: 'dead'})).data;
  assert.deepEqual((await call('A', 'GET', `/accounting/deals/${dead.id}`)).data.entries, []);
  assert.deepEqual(await repositories.forTenant('A').crmList('journal-entry'), []);
  for (const down of [100000, 2000000]) {
    const d = await createDeal(); await sell(call, d, {type: 'cash', pencils: [{...d.pencils[0], down}]});
    const entry = (await call('A', 'GET', `/accounting/deals/${d.id}`)).data.entries[0] as JournalEntry;
    assert.equal(sum(entry, 'debit'), sum(entry, 'credit')); assert.equal(entry.lines.find(l => l.accountCode === '1000')!.debit, down);
    if (down > 1000000) { assert.equal(entry.lines.find(l => l.accountCode === '2300')!.credit, 1000000); assert.equal(entry.lines.some(l => l.accountCode === '1100'), false); }
  }
  assert.equal((await call('A', 'GET', '/accounting/commissions')).data.totals.commission, 0);
  await call('A', 'PUT', '/settings', {version: 0, taxRateBps: 0, taxTradeDifference: false, docFee: 0, commissionRateBps: 2500});
  await call('A', 'PUT', '/settings', {version: 1, taxRateBps: 0, taxTradeDifference: false, docFee: 0});
  assert.equal((await call('A', 'GET', '/settings')).data.commissionRateBps, 2500);
  for (const price of [750002, 750000, 700000]) {
    const d = await createDeal(); await sell(call, d, {pencils: [{...d.pencils[0], price}]});
    assert.equal((await call('A', 'GET', `/accounting/deals/${d.id}`)).data.commission, price === 750002 ? 1 : 0);
  }
  assert.equal(commissionFor(2, 2500), 1); assert.equal(commissionFor(-1, 2500), 0);
  assert.deepEqual((await call('A', 'GET', '/accounting/commissions', undefined, {from: '2026-11-01'})).data.rows, []);
  assert.throws(() => assertBalanced([])); assert.throws(() => assertBalanced([{accountId: 'x', accountCode: '1000', accountName: 'Cash', debit: 1, credit: 0, explanation: 'Unbalanced'}]));
});
test('Concurrent lazy initialization, account uniqueness, selling and reversals remain exactly once', async () => {
  const {call, createDeal, repositories} = await setup();
  const charts = await Promise.all([call('A'), call('A')]); assert.ok(charts.every(c => c.status === 200 && c.data.length === 12));
  const creates = await Promise.all([call('A', 'POST', '/accounting/accounts', {code: '9999', name: 'One', type: 'asset'}), call('A', 'POST', '/accounting/accounts', {code: '9999', name: 'Two', type: 'asset'})]);
  assert.deepEqual(creates.map(c => c.status).sort(), [201, 409]);
  let d = await createDeal(); d = (await call('A', 'PUT', `/deals/${d.id}`, {version: 1, status: 'approved'})).data;
  const sold = await Promise.all([call('A', 'PUT', `/deals/${d.id}`, {version: d.version, status: 'sold'}), call('A', 'PUT', `/deals/${d.id}`, {version: d.version, status: 'sold'})]); assert.deepEqual(sold.map(c => c.status).sort(), [200, 409]);
  const entries = await repositories.forTenant('A').crmList('journal-entry'); assert.equal(entries.length, 1);
  const reversed = await Promise.all([call('A', 'POST', `/accounting/journal/${entries[0].id}/reverse`, {}), call('A', 'POST', `/accounting/journal/${entries[0].id}/reverse`, {})]); assert.deepEqual(reversed.map(c => c.status).sort(), [201, 409]);
  assert.ok((await call('A', 'GET', '/accounting/balances')).data.every((r: {balance: number}) => r.balance === 0));
});
test('Sale seeds defaults without visiting accounting; invalid posting fails closed without changing deal or vehicle', async () => {
  const {call, createDeal, repositories} = await setup();
  const d = await createDeal();
  assert.equal((await repositories.forTenant('A').crmList('gl-account')).length, 0);
  await sell(call, d);
  assert.equal((await repositories.forTenant('A').crmList('gl-account')).length, 12);
  assert.equal((await repositories.forTenant('A').crmList('journal-entry')).length, 1);
  // An extreme trade underallowance would make the specified COGS debit negative.
  // Reject before committing any deal/vehicle/lead or journal changes.
  let bad = await createDeal();
  bad = (await call('A', 'PUT', `/deals/${bad.id}`, {version: 1, status: 'approved', trade: {year: '2020', make: 'Trade', model: 'Trade', vin: '', allowance: 0, payoff: 0, actualCashValue: 1000000}})).data;
  const count = repositories.eventsForTest('A').length;
  assert.equal((await call('A', 'PUT', `/deals/${bad.id}`, {version: bad.version, status: 'sold'})).status, 400);
  assert.equal((await call('A', 'GET', `/deals/${bad.id}`)).data.status, 'approved');
  assert.equal((await call('A', 'GET', `/vehicles/${bad.vehicleId}`)).data.status, 'available');
  assert.equal((await repositories.forTenant('A').crmList('journal-entry')).length, 1);
  assert.equal(repositories.eventsForTest('A').length, count);
});
test('Legacy stored settings missing commission remain readable and editable', async () => {
  const {repositories, call} = await setup(); const date = now.toISOString();
  await repositories.forTenant('A').crmWrite([{record: {id: 'workspace', kind: 'settings', tenantId: 'A', version: 1, createdAt: date, updatedAt: date, taxRateBps: 0, taxTradeDifference: false, docFee: 0}, expectedVersion: 0, event: {id: 'legacy-settings', tenantId: 'A', actorId: 'userA', aggregateId: 'workspace', aggregateVersion: 1, type: 'settings.created', occurredAt: date, deliveryStatus: 'pending'}}]);
  assert.equal((await call('A', 'GET', '/settings')).data.commissionRateBps, 0);
  const saved = await call('A', 'PUT', '/settings', {version: 1, taxRateBps: 625, taxTradeDifference: true, docFee: 10000});
  assert.equal(saved.status, 200); assert.equal(saved.data.commissionRateBps, 0);
});

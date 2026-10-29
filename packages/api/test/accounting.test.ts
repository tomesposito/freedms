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
    const v = (await call(tenant, 'POST', '/vehicles', {mileage: null, stockNumber: 'test', vin: '1HGCM82633A004352', year: 2003, make: 'Test', model: 'Test', trim: '', status: 'available', listPrice: 1000000, cost: 700000, reconCosts: [{description: 'Repair', amount: 50000}], dateStocked: '2026-10-19', location: '', notes: ''})).data;
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
  assert.equal(defaults.length, 20); assert.deepEqual(defaults.map(a => a.code), defaults.map(a => a.code).sort());
  assert.equal((await call('A')).data.length, 20);
  const input = {code: '9000', name: 'Custom <account>', type: 'expense'};
  const created = await call('A', 'POST', '/accounting/accounts', input); assert.equal(created.status, 201); const a = created.data as GlAccount;
  assert.equal(a.active, true); assert.equal(a.system, false);
  assert.equal((await call('A', 'POST', '/accounting/accounts', input)).status, 409);
  const changed = await call('A', 'PUT', `/accounting/accounts/${a.id}`, {version: 1, name: 'Renamed', active: false}); assert.equal(changed.status, 200); assert.equal(changed.data.active, false);
  assert.equal((await call('A', 'PUT', `/accounting/accounts/${a.id}`, {version: 1, name: 'stale', active: true})).status, 409);
  for (const extra of [{code: '9001'}, {type: 'income'}]) assert.equal((await call('A', 'PUT', `/accounting/accounts/${a.id}`, {version: 2, name: 'Bad', active: true, ...extra})).status, 400);
  for (const fields of [{code: 'abc'}, {code: '12'}, {code: '12345678901'}, {name: ''}, {name: 'x'.repeat(121)}, {type: 'bad'}, {active: 'yes'}, {tenantId: 'B'}]) assert.equal((await call('A', 'POST', '/accounting/accounts', {...input, code: '9001', ...fields})).status, 400);
  assert.equal((await call('B')).data.length, 20);
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
  assert.equal(balances.length, 20); assert.equal(balances.find((b: GlAccount) => b.code === '1000').balance, 0);
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
  const charts = await Promise.all([call('A'), call('A')]); assert.ok(charts.every(c => c.status === 200 && c.data.length === 20));
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
  assert.equal((await repositories.forTenant('A').crmList('gl-account')).length, 20);
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

test('Sold-deal receivables appear once in AR and receipts tie aging to the existing GL model', async () => {
  const {call, createDeal} = await setup();
  const d = await createDeal(); await sell(call, d);
  const before = (await call('A', 'GET', '/accounting/ar')).data;
  assert.equal(before.rows.length, 1); assert.equal(before.rows[0].reference, d.id);
  const balance = (await call('A', 'GET', '/accounting/balances')).data.find((r: {code: string}) => r.code === '1100').balance;
  assert.equal(before.total, balance);
  const paid = await call('A', 'POST', `/accounting/ar/${before.rows[0].id}/payments`, {amount: 12345, cashAccountId: 'account-1000', reference: 'Lender funding'});
  assert.equal(paid.status, 201);
  const after = (await call('A', 'GET', '/accounting/ar')).data;
  const balances = (await call('A', 'GET', '/accounting/balances')).data;
  assert.equal(after.total, balance - 12345);
  assert.equal(after.total, balances.find((r: {code: string}) => r.code === '1100').balance);
  assert.equal(balances.find((r: {code: string}) => r.code === '1000').balance, 12345);
  assert.equal((await call('A', 'GET', `/accounting/deals/${d.id}`)).data.entries.filter((j: JournalEntry) => j.source === 'deal-posting').length, 1);
});

test('Compact accounting reads preserve exact JSON, inclusive dates, account order and tenant scope', async t => {
  const {write, ensureDefaultAccounts} = await import('../src/accounting.js');
  const {DynamoRepositories} = await import('../src/dynamo.js');
  const {QueryCommand} = await import('@aws-sdk/lib-dynamodb');
  const memory = new MemoryRepositories(), repo = memory.forTenant('A');
  const principal = {tenantId: 'A', userId: 'userA', role: 'admin'} as Principal;
  const accounts = await ensureDefaultAccounts(repo, principal, now);
  const entry = (id: string, date: string, amount: number): JournalEntry => ({id, tenantId: 'A', version: 1, createdAt: now.toISOString(), updatedAt: now.toISOString(), kind: 'journal-entry', date, source: 'deal-posting', dealId: null, memo: id, reversesEntryId: null, reversedByEntryId: null,
    lines: [{accountId: 'account-1000', accountCode: '1000', accountName: 'Cash', debit: amount, credit: 0, explanation: ''}, {accountId: 'account-4000', accountCode: '4000', accountName: 'Sales', debit: 0, credit: amount, explanation: ''}]});
  const entries = [entry('before', '2026-10-09', 7), entry('from', '2026-10-10T23:59:59Z', 101), entry('to', '2026-10-20T00:00:00Z', 203), entry('after', '2026-10-21', 11)];
  for (const e of entries) await repo.crmWrite([write(e, principal)]);
  let pages = 0;
  const dynamo = new DynamoRepositories('offline', {send: async (command: InstanceType<typeof QueryCommand>) => {
    assert.ok(command instanceof QueryCommand);
    assert.equal(command.input.ConsistentRead, true);
    const values = command.input.ExpressionAttributeValues!;
    assert.ok(['GL-ACCOUNT#', 'JOURNAL-ENTRY#'].includes(values[':prefix']));
    assert.ok(['TENANT#A', 'TENANT#B'].includes(values[':pk']));
    const rows = values[':pk'] === 'TENANT#B' ? [] : values[':prefix'] === 'GL-ACCOUNT#' ? accounts : entries;
    const offset = Number(command.input.ExclusiveStartKey?.offset ?? 0);
    pages++;
    return {Items: rows.slice(offset, offset + 2).map(data => ({data})), ...(offset + 2 < rows.length ? {LastEvaluatedKey: {offset: offset + 2}} : {})};
  }} as any);
  const expectedRows = (amount: number) => accounts.map(a => ({accountId: a.id, code: a.code, name: a.name, type: a.type, debit: a.code === '1000' ? amount : 0, credit: a.code === '4000' ? amount : 0, balance: ['1000', '4000'].includes(a.code) ? amount : 0}));
  const range = {from: '2026-10-10', to: '2026-10-20'};
  const clone = structuredClone;
  const spy = t.mock.method(globalThis, 'structuredClone', (value: unknown) => {
    assert.deepEqual(value, expectedRows(304));
    return clone(value);
  });
  assert.deepEqual(await repo.accountingBalances(range), expectedRows(304));
  spy.mock.restore();
  for (const repositories of [memory, dynamo]) {
    const scoped = repositories.forTenant('A');
    const guarded = new Proxy(scoped, {get(target, property) {
      if (property === 'list') return () => { throw new Error('Full collection read'); };
      if (property === 'crmList') return (kind: string) => { assert.equal(kind, 'gl-account'); return target.crmList('gl-account'); };
      return Reflect.get(target, property);
    }});
    for (const [query, amount] of [[range, 304], [{from: null, to: null}, 322], [{from: range.from, to: null}, 315], [{from: null, to: range.to}, 311], [{from: '2027-01-01', to: null}, 0]] as const) {
      assert.deepEqual(await scoped.accountingBalances(query), expectedRows(amount));
      const result = await accounting({method: 'GET', path: '/accounting/trial-balance', query: {...(query.from ? {from: query.from} : {}), ...(query.to ? {to: query.to} : {})}}, principal, guarded, now);
      assert.equal(result.body, JSON.stringify({data: {...query, rows: expectedRows(amount).filter(r => r.debit || r.credit), totals: {debit: amount, credit: amount, balanced: true}}}));
    }
    const balances = await accounting({method: 'GET', path: '/accounting/balances'}, principal, guarded, now);
    assert.equal(balances.body, JSON.stringify({data: expectedRows(322), totals: {debit: 322, credit: 322, balanced: true}}));
    assert.deepEqual(await repositories.forTenant('B').accountingBalances(range), []);
  }
  assert.ok(pages > 20);
  for (const row of [accounts[0], entries[0]]) {
    const corrupt = new DynamoRepositories('offline', {send: async () => ({Items: [{data: {...row, tenantId: 'B'}}]})} as any);
    await assert.rejects(corrupt.forTenant('A').accountingBalances(range), /scope/);
  }
  // Unknown accounts do not become output rows, so totals can be unbalanced.
  const orphan = entry('orphan', range.from, 5); orphan.lines[1].accountId = 'missing';
  await repo.crmWrite([write(orphan, principal)]);
  const result = JSON.parse((await accounting({method: 'GET', path: '/accounting/trial-balance', query: range}, principal, repo, now)).body);
  assert.deepEqual(result.data.totals, {debit: 309, credit: 304, balanced: false});
});

test('Accounting cache is detached, bounded, tenant-local and invalidated only by journal/account writes', async t => {
  const {write, ensureDefaultAccounts} = await import('../src/accounting.js');
  const memory = new MemoryRepositories(), repo = memory.forTenant('A');
  const principal = {tenantId: 'A', userId: 'userA', role: 'admin'} as Principal;
  const range = {from: null, to: null};
  assert.deepEqual(await repo.accountingBalances(range), []);
  const accounts = await ensureDefaultAccounts(repo, principal, now);
  const expected = await repo.accountingBalances(range);
  assert.equal(expected.length, accounts.length); // Real seed invalidates the empty cache.
  const changed = await repo.accountingBalances(range); changed[0].name = 'mutated';
  assert.deepEqual(await repo.accountingBalances(range), expected);
  await ensureDefaultAccounts(repo, principal, now); // No-op seed must preserve the cache.
  await repo.crmWrite([{record: {id: 'workspace', kind: 'settings', tenantId: 'A', version: 1, createdAt: now.toISOString(), updatedAt: now.toISOString(), taxRateBps: 0, taxTradeDifference: false, docFee: 0}, expectedVersion: 0, event: {id: 'settings', tenantId: 'A', actorId: 'userA', aggregateId: 'workspace', aggregateVersion: 1, type: 'settings.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'}}]);
  // A raw CRM scan would call Map.values; a cache hit only clones compact rows.
  const guard = t.mock.method(Map.prototype, 'values', () => { throw new Error('Unexpected raw scan'); });
  assert.deepEqual(await memory.forTenant('A').accountingBalances(range), expected);
  guard.mock.restore();
  const account = accounts[0];
  await repo.crmWrite([write({...account, name: 'Renamed', version: 2}, principal, 1)]);
  assert.equal((await repo.accountingBalances(range))[0].name, 'Renamed');
  const journal: JournalEntry = {id: 'j', tenantId: 'A', kind: 'journal-entry', version: 1, createdAt: now.toISOString(), updatedAt: now.toISOString(), date: now.toISOString(), source: 'deal-posting', dealId: null, memo: '', reversesEntryId: null, reversedByEntryId: null, lines: [{accountId: account.id, accountCode: account.code, accountName: account.name, debit: 123, credit: 0, explanation: ''}]};
  await repo.crmWrite([write(journal, principal)]);
  assert.equal((await repo.accountingBalances(range))[0].debit, 123);
  const otherPrincipal = {...principal, tenantId: 'B'};
  await memory.forTenant('B').crmWrite([write({...account, tenantId: 'B'}, otherPrincipal), write({...journal, tenantId: 'B', lines: journal.lines.map(l => ({...l, debit: 456}))}, otherPrincipal)]);
  assert.equal((await memory.forTenant('B').accountingBalances(range))[0].debit, 456);
  assert.equal((await repo.accountingBalances(range))[0].debit, 123);
  for (let day = 1; day <= 5; day++) await repo.accountingBalances({from: `2026-10-0${day}`, to: null});
  const evicted = t.mock.method(Map.prototype, 'values', () => { throw new Error('Evicted range scanned'); });
  await assert.rejects(repo.accountingBalances(range), /Evicted range scanned/);
  evicted.mock.restore();
  assert.equal((await repo.accountingBalances(range))[0].debit, 123);
});

test('Departmental compact reads preserve legacy JSON, grouping, ranges, reversals and tenant scope', async () => {
  const {write, ensureDefaultAccounts, accountBalances, departmentalStatement} = await import('../src/accounting.js');
  const {DynamoRepositories} = await import('../src/dynamo.js');
  const {QueryCommand} = await import('@aws-sdk/lib-dynamodb');
  const memory = new MemoryRepositories(), repo = memory.forTenant('A');
  const principal = {tenantId: 'A', userId: 'userA', role: 'admin'} as Principal;
  await ensureDefaultAccounts(repo, principal, now);
  const custom: GlAccount = {id: 'account-9000', tenantId: 'A', version: 1, createdAt: now.toISOString(), updatedAt: now.toISOString(), kind: 'gl-account', code: '9000', name: 'Custom expense', type: 'expense', active: true, system: false};
  await repo.crmWrite([write(custom, principal)]);
  const sale = (await repo.crmGet('gl-account', 'account-4000'))!;
  await repo.crmWrite([write({...sale, name: 'Current sales name', active: false, version: 2}, principal, 1)]);
  const accounts = await ensureDefaultAccounts(repo, principal, now);
  const entry = (id: string, date: string, amounts: [string, number, number][]): JournalEntry => ({id, tenantId: 'A', version: 1, createdAt: now.toISOString(), updatedAt: now.toISOString(), kind: 'journal-entry', date, source: 'manual', dealId: null, memo: id, reversesEntryId: null, reversedByEntryId: null,
    lines: amounts.map(([code, debit, credit]) => ({accountId: `account-${code}`, accountCode: code, accountName: 'Historical name', debit, credit, explanation: ''}))});
  const original = entry('original', '2026-10-10T23:59:59Z', [['4000', 0, 1000], ['5000', 400, 0], ['5300', 200, 0], ['4500', 0, 300], ['9000', 50, 0], ['1000', 650, 0]]);
  const reversed = entry('reversed', '2026-10-20T00:00:00Z', [['4100', 0, 70], ['1000', 70, 0]]);
  const reversal: JournalEntry = {...reversed, id: 'reversal', source: 'reversal', reversesEntryId: reversed.id, lines: reversed.lines.map(l => ({...l, debit: l.credit, credit: l.debit}))};
  // Deliberately unsorted dates and unknown-account lines exercise selection independently of journal sorting.
  const entries = [entry('after', '2026-10-21', [['4000', 0, 11], ['1000', 11, 0]]), original, reversed, reversal,
    entry('before', '2026-10-09', [['4000', 0, 7], ['1000', 7, 0]]), entry('unknown', '2026-10-20', [['missing', 0, 5], ['1000', 5, 0]])];
  for (const e of entries) await repo.crmWrite([write(e, principal)]);
  const other = {...principal, tenantId: 'B'};
  const otherAccounts = await ensureDefaultAccounts(memory.forTenant('B'), other, now);
  let pages = 0;
  const dynamo = new DynamoRepositories('offline', {send: async (command: InstanceType<typeof QueryCommand>) => {
    assert.ok(command instanceof QueryCommand);
    assert.equal(command.input.ConsistentRead, true);
    const values = command.input.ExpressionAttributeValues!;
    assert.ok(['GL-ACCOUNT#', 'JOURNAL-ENTRY#'].includes(values[':prefix']));
    assert.ok(['TENANT#A', 'TENANT#B'].includes(values[':pk']));
    const rows = values[':prefix'] === 'GL-ACCOUNT#' ? values[':pk'] === 'TENANT#A' ? [...accounts].reverse() : otherAccounts : values[':pk'] === 'TENANT#A' ? entries : [];
    const offset = Number(command.input.ExclusiveStartKey?.offset ?? 0); pages++;
    return {Items: rows.slice(offset, offset + 2).map(data => ({data})), ...(offset + 2 < rows.length ? {LastEvaluatedKey: {offset: offset + 2}} : {})};
  }} as any);
  const guard = (scoped: ReturnType<MemoryRepositories['forTenant']>) => new Proxy(scoped, {get(target, property) {
    if (property === 'list') return () => { throw new Error('Full collection read'); };
    if (property === 'crmList') return (kind: string) => { assert.equal(kind, 'gl-account', 'Only seeding may list records'); return target.crmList('gl-account'); };
    return Reflect.get(target, property);
  }});
  const read = (scoped: ReturnType<MemoryRepositories['forTenant']>, who = principal, query: ApiRequest['query'] = {}) => accounting({method: 'GET', path: '/accounting/departmental', query}, who, guard(scoped), now);
  const range = {from: '2026-10-10', to: '2026-10-20'};
  const row = (code: string, debit: number, credit: number, balance: number) => {
    const a = accounts.find(a => a.code === code)!;
    return {accountId: a.id, code, name: a.name, type: a.type, debit, credit, balance};
  };
  const expected = {data: {...range, departments: [
    {department: 'sales', rows: [row('4000', 0, 1000, 1000), row('4100', 70, 70, 0), row('5000', 400, 0, 400)], income: 1000, expenses: 400, grossProfit: 600},
    {department: 'service', rows: [row('5300', 200, 0, 200)], income: 0, expenses: 200, grossProfit: -200},
    {department: 'parts', rows: [row('4500', 0, 300, 300)], income: 300, expenses: 0, grossProfit: 300},
    {department: 'other', rows: [row('9000', 50, 0, 50)], income: 0, expenses: 50, grossProfit: -50}
  ], totals: {income: 1300, expenses: 650, grossProfit: 650}}};
  const empty = {departments: ['sales', 'service', 'parts', 'other'].map(department => ({department, rows: [], income: 0, expenses: 0, grossProfit: 0})), totals: {income: 0, expenses: 0, grossProfit: 0}};
  for (const repositories of [memory, dynamo]) {
    const scoped = repositories.forTenant('A');
    assert.equal((await read(scoped, principal, range)).body, JSON.stringify(expected));
    for (const query of [range, {}, {from: range.from}, {to: range.to}, {from: range.from, to: range.from}, {from: range.to, to: range.to}, {from: '2027-01-01'}]) {
      const bounds = {from: query.from ?? null, to: query.to ?? null};
      const period = entries.filter(e => (!bounds.from || e.date.slice(0, 10) >= bounds.from) && (!bounds.to || e.date.slice(0, 10) <= bounds.to)).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
      assert.deepEqual(await scoped.accountingBalances(bounds), accountBalances(accounts, period));
      const result = await read(scoped, principal, query);
      assert.equal(result.statusCode, 200);
      assert.equal(result.body, JSON.stringify({data: {...bounds, ...departmentalStatement(accounts, period)}}));
    }
    assert.equal((await read(repositories.forTenant('B'), other)).body, JSON.stringify({data: {from: null, to: null, ...empty}}));
    assert.equal((await read(scoped, principal, {from: '2027-01-01'})).body, JSON.stringify({data: {from: '2027-01-01', to: null, ...empty}}));
  }
  assert.ok(pages > 20);
  for (const record of [accounts[0], entries[0]]) {
    const corrupt = new DynamoRepositories('offline', {send: async (command: InstanceType<typeof QueryCommand>) => ({Items: command.input.ExpressionAttributeValues![':prefix'] === 'GL-ACCOUNT#' ? accounts.map(data => ({data: record.kind === 'gl-account' ? {...data, tenantId: 'B'} : data})) : [{data: {...record, tenantId: 'B'}}]})} as any);
    await assert.rejects(read(corrupt.forTenant('A')), /scope/);
  }
  // Warm departmental reads must reflect the next successful journal write.
  const before = JSON.parse((await read(repo)).body).data.totals;
  await repo.crmWrite([write(entry('new', '2026-10-22', [['4500', 0, 123], ['1000', 123, 0]]), principal)]);
  assert.deepEqual(JSON.parse((await read(repo)).body).data.totals, {income: before.income + 123, expenses: before.expenses, grossProfit: before.grossProfit + 123});
});
